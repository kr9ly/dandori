/**
 * dandori 正準ドキュメントの横断チェッカー。
 *
 * spec.md / plan.md の正準フォーマット（各 SKILL.md の「正準定義」）間の
 * ID 突合と形式検査を機械化する。状態モデル・状態マップの検査は
 * check-state-model.ts の管轄（このチェッカーは重複しない）。
 *
 * spec モード — spec.md の正準フォーマット lint:
 *   S1. 必須セクション欠落 — ゴール / スコープ外 / 振る舞い仕様 / 未解決事項
 *   S2. セクション重複 — 同名の ## セクションが複数（逐次追記の事故検出）
 *   S3. B 行フィールド欠落 — Given / When / Then / Gate が揃っているか
 *   S4. Gate タグ語彙 — unit / e2e / visual / manual / formal 以外の混入
 *   S5. B-ID 重複
 *   S6. B 行の位置 — 「## 振る舞い仕様」セクション外の B 行見出し
 *   S7. 欠番 — 純数値 ID（B-1 形式）の連番の穴（削除は取り消し線で残す規約のため、
 *       穴は無断削除の兆候）
 *   S8. 改番検知（--baseline 指定時のみ）— fix 済み spec との比較:
 *       同一 ID のタイトル変更（すり替え疑い）/ 取り消し線なしの削除 /
 *       末尾以外への挿入（追加は末尾の規約違反）
 *
 * plan モード — spec.md ↔ plan.md の B 行カバレッジ突合:
 *   P1. 未カバー B 行 — spec の B 行がどのマイルストーンにも割り当てられていない
 *       （= 実装されない仕様）
 *   P2. 幽霊参照 — plan が参照する B-ID が spec に存在しない（typo か spec の陳腐化）
 *   P3. 削除済み参照 — 取り消し線つき B 行への参照
 *   P4. 空マイルストーン — 対応 B 行がゼロのマイルストーン（スコープ外の作業）
 *
 * design モード — design.md の形式検査と spec.md との B 行対応突合:
 *   D1. 必須セクション欠落 — 土台 / 改変箇所 / 新規実装 / 不変条件 /
 *       リスクランキング / 発見ログ（見出しの（）補足は無視して前方一致）
 *   D2. 検証マーク — 土台の各エントリに [実行検証済] / [読解のみ] が付いているか。
 *       [実行検証済] は再実行可能な証拠形式（バッククォートのコマンド併記）を要求
 *   D3. B 行参照整合 — 土台/改変箇所/新規実装が参照する B-ID の幽霊・削除済み検出
 *   D4. 未対応 B 行 — spec の B 行が土台/改変/新規のどこにも対応しない
 *       （spec か調査のどちらかに穴 — ground の完了条件）
 *
 * ledger モード — review-ledger.md の形式検査と収束判定:
 *   台帳（dandori-review / dandori-codereview 共用）をパースし、接頭辞ごと
 *   （R-n = review / C-n = codereview — ラウンド系列が別）に収束状態を機械判定する。
 *   L1. 行形式 — ID 形式（R-n/C-n）/ Rd 数値 / 深刻度語彙（blocker/major/minor）/
 *       処置語彙（反映済・却下・保留・反証破棄・再燃→<ID>・空 = 未処置）
 *   L2. 処置の完全性 — 未処置の行 / 理由なしの却下・反証破棄 /
 *       blocker・major への保留（保留は minor のみ）/ 反証破棄の R-n 行（codereview 専用語彙）
 *   L3. 再燃参照 — 再燃→<ID> の参照先が台帳にない
 *   L4. ID 重複・欠番（台帳は追記のみ — 欠番は行の削除の疑い）
 *   収束判定（指摘とは別枠 — exit code に影響しない）:
 *     passed = 最新ラウンドの blocker+major がゼロ（C-n は反証破棄を生存数から除外）
 *     escalated = 再燃→ がある（参照先が反証破棄の行は除く — 反証済みの再生産）、
 *                 または 3 ラウンド以上連続で blocker+major 件数が減っていない
 *     継続 = どちらでもない
 *
 * state モード — state.yaml の整合検査（ルーターの再開判定の足場）:
 *   Y1. 語彙・形式 — course / phase / 各工程 status の語彙、数値フィールド、
 *       updated の日付形式、未知のキー
 *   Y2. feature 一致 — feature がフィーチャーディレクトリ名と一致するか
 *   Y3. フェーズ整合 — phase が phases_done と矛盾しない / 短縮コースに存在しない
 *       工程が記録されていない / 完了済み工程の status・カウンタが完了状態か
 *       （例: phases_done に impl があるのに milestones_done < total）
 *   Y4. 成果物整合 — フェーズが前提とするドキュメント（spec.md / design.md / plan.md /
 *       review-ledger.md）の存在。phase: done では逆に使い捨てドキュメントの処分漏れを
 *       検出する（アーカイブ方針で意図的に残す場合は無視してよい）
 *
 * map モード — survey 成果物（.dandori/map/*.md）の証拠アンカー死活検査:
 *   dandori-survey verify の手順 1〜2（hash 比較 → 変更ファイル取得 → アンカー走査）を
 *   機械化する。腐った主張の裁定・修正は verify 工程（ユーザー裁定）に残る。
 *   検査対象アンカー: 散文の「根拠: `パス`」と、dandori-state-map ブロックの anchor: 値
 *   V1. generated-at — ヘッダ欠落 / hash が git に存在しない（rebase 等で消失）
 *   V2. アンカー先消滅 — ファイル/ディレクトリなし、:行 が EOF 超え、
 *       :シンボル がファイル内に見つからない（確実に腐っている）
 *   V3. アンカー先変更 — generated-at hash..HEAD の変更ファイルに載っている
 *       （要再検証候補 — 主張がまだ真かはコードを読んで裁定する）
 *   V4. アンカーなし主張 — 根拠のない主張は verify で検査できない（「未確認」明記は除く）
 *   V5. 検証等級なし主張 — [実行検証済] / [読解のみ] マークがない
 *
 * trace モード — gate の初期トレース表生成（B-ID ↔ テストコードの機械突合）:
 *   spec の B-ID をテストファイルから grep し、トレース表の叩き台（Markdown）を出力する。
 *   impl の規約（テスト名に B-ID を含める）が前提。表の「状態」は実行前の初期値 —
 *   ゲート工程がテストを再実行して ✅/❌ に更新する。
 *   T1. 対応テストなし — unit / e2e / formal の B 行に B-ID の grep ヒットがない（⚠️ 候補）
 *   T2. 幽霊 B-ID — テストコード中の B-ID が spec に存在しない
 *   T3. 削除済み参照 — 削除済み B 行の B-ID を参照するテスト
 *
 * 実行:
 *   node check-docs.ts spec <spec.md>
 *   node check-docs.ts spec <spec.md> --baseline <旧spec.md>
 *     （fix 済み spec を再編集したとき: git show HEAD:<path> > /tmp/base.md で取り出す）
 *   node check-docs.ts plan <spec.md> <plan.md>
 *   node check-docs.ts design <spec.md> <design.md>
 *   node check-docs.ts trace <spec.md> <テストのディレクトリ|ファイル...>
 *   node check-docs.ts ledger <review-ledger.md>
 *   node check-docs.ts map <mapファイル.md...>（アンカーは map の git リポジトリルート相対）
 *   node check-docs.ts state <state.yaml>
 *
 * 終了コード: 0 = 全検査グリーン / 1 = 指摘あり / 2 = パース・形式エラー
 */

// 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
const { readFileSync, readdirSync, statSync } = await import('node:fs') as {
  readFileSync(path: string, enc: string): string
  readdirSync(path: string): string[]
  statSync(path: string): { isDirectory(): boolean; size: number }
}
// @ts-ignore -- 同上
const { join, dirname, resolve } = await import('node:path') as {
  join(...p: string[]): string
  dirname(p: string): string
  resolve(...p: string[]): string
}
// @ts-ignore -- 同上
const { execFileSync } = await import('node:child_process') as {
  execFileSync(cmd: string, args: string[], opts: { cwd: string; encoding: string; stdio: unknown[] }): string
}

// ---- 共通 ----------------------------------------------------------------------

let hardErrors = 0
function fail(msg: string): void {
  console.error(`[doc-error] ${msg}`)
  hardErrors++
}

function readLines(path: string, what: string): string[] {
  try {
    return readFileSync(path, 'utf-8').split('\n')
  } catch {
    console.error(`${what}を読めない: ${path}`)
    process.exit(2)
  }
}

interface Finding { check: string; detail: string }
const findings: Finding[] = []

function printGroupedFindings(list: Finding[]): void {
  const byCheck = new Map<string, Finding[]>()
  for (const f of list) {
    if (!byCheck.has(f.check)) byCheck.set(f.check, [])
    byCheck.get(f.check)!.push(f)
  }
  for (const [check, group] of [...byCheck.entries()].sort()) {
    console.log(`## ${check}（${group.length} 件）`)
    for (const f of group) console.log(`- ${f.detail}`)
    console.log('')
  }
}

function finishReport(): never {
  if (hardErrors > 0) {
    console.error(`形式エラー ${hardErrors} 件 — 検査結果は不完全`)
    process.exit(2)
  }
  if (findings.length === 0) {
    console.log('指摘なし — 全検査グリーン')
    process.exit(0)
  }
  printGroupedFindings(findings)
  console.log(`計 ${findings.length} 件`)
  process.exit(1)
}

// ---- spec.md パース -------------------------------------------------------------

interface SpecB {
  id: string
  title: string
  line: number
  /** 取り消し線つき（削除済み B 行） */
  struck: boolean
  /** B 行ブロック内に存在するフィールド名（Given/When/Then/Gate/Covers） */
  fields: Set<string>
  gateRaw: string | null
  /** この B 行が属する ## セクション名 */
  section: string | null
}

interface Section { name: string; line: number }

interface ParsedSpec { sections: Section[]; bs: SpecB[] }

/** `B-1〜B-4` 形式の範囲見出しを個別 ID に展開する（純数値のみ）。非範囲はそのまま */
function expandRange(idToken: string): string[] {
  const m = idToken.match(/^B-(\d+)〜B-(\d+)$/)
  if (!m) return [idToken]
  const from = Number(m[1]), to = Number(m[2])
  if (from >= to) { fail(`範囲 ID の順序が不正: ${idToken}`); return [idToken] }
  return Array.from({ length: to - from + 1 }, (_, i) => `B-${from + i}`)
}

function parseSpec(lines: string[], path: string): ParsedSpec {
  const sections: Section[] = []
  const bs: SpecB[] = []
  let curSection: string | null = null
  let curB: SpecB | null = null
  let inFence = false
  lines.forEach((line, idx) => {
    if (/^```/.test(line.trim())) { inFence = !inFence; return }
    if (inFence) return
    const sec = line.match(/^##\s+(.+?)\s*$/)
    if (sec) {
      curSection = sec[1].trim()
      sections.push({ name: curSection, line: idx + 1 })
      curB = null
      return
    }
    const heading = line.match(/^#{3,6}\s+(~~\s*)?(B-[\w.()]+(?:〜B-[\w.()]+)?)\s*[:：]\s*(.*)$/)
    if (heading) {
      const title = heading[3].trim()
      curB = {
        id: heading[2],
        title: title.replace(/~~/g, '').trim(),
        line: idx + 1,
        struck: heading[1] !== undefined || title.includes('~~'),
        fields: new Set(),
        gateRaw: null,
        section: curSection,
      }
      bs.push(curB)
      return
    }
    if (/^#{1,6}\s/.test(line)) {
      curB = null
      if (/^#{3,6}\s+(~~\s*)?B-/.test(line)) fail(`${path} L${idx + 1}: B 行見出しとして解釈できない: ${line.trim()}`)
      return
    }
    if (curB) {
      const m = line.match(/^\s*-\s*(Given|When|Then|Gate|Covers)\s*[:：]\s*(.*)$/)
      if (m) {
        curB.fields.add(m[1])
        if (m[1] === 'Gate') curB.gateRaw = m[2].trim()
      }
    }
  })
  if (inFence) fail(`${path}: fenced block が閉じていない`)
  return { sections, bs }
}

// ---- 引数 ------------------------------------------------------------------------

const argvRest = process.argv.slice(2)
const mode = argvRest[0]
const USAGE =
  'usage: node check-docs.ts spec <spec.md> [--baseline <旧spec.md>]\n' +
  '       node check-docs.ts plan <spec.md> <plan.md>\n' +
  '       node check-docs.ts design <spec.md> <design.md>\n' +
  '       node check-docs.ts trace <spec.md> <テストのディレクトリ|ファイル...>\n' +
  '       node check-docs.ts ledger <review-ledger.md>\n' +
  '       node check-docs.ts map <mapファイル.md...>\n' +
  '       node check-docs.ts state <state.yaml>'

const MODES = ['spec', 'plan', 'design', 'trace', 'ledger', 'map', 'state']
if (!MODES.includes(mode)) {
  console.error(USAGE)
  process.exit(2)
}

// ---- spec モード ------------------------------------------------------------------

if (mode === 'spec') {
  let baselinePath: string | null = null
  const paths: string[] = []
  for (let i = 1; i < argvRest.length; i++) {
    const a = argvRest[i]
    if (a === '--baseline') { baselinePath = argvRest[++i] ?? null; continue }
    if (a.startsWith('--')) { console.error(`未知のオプション: ${a}\n${USAGE}`); process.exit(2) }
    paths.push(a)
  }
  if (paths.length !== 1) { console.error(USAGE); process.exit(2) }
  const specPath = paths[0]
  const spec = parseSpec(readLines(specPath, 'spec'), specPath)

  // S1: 必須セクション欠落
  const REQUIRED = ['ゴール', 'スコープ外', '振る舞い仕様', '未解決事項']
  const sectionNames = spec.sections.map(s => s.name)
  for (const name of REQUIRED) {
    if (!sectionNames.includes(name)) {
      findings.push({ check: 'S1:必須セクション欠落', detail: `## ${name} がない（空でも見出しは置く — 正準定義）` })
    }
  }

  // S2: セクション重複
  {
    const seen = new Map<string, number>()
    for (const s of spec.sections) {
      if (seen.has(s.name)) {
        findings.push({
          check: 'S2:セクション重複',
          detail: `## ${s.name} が複数ある（L${seen.get(s.name)} と L${s.line}）— 逐次追記は既存セクションの中身を更新する`,
        })
      } else {
        seen.set(s.name, s.line)
      }
    }
  }

  // S3 / S4: B 行フィールドと Gate タグ語彙（削除済み行は対象外）
  const GATE_VOCAB = new Set(['unit', 'e2e', 'visual', 'manual', 'formal'])
  for (const b of spec.bs.filter(b => !b.struck)) {
    for (const field of ['Given', 'When', 'Then', 'Gate']) {
      if (!b.fields.has(field)) {
        findings.push({ check: 'S3:B行フィールド欠落', detail: `${b.id} (L${b.line}) に ${field} がない` })
      }
    }
    if (b.gateRaw !== null) {
      const tags = b.gateRaw.split(/[,、/\s]+/).filter(t => t !== '')
      if (tags.length === 0) {
        findings.push({ check: 'S4:Gateタグ語彙', detail: `${b.id} (L${b.line}) の Gate が空` })
      }
      for (const t of tags) {
        if (!GATE_VOCAB.has(t)) {
          findings.push({
            check: 'S4:Gateタグ語彙',
            detail: `${b.id} (L${b.line}) の Gate タグ「${t}」は語彙外 — unit / e2e / visual / manual / formal のいずれか`,
          })
        }
      }
    }
  }

  // S5: B-ID 重複（範囲見出しは展開して衝突も見る）
  {
    const seen = new Map<string, number>()
    for (const b of spec.bs) {
      for (const id of expandRange(b.id)) {
        if (seen.has(id)) {
          findings.push({ check: 'S5:B-ID重複', detail: `${id} が重複（L${seen.get(id)} と L${b.line}）` })
        } else {
          seen.set(id, b.line)
        }
      }
    }
  }

  // S6: B 行の位置
  for (const b of spec.bs) {
    if (b.section !== '振る舞い仕様') {
      findings.push({
        check: 'S6:B行の位置',
        detail: `${b.id} (L${b.line}) が「## 振る舞い仕様」の外（${b.section ? `## ${b.section}` : 'セクション外'}）にある`,
      })
    }
  }

  // S7: 欠番（純数値 ID のみ。削除済み行も見出しが残る規約なので存在としてカウント）
  {
    const nums = spec.bs
      .flatMap(b => expandRange(b.id))
      .map(id => id.match(/^B-(\d+)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map(m => Number(m[1]))
    if (nums.length > 0) {
      const present = new Set(nums)
      for (let n = Math.min(...nums); n <= Math.max(...nums); n++) {
        if (!present.has(n)) {
          findings.push({
            check: 'S7:欠番',
            detail: `B-${n} がない — 削除なら見出しを取り消し線 + 理由で残す（無断削除の疑い）`,
          })
        }
      }
    }
  }

  // S8: 改番検知（--baseline 指定時のみ）
  if (baselinePath !== null) {
    const base = parseSpec(readLines(baselinePath, 'baseline spec'), baselinePath)
    const curById = new Map(spec.bs.map(b => [b.id, b]))
    const baseIds = new Set(base.bs.map(b => b.id))

    for (const bb of base.bs) {
      const cur = curById.get(bb.id)
      if (!cur) {
        if (!bb.struck) {
          findings.push({
            check: 'S8:改番検知',
            detail: `${bb.id}（旧: ${bb.title}）が消えている — 削除は取り消し線 + 理由で見出しを残す`,
          })
        }
        continue
      }
      if (!bb.struck && !cur.struck && bb.title !== cur.title) {
        findings.push({
          check: 'S8:改番検知',
          detail: `${bb.id} のタイトルが変わっている（旧「${bb.title}」→ 新「${cur.title}」）— ` +
            `内容のすり替えなら改番禁止違反。表現の修正だけならユーザー承認の記録を残す`,
        })
      }
    }
    // 追加は末尾: 新規 ID が既存（baseline 由来）ID より前に現れたら挿入違反
    const lastBasePos = Math.max(-1, ...spec.bs.map((b, i) => baseIds.has(b.id) ? i : -1))
    spec.bs.forEach((b, i) => {
      if (!baseIds.has(b.id) && i < lastBasePos) {
        findings.push({
          check: 'S8:改番検知',
          detail: `${b.id} (L${b.line}) が既存 B 行より前に挿入されている — 追加は末尾（改番禁止の規約）`,
        })
      }
    })
  }

  console.log(`# spec フォーマット検査レポート — ${specPath}`)
  console.log(`セクション ${spec.sections.length} / B 行 ${spec.bs.length}` +
    `（削除済み ${spec.bs.filter(b => b.struck).length}）` +
    (baselinePath !== null ? ` / baseline: ${baselinePath}` : ''))
  console.log('')
  finishReport()
}

// ---- plan モード ------------------------------------------------------------------

if (mode === 'plan') {
  const paths = argvRest.slice(1)
  if (paths.length !== 2 || paths.some(p => p.startsWith('--'))) { console.error(USAGE); process.exit(2) }
  const [specPath, planPath] = paths
  const spec = parseSpec(readLines(specPath, 'spec'), specPath)
  const planLines = readLines(planPath, 'plan')

  const specIds = new Set(spec.bs.flatMap(b => expandRange(b.id)))
  const struckIds = new Set(spec.bs.filter(b => b.struck).flatMap(b => expandRange(b.id)))

  // マイルストーンごとの B 行参照を収集する。参照源は正準形式の2箇所:
  //   - マイルストーン一覧テーブルの行（先頭セルが M-ID）
  //   - `## M<n>:` セクション内の `- 対応:` 行
  interface Milestone { id: string; line: number; refs: Map<string, number> }
  const milestones = new Map<string, Milestone>()
  function milestone(id: string, line: number): Milestone {
    if (!milestones.has(id)) milestones.set(id, { id, line, refs: new Map() })
    return milestones.get(id)!
  }
  function collectRefs(m: Milestone, text: string, line: number): void {
    for (const tok of text.match(/B-[\w.()]+(?:〜B-[\w.()]+)?/g) ?? []) {
      for (const id of expandRange(tok)) {
        if (!m.refs.has(id)) m.refs.set(id, line)
      }
    }
  }

  let curM: Milestone | null = null
  let inFence = false
  planLines.forEach((line, idx) => {
    if (/^```/.test(line.trim())) { inFence = !inFence; return }
    if (inFence) return
    const sec = line.match(/^##\s+(M[\w.]+)\s*[:：]/)
    if (sec) { curM = milestone(sec[1], idx + 1); return }
    if (/^#{1,6}\s/.test(line)) { curM = null; return }
    const cells = line.trim().match(/^\|(.+)\|$/)
    if (cells) {
      const parts = cells[1].split('|').map(c => c.trim())
      if (/^M[\w.]+$/.test(parts[0])) {
        collectRefs(milestone(parts[0], idx + 1), parts.slice(1).join(' '), idx + 1)
      }
      return
    }
    if (curM && /^\s*-\s*対応\s*[:：]/.test(line)) collectRefs(curM, line, idx + 1)
  })
  if (inFence) fail(`${planPath}: fenced block が閉じていない`)

  if (milestones.size === 0) {
    console.error(`${planPath}: マイルストーンを抽出できない — 正準形式（一覧テーブルの M-ID 行、` +
      `## M<n>: セクションの「- 対応:」行）か確認`)
    process.exit(2)
  }

  const coveredBy = new Map<string, string[]>()
  for (const m of milestones.values()) {
    for (const id of m.refs.keys()) {
      if (!coveredBy.has(id)) coveredBy.set(id, [])
      coveredBy.get(id)!.push(m.id)
    }
  }

  // P1: 未カバー B 行
  for (const b of spec.bs.filter(b => !b.struck)) {
    for (const id of expandRange(b.id)) {
      if (!coveredBy.has(id)) {
        findings.push({
          check: 'P1:未カバーB行',
          detail: `${id}（${b.title}）がどのマイルストーンにも割り当てられていない — 実装されない仕様`,
        })
      }
    }
  }

  // P2 / P3: 幽霊参照・削除済み参照
  for (const m of milestones.values()) {
    for (const [id, line] of m.refs) {
      if (!specIds.has(id)) {
        findings.push({
          check: 'P2:幽霊参照',
          detail: `${m.id} (L${line}) が参照する ${id} が spec にない — typo か spec の陳腐化`,
        })
      } else if (struckIds.has(id)) {
        findings.push({
          check: 'P3:削除済み参照',
          detail: `${m.id} (L${line}) が削除済み（取り消し線）の ${id} を参照している`,
        })
      }
    }
  }

  // P4: 空マイルストーン
  for (const m of milestones.values()) {
    if (m.refs.size === 0) {
      findings.push({
        check: 'P4:空マイルストーン',
        detail: `${m.id} (L${m.line}) に対応 B 行がない — スコープ外の作業（対応する B 行がないマイルストーンは存在してはならない）`,
      })
    }
  }

  const liveCount = spec.bs.filter(b => !b.struck).flatMap(b => expandRange(b.id)).length
  const coveredCount = spec.bs.filter(b => !b.struck).flatMap(b => expandRange(b.id))
    .filter(id => coveredBy.has(id)).length
  console.log(`# plan カバレッジ検査レポート — ${specPath} ↔ ${planPath}`)
  console.log(`B 行 ${liveCount}（削除済み除く） / カバー済み ${coveredCount} / マイルストーン ${milestones.size}` +
    `（${[...milestones.keys()].join(', ')}）`)
  console.log('')
  finishReport()
}

// ---- design モード ----------------------------------------------------------------

if (mode === 'design') {
  const paths = argvRest.slice(1)
  if (paths.length !== 2 || paths.some(p => p.startsWith('--'))) { console.error(USAGE); process.exit(2) }
  const [specPath, designPath] = paths
  const spec = parseSpec(readLines(specPath, 'spec'), specPath)
  const designLines = readLines(designPath, 'design')

  const specIds = new Set(spec.bs.flatMap(b => expandRange(b.id)))
  const struckIds = new Set(spec.bs.filter(b => b.struck).flatMap(b => expandRange(b.id)))

  // design.md のセクション走査。見出しの（）補足（例: 土台（利用する既存実装））は無視して
  // 前方一致で正準セクション名に正規化する
  function normalizeSection(name: string): string {
    return name.split(/[（(]/)[0].trim()
  }
  interface DesignEntry { text: string; line: number }
  const sections = new Map<string, DesignEntry[]>()
  const sectionLines = new Map<string, number>()
  let curSec: string | null = null
  let inFence = false
  designLines.forEach((line, idx) => {
    if (/^```/.test(line.trim())) { inFence = !inFence; return }
    if (inFence) return
    const sec = line.match(/^##\s+(.+?)\s*$/)
    if (sec) {
      curSec = normalizeSection(sec[1])
      if (sections.has(curSec)) {
        findings.push({
          check: 'D1:必須セクション',
          detail: `## ${curSec} が複数ある（L${sectionLines.get(curSec)} と L${idx + 1}）`,
        })
      } else {
        sections.set(curSec, [])
        sectionLines.set(curSec, idx + 1)
      }
      return
    }
    // エントリはトップレベルの箇条書き（継続行・ネストはエントリ本体に含めない）
    if (curSec && /^- /.test(line)) sections.get(curSec)!.push({ text: line, line: idx + 1 })
  })
  if (inFence) fail(`${designPath}: fenced block が閉じていない`)

  // D1: 必須セクション欠落
  const REQUIRED = ['土台', '改変箇所', '新規実装', '不変条件', 'リスクランキング', '発見ログ']
  for (const name of REQUIRED) {
    if (!sections.has(name)) {
      findings.push({ check: 'D1:必須セクション', detail: `## ${name} がない（正準定義 — 空でも見出しは置く）` })
    }
  }

  // D2: 土台エントリの検証マーク
  for (const e of sections.get('土台') ?? []) {
    const mark = e.text.match(/\[(実行検証済|読解のみ)([:：]?)\s*([^\]]*)\]/)
    if (!mark) {
      findings.push({
        check: 'D2:検証マーク',
        detail: `土台エントリ (L${e.line}) に [実行検証済] / [読解のみ] マークがない: ${e.text.slice(0, 60)}`,
      })
      continue
    }
    if (mark[1] === '実行検証済') {
      const payload = mark[3].trim()
      if (payload === '' || !payload.includes('`')) {
        findings.push({
          check: 'D2:検証マーク',
          detail: `土台エントリ (L${e.line}) の [実行検証済] に再実行可能な証拠がない — ` +
            `実行コマンドをバッククォートで併記する（例: [実行検証済: \`npm test -- xx\` 12 passed — 観測要点]）`,
        })
      }
    }
  }

  // D3 / D4: B 行参照の突合（土台・改変箇所・新規実装が参照源）
  const refSections = ['土台', '改変箇所', '新規実装']
  const referenced = new Set<string>()
  for (const secName of refSections) {
    for (const e of sections.get(secName) ?? []) {
      for (const tok of e.text.match(/B-[\w.()]+(?:〜B-[\w.()]+)?/g) ?? []) {
        for (const id of expandRange(tok)) {
          referenced.add(id)
          if (!specIds.has(id)) {
            findings.push({
              check: 'D3:B行参照整合',
              detail: `${secName} (L${e.line}) が参照する ${id} が spec にない — typo か spec の陳腐化`,
            })
          } else if (struckIds.has(id)) {
            findings.push({
              check: 'D3:B行参照整合',
              detail: `${secName} (L${e.line}) が削除済み（取り消し線）の ${id} を参照している`,
            })
          }
        }
      }
    }
  }
  for (const b of spec.bs.filter(b => !b.struck)) {
    for (const id of expandRange(b.id)) {
      if (!referenced.has(id)) {
        findings.push({
          check: 'D4:未対応B行',
          detail: `${id}（${b.title}）が土台/改変箇所/新規実装のどこにも対応していない — spec か調査のどちらかに穴`,
        })
      }
    }
  }

  console.log(`# design 検査レポート — ${specPath} ↔ ${designPath}`)
  console.log(`セクション ${sections.size} / 土台エントリ ${(sections.get('土台') ?? []).length}` +
    ` / B 行参照 ${referenced.size}`)
  console.log('')
  finishReport()
}

// ---- ledger モード ----------------------------------------------------------------

if (mode === 'ledger') {
  const paths = argvRest.slice(1)
  if (paths.length !== 1 || paths[0].startsWith('--')) { console.error(USAGE); process.exit(2) }
  const ledgerPath = paths[0]
  const lines = readLines(ledgerPath, '台帳')

  interface LedgerRow {
    id: string
    prefix: string
    num: number
    rd: number
    severity: string
    topic: string
    action: string // 処置セルの生値（空 = 未処置）
    reason: string
    line: number
  }
  const rows: LedgerRow[] = []
  let inFence = false
  lines.forEach((line, idx) => {
    if (/^```/.test(line.trim())) { inFence = !inFence; return }
    if (inFence) return
    const m = line.trim().match(/^\|(.+)\|$/)
    if (!m) return
    const cells = m[1].split('|').map(c => c.trim())
    if (cells.every(c => /^:?-+:?$/.test(c))) return // セパレータ行
    if (cells[0] === 'ID') return // ヘッダ行
    const idm = cells[0].match(/^([RC])-(\d+)$/)
    if (!idm) {
      findings.push({ check: 'L1:行形式', detail: `L${idx + 1}: ID「${cells[0]}」が R-n / C-n 形式でない` })
      return
    }
    if (cells.length !== 6) {
      findings.push({ check: 'L1:行形式', detail: `L${idx + 1}: ${cells[0]} の列数が ${cells.length}（正準は 6: ID/Rd/深刻度/論点/処置/根拠・理由）` })
      return
    }
    const rd = Number(cells[1])
    if (!Number.isInteger(rd) || rd < 1) {
      findings.push({ check: 'L1:行形式', detail: `L${idx + 1}: ${cells[0]} の Rd「${cells[1]}」が正の整数でない` })
      return
    }
    rows.push({
      id: cells[0], prefix: idm[1], num: Number(idm[2]), rd,
      severity: cells[2], topic: cells[3], action: cells[4], reason: cells[5], line: idx + 1,
    })
  })
  if (inFence) fail(`${ledgerPath}: fenced block が閉じていない`)
  if (rows.length === 0) {
    console.error(`${ledgerPath}: 台帳の行を抽出できない — 正準形式（| ID | Rd | 深刻度 | 論点 | 処置 | 根拠・理由 |）か確認`)
    process.exit(2)
  }

  const rowById = new Map(rows.map(r => [r.id, r]))

  // L1（続き）: 深刻度・処置の語彙
  const SEVERITY = new Set(['blocker', 'major', 'minor'])
  const ACTIONS = new Set(['反映済', '却下', '保留', '反証破棄'])
  for (const r of rows) {
    if (!SEVERITY.has(r.severity)) {
      findings.push({ check: 'L1:行形式', detail: `${r.id} (L${r.line}): 深刻度「${r.severity}」は語彙外 — blocker / major / minor` })
    }
    if (r.action !== '' && !ACTIONS.has(r.action) && !/^再燃→/.test(r.action)) {
      findings.push({ check: 'L1:行形式', detail: `${r.id} (L${r.line}): 処置「${r.action}」は語彙外 — 反映済 / 却下 / 保留 / 反証破棄 / 再燃→<ID>` })
    }
  }

  // L2: 処置の完全性
  const EMPTY_REASON = /^[—－\-]?$/
  for (const r of rows) {
    if (r.action === '') {
      findings.push({ check: 'L2:処置の完全性', detail: `${r.id} (L${r.line}) が未処置 — 処置列を埋めてからラウンドを閉じる` })
      continue
    }
    if ((r.action === '却下' || r.action === '反証破棄') && EMPTY_REASON.test(r.reason)) {
      findings.push({ check: 'L2:処置の完全性', detail: `${r.id} (L${r.line}) の ${r.action} に理由がない（${r.action === '却下' ? '却下は理由必須' : '反証破棄は反証根拠必須'}）` })
    }
    if (r.action === '保留' && r.severity !== 'minor') {
      findings.push({ check: 'L2:処置の完全性', detail: `${r.id} (L${r.line}): ${r.severity} に保留は使えない — 保留は minor の採否待ちのみ` })
    }
    if (r.action === '反証破棄' && r.prefix === 'R') {
      findings.push({ check: 'L2:処置の完全性', detail: `${r.id} (L${r.line}): 反証破棄は codereview（C-n）専用の処置 — review に反証フェーズはない` })
    }
  }

  // L3: 再燃参照
  for (const r of rows) {
    const rem = r.action.match(/^再燃→\s*(\S+)$/)
    if (rem && !rowById.has(rem[1])) {
      findings.push({ check: 'L3:再燃参照', detail: `${r.id} (L${r.line}) の 再燃→${rem[1]} の参照先が台帳にない` })
    }
  }

  // L4: ID 重複・欠番（接頭辞ごと）
  for (const prefix of ['R', 'C']) {
    const nums = rows.filter(r => r.prefix === prefix).map(r => r.num)
    if (nums.length === 0) continue
    const seen = new Set<number>()
    for (const r of rows.filter(r => r.prefix === prefix)) {
      if (seen.has(r.num)) findings.push({ check: 'L4:ID重複・欠番', detail: `${r.id} (L${r.line}) が重複` })
      seen.add(r.num)
    }
    for (let n = Math.min(...nums); n <= Math.max(...nums); n++) {
      if (!seen.has(n)) findings.push({ check: 'L4:ID重複・欠番', detail: `${prefix}-${n} がない — 台帳は追記のみ（行の削除の疑い）` })
    }
  }

  // 収束判定（接頭辞ごと — R と C はラウンド系列が別）
  console.log(`# 台帳収束判定 — ${ledgerPath}`)
  console.log(`行 ${rows.length}（R: ${rows.filter(r => r.prefix === 'R').length} / C: ${rows.filter(r => r.prefix === 'C').length}）`)
  console.log('')
  for (const [prefix, label] of [['R', 'dandori-review'], ['C', 'dandori-codereview']] as const) {
    const prows = rows.filter(r => r.prefix === prefix)
    if (prows.length === 0) continue

    // 生存数 = blocker/major のうち処置で無効化されていないもの。
    // C-n は反証破棄（誤検出と確定）を除外する。再燃行は生存として数える
    const survives = (r: LedgerRow): boolean =>
      (r.severity === 'blocker' || r.severity === 'major') && !(prefix === 'C' && r.action === '反証破棄')
    const rounds = [...new Set(prows.map(r => r.rd))].sort((a, b) => a - b)
    const counts = rounds.map(rd => prows.filter(r => r.rd === rd && survives(r)).length)

    // escalate 条件 1: 再燃（参照先が反証破棄なら「反証済みの再生産」— 対象外）
    const rekindled = prows.filter(r => {
      const m = r.action.match(/^再燃→\s*(\S+)$/)
      return m !== null && rowById.get(m[1])?.action !== '反証破棄'
    })
    // escalate 条件 2: 3 ラウンド以上連続で blocker+major が減っていない
    let stalled = false
    for (let i = 2; i < counts.length; i++) {
      if (counts[i] >= counts[i - 1] && counts[i - 1] >= counts[i - 2] && counts[i] > 0) stalled = true
    }

    const latest = counts[counts.length - 1]
    const verdict = (rekindled.length > 0 || stalled) ? 'escalated'
      : latest === 0 ? 'passed'
      : '継続'

    console.log(`## ${prefix}（${label}）`)
    console.log(`ラウンド推移（blocker+major 生存数）: ${rounds.map((rd, i) => `Rd${rd}=${counts[i]}`).join(' → ')}`)
    if (rekindled.length > 0) {
      console.log(`再燃: ${rekindled.map(r => `${r.id}（${r.action}）`).join(', ')} — 反映と指摘の間で解釈が振動している`)
    }
    if (stalled) console.log('停滞: 3 ラウンド以上連続で blocker+major が減っていない')
    console.log(`判定: ${verdict}`)
    console.log('')
  }

  finishReport()
}

// ---- state モード -----------------------------------------------------------------

if (mode === 'state') {
  const paths = argvRest.slice(1)
  if (paths.length !== 1 || paths[0].startsWith('--')) { console.error(USAGE); process.exit(2) }
  const statePath = paths[0]
  const lines = readLines(statePath, 'state.yaml')

  // state.yaml 用ミニパーサ（トップレベル + 1 段ネストのみ — 正準形式が要求する範囲）
  function stripComment(line: string): string {
    const i = line.search(/(^|\s)#/)
    return i === -1 ? line : line.slice(0, i)
  }
  const top: Record<string, string | Record<string, string>> = {}
  let curKey: string | null = null
  lines.forEach((raw, idx) => {
    const line = stripComment(raw)
    if (line.trim() === '') return
    const indent = line.length - line.trimStart().length
    const m = line.trim().match(/^([\w-]+):\s*(.*)$/)
    if (!m) { fail(`${statePath} L${idx + 1}: 解釈できない行: ${raw.trim()}`); return }
    const [, key, value] = m
    if (indent === 0) {
      if (value === '') { top[key] = {}; curKey = key }
      else { top[key] = value.trim(); curKey = null }
    } else if (curKey !== null && typeof top[curKey] === 'object') {
      ;(top[curKey] as Record<string, string>)[key] = value.trim()
    } else {
      fail(`${statePath} L${idx + 1}: ネストの親キーがない: ${raw.trim()}`)
    }
  })

  const FULL_ORDER = ['spec', 'ground', 'review', 'spike', 'plan', 'impl', 'codereview', 'refine', 'gate']
  const SHORT_PHASES = new Set(['spec', 'impl', 'codereview', 'refine', 'gate']) // codereview/refine は短縮でも任意実施可
  const PHASE_VOCAB = new Set([...FULL_ORDER, 'done'])

  const str = (v: unknown): string | null => typeof v === 'string' ? v : null
  const section = (k: string): Record<string, string> =>
    typeof top[k] === 'object' ? top[k] as Record<string, string> : {}

  // Y1: 語彙・形式
  const KNOWN_TOP = new Set(['feature', 'course', 'phase', 'phases_done', 'review', 'spike', 'impl', 'codereview', 'refine', 'progress', 'updated'])
  for (const k of Object.keys(top)) {
    if (!KNOWN_TOP.has(k)) findings.push({ check: 'Y1:語彙・形式', detail: `未知のトップレベルキー: ${k}（正準定義は dandori ルーターの SKILL.md）` })
  }
  const course = str(top.course)
  if (course !== null && course !== 'full' && course !== 'short') {
    findings.push({ check: 'Y1:語彙・形式', detail: `course「${course}」は語彙外 — full / short` })
  }
  const phase = str(top.phase)
  if (phase === null) findings.push({ check: 'Y1:語彙・形式', detail: 'phase がない' })
  else if (!PHASE_VOCAB.has(phase)) findings.push({ check: 'Y1:語彙・形式', detail: `phase「${phase}」は語彙外` })
  const doneRaw = str(top.phases_done) ?? ''
  const phasesDone = doneRaw.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(s => s !== '')
  for (const p of phasesDone) {
    if (!FULL_ORDER.includes(p)) findings.push({ check: 'Y1:語彙・形式', detail: `phases_done の「${p}」は語彙外` })
  }
  const STATUS_VOCAB: Record<string, Set<string>> = {
    review: new Set(['in_progress', 'passed', 'escalated']),
    spike: new Set(['pending', 'done', 'skipped']),
    codereview: new Set(['in_progress', 'passed', 'escalated', 'skipped']),
    refine: new Set(['pending', 'done', 'skipped']),
  }
  for (const [sec, vocab] of Object.entries(STATUS_VOCAB)) {
    const s = section(sec).status
    if (s !== undefined && !vocab.has(s)) {
      findings.push({ check: 'Y1:語彙・形式', detail: `${sec}.status「${s}」は語彙外 — ${[...vocab].join(' / ')}` })
    }
  }
  const numeric = (sec: string, key: string): number | null => {
    const v = section(sec)[key]
    if (v === undefined) return null
    if (!/^\d+$/.test(v)) {
      findings.push({ check: 'Y1:語彙・形式', detail: `${sec}.${key}「${v}」が非負整数でない` })
      return null
    }
    return Number(v)
  }
  const rounds = numeric('review', 'rounds')
  numeric('codereview', 'rounds')
  const mDone = numeric('impl', 'milestones_done')
  const mTotal = numeric('impl', 'milestones_total')
  numeric('refine', 'applied')
  numeric('refine', 'rejected')
  const updated = str(top.updated)
  if (updated !== null && !/^\d{4}-\d{2}-\d{2}$/.test(updated)) {
    findings.push({ check: 'Y1:語彙・形式', detail: `updated「${updated}」が YYYY-MM-DD 形式でない` })
  }

  // Y2: feature ↔ ディレクトリ名
  const feature = str(top.feature)
  const dirName = dirname(resolve(statePath)).split('/').pop() ?? ''
  if (feature !== null && feature !== dirName) {
    findings.push({ check: 'Y2:feature一致', detail: `feature「${feature}」がディレクトリ名「${dirName}」と一致しない` })
  }

  // Y3: フェーズ整合
  if (phase !== null && phase !== 'done' && phasesDone.includes(phase)) {
    findings.push({ check: 'Y3:フェーズ整合', detail: `phase「${phase}」が phases_done に入っている — 完了済みなら phase を次工程へ進める` })
  }
  if (phase === 'done' && !phasesDone.includes('gate')) {
    findings.push({ check: 'Y3:フェーズ整合', detail: 'phase: done なのに phases_done に gate がない — gate を通らずに done にはならない' })
  }
  if (course === 'short') {
    for (const p of [phase, ...phasesDone]) {
      if (p !== null && p !== 'done' && !SHORT_PHASES.has(p)) {
        findings.push({ check: 'Y3:フェーズ整合', detail: `短縮コースに工程「${p}」は存在しない（spec → impl → gate — codereview / refine は任意実施のみ）` })
      }
    }
  }
  if (phasesDone.includes('impl') && mDone !== null && mTotal !== null && mDone < mTotal) {
    findings.push({ check: 'Y3:フェーズ整合', detail: `phases_done に impl があるのに milestones ${mDone}/${mTotal} — 全マイルストーン完了が impl の完了条件` })
  }
  if (mDone !== null && mTotal !== null && mDone > mTotal) {
    findings.push({ check: 'Y3:フェーズ整合', detail: `milestones_done（${mDone}）が milestones_total（${mTotal}）を超えている` })
  }
  const doneNeedsStatus: [string, string[]][] = [
    ['review', ['passed', 'escalated']],
    ['spike', ['done', 'skipped']],
    ['codereview', ['passed', 'escalated', 'skipped']],
    ['refine', ['done', 'skipped']],
  ]
  for (const [sec, ok] of doneNeedsStatus) {
    const s = section(sec).status
    if (phasesDone.includes(sec) && s !== undefined && !ok.includes(s)) {
      findings.push({ check: 'Y3:フェーズ整合', detail: `phases_done に ${sec} があるのに ${sec}.status が「${s}」 — 完了状態（${ok.join(' / ')}）でない` })
    }
  }
  if (rounds !== null && rounds >= 1 && phase !== null && FULL_ORDER.indexOf(phase) < FULL_ORDER.indexOf('review') && !phasesDone.includes('review')) {
    // review 実施済みなのに phase が review より前 = 逆行。逆行自体は正当だが phases_done から外した記録が必要
    findings.push({ check: 'Y3:フェーズ整合', detail: `review.rounds が ${rounds} なのに phase「${phase}」が review より前 — 逆行なら理由を design.md の発見ログに記録する（この指摘は記録済みなら無視してよい）` })
  }

  // Y4: 成果物整合
  const featureDir = dirname(resolve(statePath))
  const exists = (name: string): boolean => {
    try { statSync(join(featureDir, name)); return true } catch { return false }
  }
  if (phase !== 'done') {
    const needs: [string, string, string][] = [
      ['spec', 'spec.md', 'spec 完了の成果物'],
      ['ground', 'design.md', 'ground 完了の成果物'],
      ['plan', 'plan.md', 'plan 完了の成果物'],
      ['review', 'review-ledger.md', 'review 完了なら台帳が残っているはず'],
    ]
    for (const [p, file, why] of needs) {
      if (phasesDone.includes(p) && !exists(file)) {
        findings.push({ check: 'Y4:成果物整合', detail: `phases_done に ${p} があるのに ${file} がない（${why}）` })
      }
    }
  } else {
    if (!exists('spec.md')) {
      findings.push({ check: 'Y4:成果物整合', detail: 'phase: done なのに spec.md がない — spec.md は長寿命ドキュメントとして残す' })
    }
    for (const file of ['plan.md', 'trace.md', 'review-ledger.md']) {
      if (exists(file)) {
        findings.push({ check: 'Y4:成果物整合', detail: `phase: done なのに ${file} が残っている — クローズ手順の処分漏れの疑い（アーカイブ方針で意図的に残すなら無視してよい）` })
      }
    }
  }

  console.log(`# state.yaml 整合検査レポート — ${statePath}`)
  console.log(`feature: ${feature ?? '（なし）'} / course: ${course ?? '（なし）'} / phase: ${phase ?? '（なし）'} / phases_done: [${phasesDone.join(', ')}]`)
  console.log('')
  finishReport()
}

// ---- map モード -------------------------------------------------------------------

if (mode === 'map') {
  const mapPaths = argvRest.slice(1)
  if (mapPaths.length === 0 || mapPaths.some(p => p.startsWith('--'))) { console.error(USAGE); process.exit(2) }

  function git(cwd: string, args: string[]): string | null {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return null
    }
  }

  interface Anchor { raw: string; file: string; lineRef: number | null; symbol: string | null; line: number }

  /** バッククォートトークンからパスアンカーを解釈する。パスらしくないもの（コマンド等）は null */
  function parseAnchor(token: string, line: number): Anchor | null {
    if (/\s/.test(token)) return null // コマンド（`npm test -- xx` 等）
    if (!token.includes('/') && !/\.\w+/.test(token)) return null
    const m = token.match(/^(.*?)(?::([^:]+))?$/)
    if (!m) return null
    const suffix = m[2] ?? null
    if (suffix === null) return { raw: token, file: m[1], lineRef: null, symbol: null, line }
    if (/^\d+$/.test(suffix)) return { raw: token, file: m[1], lineRef: Number(suffix), symbol: null, line }
    if (/^[A-Za-z_$][\w$.]*$/.test(suffix)) return { raw: token, file: m[1], lineRef: null, symbol: suffix, line }
    return { raw: token, file: token, lineRef: null, symbol: null, line } // : を含むファイル名は稀 — 素通し
  }

  let totalClaims = 0, totalAnchors = 0
  for (const mapPath of mapPaths) {
    const lines = readLines(mapPath, 'map ファイル')
    const mapDir = resolve(dirname(mapPath))
    const repoRoot = git(mapDir, ['rev-parse', '--show-toplevel'])
    if (repoRoot === null) {
      console.error(`${mapPath}: git リポジトリ内にない — アンカーの解決基準（リポジトリルート）を特定できない`)
      process.exit(2)
    }
    const rel = (p: string) => `${mapPath}: ${p}`

    // V1: generated-at ヘッダと変更ファイル集合
    let changedFiles: Set<string> | null = null
    const gen = lines.map((l, i) => ({ m: l.match(/<!--\s*generated-at:\s*([0-9a-f]{7,40})\b.*?-->/), i }))
      .find(x => x.m !== null)
    if (!gen) {
      findings.push({ check: 'V1:generated-at', detail: rel('generated-at ヘッダがない — 鮮度検査の基準点を記録する（正準定義）') })
    } else {
      const hash = gen.m![1]
      const diff = git(mapDir, ['diff', '--name-only', `${hash}..HEAD`])
      if (diff === null) {
        findings.push({
          check: 'V1:generated-at',
          detail: rel(`generated-at の hash ${hash} を git で解決できない（rebase / shallow clone で消失？）— 変更ファイル突合（V3）はスキップ`),
        })
      } else {
        changedFiles = new Set(diff.split('\n').filter(l => l !== ''))
      }
    }

    // 主張（トップレベル箇条書き）とアンカーの走査
    interface Claim { text: string; line: number; anchors: Anchor[]; unverifiedNote: boolean; hasGrade: boolean }
    const claims: Claim[] = []
    const blockAnchors: Anchor[] = []
    let inFence = false
    let inStateMapBlock = false
    lines.forEach((line, idx) => {
      const t = line.trim()
      if (/^```/.test(t)) {
        inStateMapBlock = !inFence && /^```dandori-state-map\s*$/.test(t)
        inFence = !inFence
        return
      }
      if (inFence) {
        if (inStateMapBlock) {
          const am = t.match(/^anchor:\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/)
          if (am) {
            const a = parseAnchor(am[1].trim(), idx + 1)
            if (a) blockAnchors.push(a)
          }
        }
        return
      }
      if (!/^- /.test(line)) return
      const anchors: Anchor[] = []
      const evid = line.match(/根拠\s*[:：]\s*(.*)$/)
      if (evid) {
        // 等級マーク（[実行検証済: `コマンド` ...] 等）内のバッククォートはコマンドなので、
        // 根拠: からマーク開始までの区間だけをアンカー源にする
        const seg = evid[1].split('[')[0]
        for (const bt of seg.match(/`([^`]+)`/g) ?? []) {
          const a = parseAnchor(bt.slice(1, -1), idx + 1)
          if (a) anchors.push(a)
        }
      }
      claims.push({
        text: line.replace(/^- /, '').slice(0, 60),
        line: idx + 1,
        anchors,
        unverifiedNote: line.includes('未確認'),
        hasGrade: /\[(実行検証済|読解のみ)/.test(line),
      })
    })
    if (inFence) fail(`${mapPath}: fenced block が閉じていない`)

    // V2 / V3: アンカー死活
    function checkAnchor(a: Anchor, owner: string): void {
      totalAnchors++
      const abs = join(repoRoot!, a.file)
      let st: { isDirectory(): boolean; size: number } | null = null
      try { st = statSync(abs) } catch { /* 消滅 */ }
      if (st === null) {
        findings.push({ check: 'V2:アンカー先消滅', detail: rel(`L${a.line} ${owner} のアンカー \`${a.raw}\` — ${a.file} が存在しない`) })
        return
      }
      if (!st.isDirectory()) {
        if (a.lineRef !== null) {
          const n = readFileSync(abs, 'utf-8').split('\n').length
          if (a.lineRef > n) {
            findings.push({ check: 'V2:アンカー先消滅', detail: rel(`L${a.line} ${owner} のアンカー \`${a.raw}\` — ${a.file} は ${n} 行（:${a.lineRef} が範囲外）`) })
            return
          }
        }
        if (a.symbol !== null && !readFileSync(abs, 'utf-8').includes(a.symbol)) {
          findings.push({ check: 'V2:アンカー先消滅', detail: rel(`L${a.line} ${owner} のアンカー \`${a.raw}\` — ${a.file} にシンボル ${a.symbol} が見つからない`) })
          return
        }
      }
      if (changedFiles !== null && changedFiles.has(a.file)) {
        findings.push({ check: 'V3:アンカー先変更', detail: rel(`L${a.line} ${owner} のアンカー \`${a.raw}\` — generated-at 以降に変更あり（主張の再検証候補）`) })
      }
    }
    for (const c of claims) for (const a of c.anchors) checkAnchor(a, `主張「${c.text}」`)
    for (const a of blockAnchors) checkAnchor(a, '状態マップ')

    // V4 / V5: アンカー・等級のない主張
    for (const c of claims.filter(c => !c.unverifiedNote)) {
      if (c.anchors.length === 0) {
        findings.push({ check: 'V4:アンカーなし主張', detail: rel(`L${c.line}「${c.text}」— 根拠アンカーがなく verify で検査できない（未確認なら明記する）`) })
      }
      if (!c.hasGrade) {
        findings.push({ check: 'V5:検証等級なし主張', detail: rel(`L${c.line}「${c.text}」— [実行検証済] / [読解のみ] の等級がない`) })
      }
    }
    totalClaims += claims.length
  }

  console.log(`# map アンカー死活検査レポート — ${mapPaths.join(', ')}`)
  console.log(`主張 ${totalClaims} / アンカー ${totalAnchors}`)
  console.log('')
  finishReport()
}

// ---- trace モード -----------------------------------------------------------------

if (mode === 'trace') {
  const paths = argvRest.slice(1)
  if (paths.length < 2 || paths.some(p => p.startsWith('--'))) { console.error(USAGE); process.exit(2) }
  const [specPath, ...scanRoots] = paths
  const spec = parseSpec(readLines(specPath, 'spec'), specPath)

  const specIds = new Set(spec.bs.flatMap(b => expandRange(b.id)))
  const struckIds = new Set(spec.bs.filter(b => b.struck).flatMap(b => expandRange(b.id)))

  // テストファイル走査。B-ID はトークン単位で完全一致（B-1 が B-12 に誤マッチしない）
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'vendor', 'target', '.dandori'])
  const MAX_FILE_SIZE = 1024 * 1024
  const hits = new Map<string, string[]>() // B-ID → "file:line" の一覧
  let scannedFiles = 0

  function scanFile(path: string): void {
    let text: string
    try { text = readFileSync(path, 'utf-8') } catch { return }
    if (text.includes('\u0000')) return // バイナリ
    scannedFiles++
    text.split('\n').forEach((line, idx) => {
      for (const raw of line.match(/B-[\w.()]+/g) ?? []) {
        const id = raw.replace(/[.)]+$/, '') // 文末の句読点由来のゴミを除去
        if (!hits.has(id)) hits.set(id, [])
        const list = hits.get(id)!
        if (list.length < 5) list.push(`${path}:${idx + 1}`) // 根拠は 5 件で打ち切り
      }
    })
  }
  function walk(path: string): void {
    let st: { isDirectory(): boolean; size: number }
    try { st = statSync(path) } catch {
      console.error(`走査対象を読めない: ${path}`)
      process.exit(2)
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(path)) {
        if (SKIP_DIRS.has(name)) continue
        walk(join(path, name))
      }
    } else if (st.size <= MAX_FILE_SIZE) {
      scanFile(path)
    }
  }
  for (const root of scanRoots) walk(root)

  // トレース表の叩き台（unit/e2e/formal はテスト対応が必要。visual/manual は最終ゲートで確認）
  const NEEDS_TEST = new Set(['unit', 'e2e', 'formal'])
  console.log(`# 初期トレース表 — ${specPath}`)
  console.log(`走査: ${scanRoots.join(', ')}（${scannedFiles} ファイル）`)
  console.log('状態は実行前の初期値 — ゲート工程がテストを再実行して更新する')
  console.log('')
  console.log('| B 行 | ゲート | 状態 | 根拠 |')
  console.log('|------|--------|------|------|')
  for (const b of spec.bs.filter(b => !b.struck)) {
    const tags = (b.gateRaw ?? '').split(/[,、/\s]+/).filter(t => t !== '')
    const gate = tags.join(', ') || '（Gate なし）'
    const found = expandRange(b.id).flatMap(id => hits.get(id) ?? [])
    if (tags.some(t => NEEDS_TEST.has(t))) {
      if (found.length > 0) {
        console.log(`| ${b.id} | ${gate} | ⏳ 要再実行 | ${found.join(', ')} |`)
      } else {
        console.log(`| ${b.id} | ${gate} | ⚠️ 未検証候補 | B-ID の grep ヒットなし |`)
        findings.push({
          check: 'T1:対応テストなし',
          detail: `${b.id}（${b.title} / ${gate}）に対応するテストが grep で見つからない — ` +
            `テスト追加か、推測でない対応理由の明記か、manual への降格裁定`,
        })
      }
    } else if (tags.includes('manual')) {
      console.log(`| ${b.id} | ${gate} | ⏳ ユーザー確認待ち | 確認手順を B 行から生成する |`)
    } else {
      console.log(`| ${b.id} | ${gate} | ⏳ 要確認 | ${found.length > 0 ? found.join(', ') : '—'} |`)
    }
  }
  console.log('')

  // T2 / T3: テスト側の幽霊・削除済み B-ID
  for (const [id, locs] of [...hits.entries()].sort()) {
    if (struckIds.has(id)) {
      findings.push({
        check: 'T3:削除済み参照',
        detail: `削除済み（取り消し線）の ${id} を参照するテストがある: ${locs.join(', ')}`,
      })
    } else if (!specIds.has(id)) {
      findings.push({
        check: 'T2:幽霊B-ID',
        detail: `テストコード中の ${id} が spec にない（typo か spec の陳腐化）: ${locs.join(', ')}`,
      })
    }
  }

  finishReport()
}

export {}
