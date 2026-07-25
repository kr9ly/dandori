/**
 * check-docs.ts の CLI 境界に対する回帰テスト。
 *
 * テストの単位は **CLI の外部挙動**（引数 → exit code + 出力の指摘 ID 集合 +
 * 機械可読行）に固定してある。内部関数を直接叩かないのは、このスクリプトが
 * モードごとの分割を控えているため — 分割で壊れるテストは分割の安全網にならない。
 *
 * 期待値は「fixture が踏むべき指摘 ID と件数」を先に宣言する形で書く。実行結果から
 * 生成した期待値は実装の現状を追認するだけのオラクルになり、誤検出を固定してしまう。
 *
 * 実行: node --test tests/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dirname
const CHECKER = join(HERE, '..', 'skills', 'dandori', 'scripts', 'check-docs.ts')
const FIX = join(HERE, 'fixtures')

/** チェッカーを起動して exit code と出力を取る（exit 1/2 でも throw させない） */
function run(...args) {
  try {
    const out = execFileSync('node', [CHECKER, ...args], { encoding: 'utf8' })
    return { code: 0, out }
  } catch (e) {
    if (typeof e.status !== 'number') throw e
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

/** `## L1:行形式（3 件）` 形式の見出しから { L1: 3 } を作る（文言変更に強い形） */
function findings(out) {
  const found = {}
  for (const m of out.matchAll(/^## ([A-Z]+\d+):[^（]*（(\d+) 件）/gm)) {
    found[m[1]] = Number(m[2])
  }
  return found
}

/** `[verdict] R=passed` 行を集める */
function verdicts(out) {
  return [...out.matchAll(/^\[verdict\] (\w+=\w+)$/gm)].map(m => m[1])
}

/** 書き込みモードのテスト用に fixture を一時ディレクトリへ複製する */
function scratch(relPath) {
  const dir = mkdtempSync(join(tmpdir(), 'dandori-test-'))
  const dst = join(dir, relPath.split('/').pop())
  copyFileSync(join(FIX, relPath), dst)
  return dst
}

// ---------------------------------------------------------------------------
// ledger モード — 形式検査（L1〜L6）と収束判定は独立。判定は exit code に影響しない
// ---------------------------------------------------------------------------

const LEDGER_CASES = [
  {
    name: '最新ラウンドの生存ゼロ → passed（指摘なしマーカーのラウンドを最新として読む）',
    fixture: 'ledger/verdict-passed.md',
    code: 0,
    findings: {},
    verdicts: ['R=passed'],
  },
  {
    name: '全件反証破棄 → 生存ゼロとして passed（反証破棄は生存数から除外）',
    fixture: 'ledger/verdict-passed-refuted.md',
    code: 0,
    findings: {},
    verdicts: ['C=passed'],
  },
  {
    name: '未解消の再燃 → escalated。ただし形式は健全なので exit 0',
    fixture: 'ledger/verdict-escalated-reflare.md',
    code: 0,
    findings: {},
    verdicts: ['C=escalated'],
  },
  {
    name: 'L2 — 未処置 / 理由なし却下 / blocker への保留',
    fixture: 'ledger/lint-unprocessed.md',
    code: 1,
    findings: { L2: 3 },
    verdicts: ['C=continue'],
  },
  {
    name: 'L1 — 深刻度語彙外 / Rd 非数値 / ID 形式違反',
    fixture: 'ledger/lint-vocab.md',
    code: 1,
    findings: { L1: 3 },
  },
  {
    name: 'L3 + L4 — 再燃の参照切れと ID 欠番',
    fixture: 'ledger/lint-dangling-and-gap.md',
    code: 1,
    findings: { L3: 1, L4: 1 },
    verdicts: ['R=escalated'],
  },
]

for (const c of LEDGER_CASES) {
  test(`ledger: ${c.name}`, () => {
    const r = run('ledger', join(FIX, c.fixture))
    assert.equal(r.code, c.code, `exit code — 出力:\n${r.out}`)
    assert.deepEqual(findings(r.out), c.findings, `指摘 ID — 出力:\n${r.out}`)
    if (c.verdicts) assert.deepEqual(verdicts(r.out), c.verdicts, `verdict — 出力:\n${r.out}`)
  })
}

test('ledger: --mark-zero-round auto は行の最大 Rd の次にマーカーを打ち、その場で passed を出す', () => {
  // 工程側のローカルな数え上げを渡すと台帳の Rd 系列と食い違うマーカーが打たれ、
  // 収束済みなのに escalated になる（2026-07-25 実戦観測）— auto が正しい渡し方
  const path = scratch('ledger/marker-auto-src.md')
  const r = run('ledger', path, '--mark-zero-round', 'C', 'auto')
  assert.equal(r.code, 0, r.out)
  assert.match(readFileSync(path, 'utf8'), /<!-- round: C Rd=3 指摘なし -->/, r.out)
  // マーカーのラウンドは生存ゼロとして系列に入るので、同一コマンドの判定が passed になる
  assert.deepEqual(verdicts(r.out), ['C=passed'], r.out)
})

test('ledger: --mark-zero-round auto の再実行はラウンドを進めない（マーカー Rd を再利用）', () => {
  // マーカーが行より先の Rd を主張しているなら既にゼロラウンドが記録済み — その Rd を
  // 再利用して冪等スキップに合流する。+1 し続ける実装だと再実行でラウンドが際限なく進む
  const path = scratch('ledger/marker-auto-src.md')
  run('ledger', path, '--mark-zero-round', 'C', 'auto')
  const r2 = run('ledger', path, '--mark-zero-round', 'C', 'auto')
  const markers = readFileSync(path, 'utf8').match(/<!-- round: C Rd=\d+ 指摘なし -->/g) || []
  assert.deepEqual(markers, ['<!-- round: C Rd=3 指摘なし -->'], `マーカーが増えている: ${markers}`)
  assert.match(r2.out, /マーカー既存 — 追記なし/, r2.out)
})

test('ledger: マーカーが既に行より先にある台帳では auto が追記しない', () => {
  // verdict-passed.md は行 Rd1 + マーカー Rd2 の状態（ゼロラウンド記録済み）
  const path = scratch('ledger/verdict-passed.md')
  const r = run('ledger', path, '--mark-zero-round', 'R', 'auto')
  assert.match(r.out, /マーカー既存 — 追記なし: <!-- round: R Rd=2 指摘なし -->/, r.out)
  const markers = readFileSync(path, 'utf8').match(/<!-- round: R Rd=\d+ 指摘なし -->/g) || []
  assert.deepEqual(markers, ['<!-- round: R Rd=2 指摘なし -->'], `マーカーが増えている: ${markers}`)
})

// ---------------------------------------------------------------------------
// ledger-append モード — 行追記（書き込み）。ID 発番の唯一の出所
// ---------------------------------------------------------------------------

const ROWS = JSON.stringify([
  { index: 0, severity: 'major', topic: '新しい論点', action: '', reason: 'src/x.ts:1' },
  { index: 1, severity: 'minor', topic: '軽微な論点', action: '保留', reason: 'src/y.ts:2' },
])

test('ledger-append: 既存 ID の続きから発番し、[appended] 行で ID を返す', () => {
  // fixture は R-1..R-3 → 続きは R-4, R-5
  const path = scratch('ledger/verdict-passed.md')
  const r = run('ledger-append', path, '--prefix', 'R', '--rd', '3', '--rows', ROWS)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^\[appended\] index=0 id=R-4 status=new$/m, r.out)
  assert.match(r.out, /^\[appended\] index=1 id=R-5 status=new$/m, r.out)
})

test('ledger-append: 同一 Rd の同一論点は追記されない（冪等 — 二重実行で行が増えない）', () => {
  const path = scratch('ledger/verdict-passed.md')
  run('ledger-append', path, '--prefix', 'R', '--rd', '3', '--rows', ROWS)
  const rows1 = (readFileSync(path, 'utf8').match(/^\| R-\d+ \|/gm) || []).length
  const r2 = run('ledger-append', path, '--prefix', 'R', '--rd', '3', '--rows', ROWS)
  const rows2 = (readFileSync(path, 'utf8').match(/^\| R-\d+ \|/gm) || []).length
  assert.equal(rows2, rows1, '二重実行で行が増えている')
  assert.match(r2.out, /^\[appended\] index=0 id=R-4 status=existing$/m, r2.out)
})

// ---------------------------------------------------------------------------
// spec モード — 正準フォーマット lint（S1〜S8）
// ---------------------------------------------------------------------------

const SPEC_CASES = [
  {
    name: '正準形式（削除済み B 行つき）は指摘ゼロ',
    args: ['spec/green.md'],
    code: 0,
    findings: {},
  },
  {
    name: 'S1 + S2 + S6 — 必須セクション欠落 / 同名セクション重複 / 振る舞い仕様セクション外の B 行',
    args: ['spec/red-sections.md'],
    code: 1,
    findings: { S1: 2, S2: 1, S6: 1 },
  },
  {
    name: 'S3 + S4 — B 行フィールド欠落 / ゲートタグ語彙外・乖離マークの注記欠落',
    args: ['spec/red-fields.md'],
    code: 1,
    findings: { S3: 2, S4: 2 },
  },
  {
    name: 'S5 + S7 — B-ID 重複 / 欠番（無断削除の兆候）',
    args: ['spec/red-ids.md'],
    code: 1,
    findings: { S5: 1, S7: 2 },
  },
  {
    name: 'S8 — 改番検知（タイトルすり替え / 取り消し線なし削除 / 末尾以外への挿入）',
    args: ['spec/red-renumber.md', '--baseline', 'spec/green.md'],
    code: 1,
    findings: { S7: 1, S8: 3 },
  },
]

for (const c of SPEC_CASES) {
  test(`spec: ${c.name}`, () => {
    const args = c.args.map(a => (a.startsWith('--') ? a : (a.includes('/') ? join(FIX, a) : a)))
    const r = run('spec', ...args)
    assert.equal(r.code, c.code, `exit code — 出力:\n${r.out}`)
    assert.deepEqual(findings(r.out), c.findings, `指摘 ID — 出力:\n${r.out}`)
  })
}

test('spec: 固定単位の乖離マークは指摘ではなく別枠で列挙される（exit code に影響しない）', () => {
  // 乖離行（e2e→unit）は ground の seam 議題リストであって形式違反ではない。
  // 指摘に混ぜると「直すべきもの」に見え、seam 設計の議題が埋まる
  const r = run('spec', join(FIX, 'spec/red-fields.md'))
  assert.match(r.out, /^## 固定単位の乖離（1 件 — 指摘ではない/m, r.out)
  assert.equal(findings(r.out).乖離, undefined)
})

test('ledger-append: 追記した台帳が ledger モードの形式検査を通る', () => {
  // 追記結果が自分の形式検査に落ちるなら、発番側と検査側の規約が食い違っている
  const path = scratch('ledger/verdict-passed.md')
  run('ledger-append', path, '--prefix', 'R', '--rd', '3', '--rows', ROWS)
  const r = run('ledger', path)
  // major の新規行は処置が空（反証・反映フェーズが埋める）ため L2 が 1 件出るのが正
  assert.deepEqual(findings(r.out), { L2: 1 }, r.out)
})
