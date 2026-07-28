/**
 * dandori-docs.ts の CLI 境界に対する回帰テスト。
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
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const HERE = import.meta.dirname
const CHECKER = join(HERE, '..', 'skills', 'dandori', 'scripts', 'dandori-docs.ts')
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
// CLI の外枠 — モード解決と引数不足の報告
//
// モード分割（2026-07-25）で各モードから共有定数 USAGE が見えなくなり、引数不足時に
// ReferenceError で落ちる回帰が出た。当時のテストは正常系と検査対象の異常系しか
// 覆っておらず、この経路を通っていなかった — 分割の安全網として引数の入口も固定する
// ---------------------------------------------------------------------------

const ALL_MODES = ['spec', 'plan', 'design', 'outline', 'trace', 'ledger', 'ledger-append', 'ledger-update', 'map', 'state', 'residue']

test('cli: モード名なし / 未知のモードは usage を出して exit 2', () => {
  for (const args of [[], ['unknown-mode']]) {
    const r = run(...args)
    assert.equal(r.code, 2, `args=${JSON.stringify(args)} の exit code — 出力:\n${r.out}`)
    assert.match(r.out, /^usage: node dandori-docs\.ts /, r.out)
  }
})

for (const mode of ALL_MODES) {
  test(`cli: ${mode} — 引数不足は exit 2 で報告する（クラッシュしない）`, () => {
    const r = run(mode)
    assert.equal(r.code, 2, `exit code — 出力:\n${r.out}`)
    assert.doesNotMatch(r.out, /ReferenceError|TypeError|Cannot find module/, `クラッシュしている:\n${r.out}`)
  })
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
// ledger-update モード — 処置セルの更新（書き込み）。語彙・参照整合の強制が本体
// ---------------------------------------------------------------------------

test('ledger-update: 処置と理由を更新し、[updated] 行を返す（冪等 — 同値の再実行は unchanged）', () => {
  const path = scratch('ledger/verdict-passed.md')
  const rows = JSON.stringify([{ id: 'R-3', action: '反映済', reason: '裁定で採用 — 表現を修正' }])
  const r = run('ledger-update', path, '--rows', rows)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^\[updated\] id=R-3 status=changed$/m, r.out)
  assert.match(readFileSync(path, 'utf8'), /^\| R-3 \| 1 \| minor \| .+ \| 反映済 \| 裁定で採用 — 表現を修正 \|$/m)
  const before = readFileSync(path, 'utf8')
  const r2 = run('ledger-update', path, '--rows', rows)
  assert.equal(r2.code, 0, r2.out)
  assert.match(r2.out, /^\[updated\] id=R-3 status=unchanged$/m, r2.out)
  assert.equal(readFileSync(path, 'utf8'), before, '冪等な再実行でファイルが変わっている')
})

test('ledger-update: 語彙外の処置（「反映済み」の揺れ）と実在しない ID は exit 2 で何も書かない', () => {
  // 第 5 波実測: scribe の語彙揺れ「反映済み」が台帳に入り escalated を誘発 — 入口で弾く
  const path = scratch('ledger/verdict-passed.md')
  const before = readFileSync(path, 'utf8')
  for (const rows of [
    [{ id: 'R-1', action: '反映済み' }],
    [{ id: 'R-99', action: '反映済' }],
    [{ id: 'R-1', action: '却下' }], // 却下は理由必須
  ]) {
    const r = run('ledger-update', path, '--rows', JSON.stringify(rows))
    assert.equal(r.code, 2, `rows=${JSON.stringify(rows)} — 出力:\n${r.out}`)
  }
  assert.equal(readFileSync(path, 'utf8'), before, '拒否したのにファイルが変わっている')
})

test('ledger-update: 同一 Rd の行への 再燃→ は拒否（dup_in_round の誤記）、前ラウンドへは通る', () => {
  const path = scratch('ledger/verdict-passed.md')
  // R-1 と R-2 は同じ Rd1 — 同一ラウンド内の重複は再燃ではない（第 5 波実測の誤用形）
  const bad = run('ledger-update', path, '--rows', JSON.stringify([{ id: 'R-2', action: '再燃→R-1' }]))
  assert.equal(bad.code, 2, bad.out)
  // Rd3 に行を足してから前ラウンド（Rd1）の R-1 への再燃 — これは正当
  run('ledger-append', path, '--prefix', 'R', '--rd', '3', '--rows', ROWS)
  const good = run('ledger-update', path, '--rows', JSON.stringify([{ id: 'R-4', action: '再燃→R-1' }]))
  assert.equal(good.code, 0, good.out)
  assert.match(good.out, /^\[updated\] id=R-4 status=changed$/m, good.out)
})

test('ledger-update: 反証破棄で確定した行の上書きは拒否（反証済み確定の巻き戻し禁止）', () => {
  const path = scratch('ledger/verdict-passed.md')
  const r1 = run('ledger-update', path, '--rows', JSON.stringify([{ id: 'R-1', action: '反証破棄', reason: '実測で到達不能を確認' }]))
  assert.equal(r1.code, 0, r1.out)
  const r2 = run('ledger-update', path, '--rows', JSON.stringify([{ id: 'R-1', action: '反映済' }]))
  assert.equal(r2.code, 2, r2.out)
})

test('ledger-update: 更新後の台帳が ledger モードの形式検査を通る', () => {
  const path = scratch('ledger/verdict-passed.md')
  run('ledger-update', path, '--rows', JSON.stringify([{ id: 'R-3', action: '反映済', reason: '裁定で採用' }]))
  const r = run('ledger', path)
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(findings(r.out), {}, r.out)
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

// ---------------------------------------------------------------------------
// state モード — state.yaml の整合検査（Y1〜Y4）。ルーターの再開判定の足場
// ---------------------------------------------------------------------------

const STATE_CASES = [
  {
    name: 'フルコースの整合した state は指摘ゼロ',
    fixture: 'state/full-feature/state.yaml',
    code: 0,
    findings: {},
  },
  {
    name: 'Y1 — course / phase / status の語彙外、revision の下限、日付形式、未知キー',
    fixture: 'state/red-vocab/state.yaml',
    code: 1,
    findings: { Y1: 6, Y3: 1 },
  },
  {
    name: 'Y2 — feature がフィーチャーディレクトリ名と一致しない',
    fixture: 'state/red-mismatch/state.yaml',
    code: 1,
    findings: { Y2: 1 },
  },
  {
    name: 'Y3 — annotate が gate 未通過 / 短縮コースに無い工程 / 完了済み impl のカウンタ不整合',
    fixture: 'state/red-phase/state.yaml',
    code: 1,
    findings: { Y3: 3, Y4: 1 },
  },
  {
    name: 'Y4 — 完了済みフェーズが前提とする成果物の欠落',
    fixture: 'state/red-artifacts/state.yaml',
    code: 1,
    findings: { Y4: 3 },
  },
  {
    // outline は短縮コースに存在しない工程。status 語彙は sketch / spike と同型で、
    // skipped でない完了は成果物（outline.md）を要求する
    name: 'Y1/Y3/Y4 — outline: 語彙外 status / 短縮コースに outline / 成果物欠落',
    fixture: 'state/red-outline/state.yaml',
    code: 1,
    findings: { Y1: 1, Y3: 2, Y4: 1 },
  },
]

for (const c of STATE_CASES) {
  test(`state: ${c.name}`, () => {
    const r = run('state', join(FIX, c.fixture))
    assert.equal(r.code, c.code, `exit code — 出力:\n${r.out}`)
    assert.deepEqual(findings(r.out), c.findings, `指摘 ID — 出力:\n${r.out}`)
  })
}

// ---------------------------------------------------------------------------
// trace モード — B-ID ↔ テストコードの機械突合（T1〜T4）
// ---------------------------------------------------------------------------

test('trace: T1〜T4 — 対応テストなし / 幽霊 B-ID / 削除済み参照 / skip されたテスト', () => {
  const r = run('trace', join(FIX, 'spec/green.md'), join(FIX, 'trace/src'))
  assert.equal(r.code, 1, r.out)
  assert.deepEqual(findings(r.out), { T1: 1, T2: 1, T3: 1, T4: 1 }, r.out)
})

test('trace: 数値開始でないトークン（B-ORDER）は B-ID 参照として扱わない', () => {
  // フィクスチャ文字列の B-ORDER を幽霊 B-ID と誤検出すると、幽霊の指摘がノイズで埋まる
  const r = run('trace', join(FIX, 'spec/green.md'), join(FIX, 'trace/src'))
  assert.doesNotMatch(r.out, /B-ORDER/, r.out)
})

test('trace: --revision で旧 B 行は回帰扱いになり、改訂行だけがフルトレース対象になる', () => {
  // strip 済みの改訂サイクルでは旧 B 行の B-ID がテスト名にないため、機械突合が効くのは
  // 今回の revision の行だけ。旧行に T1 を出すと未検証の山で本命が埋まる
  const r = run('trace', join(FIX, 'spec/green-rev2.md'), join(FIX, 'trace/src'), '--revision', '2')
  assert.match(r.out, /^\| B-3 \| e2e \| ✅ 回帰 \|/m, r.out)
  assert.match(r.out, /^\| B-5 \| unit \| ⚠️ 未検証候補 \|/m, r.out)
  assert.equal(findings(r.out).T1, 1, `旧行に T1 が出ている:\n${r.out}`)
})

// ---------------------------------------------------------------------------
// residue モード — strip の受け入れテスト（RS1〜RS3）
// ---------------------------------------------------------------------------

test('residue: RS1〜RS3 — B-ID トークン / dandori 言及 / プロセス語彙（指摘 ID・工程ドキュメント参照）', () => {
  const r = run('residue', join(FIX, 'residue/dirty'))
  assert.equal(r.code, 1, r.out)
  assert.deepEqual(findings(r.out), { RS1: 2, RS2: 2, RS3: 4 }, r.out)
})

test('residue: strip 済みのコードは指摘ゼロ（dandori-ok の機能的依存は除外される）', () => {
  const r = run('residue', join(FIX, 'residue/clean'))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /dandori-ok 除外 2 行/, r.out)
})

test('residue: RS3 拡充 — ハイフンなしレビュー ID + severity 語 / severity 番号 / 裁定番号（第 5 波 strip 漏れの実測形）', () => {
  // V8 major 等の「RCF 以外 + severity 語」は誤検出しない（fixture に負例を含む）
  const r = run('residue', join(FIX, 'residue/wave5'))
  assert.equal(r.code, 1, r.out)
  assert.deepEqual(findings(r.out), { RS3: 3 }, r.out)
})

test('residue: dandori-ok の除外範囲はマーカー行と直後 1 行だけ', () => {
  // 2 行以上に及ぶ参照は各行にマーカーが必要 — 範囲を広く取ると剥がし漏れが黙って通る
  const r = run('residue', join(FIX, 'residue/marker-scope'))
  assert.deepEqual(findings(r.out), { RS2: 1 }, r.out)
  assert.match(r.out, /loader\.ts:3/, `除外範囲の外の行が検出されていない:\n${r.out}`)
})

// ---------------------------------------------------------------------------
// plan モード — spec ↔ plan の B 行カバレッジ突合（P1〜P4）
// ---------------------------------------------------------------------------

test('plan: 全 B 行がカバーされたプランは指摘ゼロ（削除済み B 行はカバー対象外）', () => {
  const r = run('plan', join(FIX, 'spec/green.md'), join(FIX, 'plan/green.md'))
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(findings(r.out), {}, r.out)
})

test('plan: P1〜P4 — 未カバー B 行 / 幽霊参照 / 削除済み参照 / 空マイルストーン', () => {
  // P1 は「実装されない仕様」の機械検出 — カバー漏れが gate まで生き残るのが最悪の経路
  const r = run('plan', join(FIX, 'spec/green.md'), join(FIX, 'plan/red.md'))
  assert.equal(r.code, 1, r.out)
  assert.deepEqual(findings(r.out), { P1: 2, P2: 1, P3: 1, P4: 1 }, r.out)
})

// ---------------------------------------------------------------------------
// design モード — design.md の形式検査と spec との B 行対応突合（D1〜D5）
// ---------------------------------------------------------------------------

test('design: 正準形式の design は指摘ゼロ', () => {
  const r = run('design', join(FIX, 'spec/green.md'), join(FIX, 'design/green.md'))
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(findings(r.out), {}, r.out)
})

test('design: D1〜D4 — 必須セクション / 検証マークと証拠形式 / B 行参照整合 / 未対応 B 行', () => {
  // D2 の「[実行検証済] に再実行可能な証拠がない」は ground の教義の機械化 —
  // マークだけの主張は検証の主張であって証拠ではない
  const r = run('design', join(FIX, 'spec/green.md'), join(FIX, 'design/red.md'))
  assert.equal(r.code, 1, r.out)
  assert.deepEqual(findings(r.out), { D1: 1, D2: 2, D3: 2, D4: 2 }, r.out)
})

test('design: D5 — 軸キーの typo と理由なし [散在]（状態モデルつき spec のみ）', () => {
  const r = run('design', join(FIX, 'spec/green-model.md'), join(FIX, 'design/red-axes.md'))
  assert.equal(r.code, 1, r.out)
  assert.deepEqual(findings(r.out), { D5: 2 }, r.out)
})

test('design: D5 — 状態モデルがあるのに軸対応節がない design を検出する', () => {
  const r = run('design', join(FIX, 'spec/green-model.md'), join(FIX, 'design/green.md'))
  assert.deepEqual(findings(r.out), { D5: 1 }, r.out)
})

test('design: 状態モデルのない spec では軸対応節を要求しない', () => {
  // D5 を無条件に要求すると、状態モデルを使わないプロジェクトで常に赤になる
  const r = run('design', join(FIX, 'spec/green.md'), join(FIX, 'design/green.md'))
  assert.equal(findings(r.out).D5, undefined, r.out)
})

// ---------------------------------------------------------------------------
// outline モード — プログラム設計ドキュメントの形式検査（O1〜O4）
//
// この工程が扱うのは機械検査に原理的に載らない軸なので、検査は意図的に薄い。
// 「B 行の網羅を検査しないこと」自体が仕様なので、それも固定する
// ---------------------------------------------------------------------------

const OUTLINE_SPEC = join(FIX, 'spec/green.md')
const OUTLINE_DESIGN = join(FIX, 'design/green.md')

test('outline: 正準形式の outline は指摘ゼロ', () => {
  const r = run('outline', OUTLINE_SPEC, OUTLINE_DESIGN, join(FIX, 'outline/green.md'))
  assert.equal(r.code, 0, `指摘ゼロのはず — 出力:\n${r.out}`)
})

test('outline: O1 / O2 / O4 — 必須節欠落・未裁定の論点・幽霊/削除済み B 行注記', () => {
  // fixture が踏むべき指摘: 擬似コード節なし ×1 /
  // 裁定が空「」と「未」×2 / B-9（幽霊）と B-4（削除済み）×2
  const expected = { O1: 1, O2: 2, O4: 2 }
  const r = run('outline', OUTLINE_SPEC, OUTLINE_DESIGN, join(FIX, 'outline/red.md'))
  assert.equal(r.code, 1, `出力:\n${r.out}`)
  assert.deepEqual(findings(r.out), expected, r.out)
})

test('outline: O3 — design に新規実装があるのに新規ファイルが1件もない', () => {
  const r = run('outline', OUTLINE_SPEC, OUTLINE_DESIGN, join(FIX, 'outline/red-placement.md'))
  assert.equal(r.code, 1, `出力:\n${r.out}`)
  assert.deepEqual(findings(r.out), { O3: 1 }, r.out)
})

test('outline: B 行の網羅は検査しない（記載ゼロでも緑）', () => {
  // 仕様: B 行のカバレッジ突合は plan モードの管轄。ここに持ち込むと裁定の議題が
  // インターフェースの良し悪しから「抜けている仕様はないか」へ流れる。
  // green.md は B-1..B-3 を1つも参照しないが、それは指摘にならない
  const outline = readFileSync(join(FIX, 'outline/green.md'), 'utf8')
  assert.ok(!/B-\d/.test(outline), 'fixture の前提が壊れている — green.md に B 行注記があってはならない')
  const r = run('outline', OUTLINE_SPEC, OUTLINE_DESIGN, join(FIX, 'outline/green.md'))
  assert.equal(r.code, 0, `B 行未記載を指摘してはならない — 出力:\n${r.out}`)
})

// ---------------------------------------------------------------------------
// map モード — survey verify の証拠アンカー死活検査（V1〜V5）
// ---------------------------------------------------------------------------

test('map: V1 — generated-at ヘッダの欠落', () => {
  const r = run('map', join(FIX, 'map/red-no-header.md'))
  assert.equal(r.code, 1, r.out)
  assert.deepEqual(findings(r.out), { V1: 1 }, r.out)
})

test('map: V1 + V2 + V4 + V5 — 解決不能な hash / アンカー先の消滅・行範囲外・シンボルなし / 根拠なし / 等級なし', () => {
  // 有効なシンボルアンカー（confirmOrder）と「未確認」明記の主張は指摘に上げない
  const r = run('map', join(FIX, 'map/red-anchors.md'))
  assert.equal(r.code, 1, r.out)
  assert.deepEqual(findings(r.out), { V1: 1, V2: 3, V4: 1, V5: 2 }, r.out)
})

test('map: V3 — generated-at 以降に変更されたアンカー先だけを再検証候補に挙げる', () => {
  // 一時 git リポジトリを組んで決定的に検証する（このリポジトリの履歴に依存させない）。
  // 「アンカー先が変わった = 腐った」ではないので、V3 は再検証候補として挙がるのが正
  const repo = mkdtempSync(join(tmpdir(), 'dandori-map-'))
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
  const write = (rel, body) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), body)
  }
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  write('src/order.ts', "export const status = 'draft'\n")
  write('src/stock.ts', 'export const stock = 0\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD').trim()
  write('.dandori/map/states.md', [
    '# 状態',
    '',
    `<!-- generated-at: ${base} / 2026-07-25 -->`,
    '',
    '## 状態一覧',
    '- 注文の初期状態は draft — 根拠: `src/order.ts:1` [読解のみ]',
    '- 在庫の初期値は 0 — 根拠: `src/stock.ts:1` [読解のみ]',
    '',
  ].join('\n'))
  git('add', '-A')
  git('commit', '-qm', 'map')
  const mapPath = join(repo, '.dandori/map/states.md')

  // アンカー先が無変更なら指摘ゼロ
  const before = run('map', mapPath)
  assert.equal(before.code, 0, before.out)

  // order.ts だけを変更 → その主張だけが V3 に挙がる（stock.ts の主張は挙がらない）
  write('src/order.ts', "export const status = 'confirmed'\n")
  git('commit', '-qam', 'change order')
  const after = run('map', mapPath)
  assert.deepEqual(findings(after.out), { V3: 1 }, after.out)
  assert.match(after.out, /src\/order\.ts:1/, after.out)
  assert.doesNotMatch(after.out, /src\/stock\.ts/, `無変更のアンカーが挙がっている:\n${after.out}`)

  // --root は map の所在から離れた場所から検査するための明示指定（worktree 並列レーン）
  const rooted = run('map', mapPath, '--root', repo)
  assert.deepEqual(findings(rooted.out), { V3: 1 }, rooted.out)
})

test('ledger-append: 追記した台帳が ledger モードの形式検査を通る', () => {
  // 追記結果が自分の形式検査に落ちるなら、発番側と検査側の規約が食い違っている
  const path = scratch('ledger/verdict-passed.md')
  run('ledger-append', path, '--prefix', 'R', '--rd', '3', '--rows', ROWS)
  const r = run('ledger', path)
  // major の新規行は処置が空（反証・反映フェーズが埋める）ため L2 が 1 件出るのが正
  assert.deepEqual(findings(r.out), { L2: 1 }, r.out)
})
