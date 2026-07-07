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
 * 実行:
 *   node check-docs.ts spec <spec.md>
 *   node check-docs.ts spec <spec.md> --baseline <旧spec.md>
 *     （fix 済み spec を再編集したとき: git show HEAD:<path> > /tmp/base.md で取り出す）
 *   node check-docs.ts plan <spec.md> <plan.md>
 *
 * 終了コード: 0 = 全検査グリーン / 1 = 指摘あり / 2 = パース・形式エラー
 */

// 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
const { readFileSync } = await import('node:fs') as { readFileSync(path: string, enc: string): string }

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
  '       node check-docs.ts plan <spec.md> <plan.md>'

if (mode !== 'spec' && mode !== 'plan') {
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

{
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

export {}
