/**
 * ledger-append モード — 台帳への行追記（検査ではなく書き込み）:
 *   ID 発番・行の書式・処置と深刻度の語彙・書き先パスをスクリプト側で固定し、記録係
 *   エージェントには既存行との同一論点照合だけを残す。エージェントに追記させる設計では
 *   書き落とし（発番済み ID の欠番化）・worktree 内複製への二重書き込み・ID 再採番衝突が
 *   プロンプト強化を重ねても再発した（2026-07-25 恒久対策）。同一 Rd に同一論点の行が
 *   あれば追記せず既存 ID を返す（冪等 — 二重実行・新規実行での再開でも行が増えない）。
 *   入力は JSON 配列 [{index, severity, topic, action?, reason?}]、出力は
 *   `[appended] index=<i> id=<ID> status=<new|existing>` の機械可読行。
 *   収束判定（指摘とは別枠 — exit code に影響しない）:
 *     passed = 最新ラウンド（マーカーのみのラウンド含む）の blocker+major がゼロ
 *              （反証破棄は R/C 共通で生存数から除外）
 *     escalated = 再燃→ がある（終端の再生産が反証破棄の連鎖は除く — 反証済みの再生産。
 *                 参照が連鎖する場合は終端まで辿る 2026-07-21 改定）、
 *                 または 3 ラウンド以上連続で blocker+major 件数が減っておらず、かつ
 *                 最新ラウンドに未解消の再燃が含まれる（2026-07-10 改定）
 *     継続 = どちらでもない
 *   判定は人間向けの「判定: <語>」行に加えて機械可読な `[verdict] R=<token>` /
 *   `[verdict] C=<token>`（token = passed | escalated | continue）を出力する —
 *   workflow の収束判定エージェントはこの行を逐語転記し、verdict へのマッピングは
 *   workflow スクリプトが決定的に行う（エージェントの意味的マッピング誤りの排除 2026-07-22）
 */

import { appendFileSync, join, readFileSync } from '../env.ts'
import { splitCells } from '../report.ts'
import { USAGE } from '../usage.ts'

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }


/**
 * 台帳への行追記を決定的に行う。ID 発番・行の書式・処置の語彙・書き先パスをすべて
 * ここで固定し、記録係エージェントには「既存行との同一論点照合」だけを残す。
 *
 * 動機（2026-07-25 実戦観測の恒久対策）: 追記そのものをエージェントにさせる設計では、
 * (a) 発番した ID の行が台帳に書かれない書き落とし（C-2 / C-31 の欠番化）、
 * (b) worktree 内の複製へ書き込む台帳二重化、
 * (c) ラウンドを跨いだ ID の再採番衝突
 * が、プロンプトの強化を重ねても再発し続けた。書き込みを Edit から外すのが唯一の根治。
 *
 * 冪等 — 同一 Rd に同一論点の行が既にあれば追記せず既存 ID を返す（同一ラウンドの
 * 二重実行・新規実行での再開でも行が増えない）。
 */
export function run(argvRest: string[]): void {
  let prefix: string | null = null
  let rd = 0
  let rowsRaw: string | null = null
  let fromStdin = false
  const paths: string[] = []
  for (let i = 1; i < argvRest.length; i++) {
    const a = argvRest[i]
    if (a === '--prefix') { prefix = argvRest[++i] ?? null; continue }
    if (a === '--rd') { rd = Number(argvRest[++i]); continue }
    if (a === '--rows') { rowsRaw = argvRest[++i] ?? null; continue }
    if (a === '--rows-stdin') { fromStdin = true; continue }
    if (a.startsWith('--')) { console.error(`未知のオプション: ${a}\n${USAGE}`); process.exit(2) }
    paths.push(a)
  }
  if (paths.length !== 1 || (prefix !== 'R' && prefix !== 'C' && prefix !== 'F') || !Number.isInteger(rd) || rd < 1) {
    console.error(`ledger-append には台帳パス 1 つ・--prefix <R|C|F>・--rd <正の整数> が必要\n${USAGE}`)
    process.exit(2)
  }
  if (fromStdin === (rowsRaw !== null)) {
    console.error(`--rows <json> と --rows-stdin はどちらか一方を指定する\n${USAGE}`)
    process.exit(2)
  }
  const ledgerPath = paths[0]

  let rowsInput: { index?: number; severity: string; topic: string; action?: string; reason?: string }[]
  try {
    // @ts-ignore -- stdin は fd 0（'/dev/stdin' はプラットフォーム差がある）
    const raw = fromStdin ? readFileSync(0 as unknown as string, 'utf-8') : rowsRaw!
    rowsInput = JSON.parse(raw)
    if (!Array.isArray(rowsInput)) throw new Error('配列でない')
  } catch (e) {
    console.error(`--rows の JSON を解釈できない（期待形: [{"index":0,"severity":"major","topic":"...","action":"","reason":"..."}]）: ${(e as { message?: string }).message ?? e}`)
    process.exit(2)
  }
  if (rowsInput.length === 0) {
    console.log('追記対象ゼロ件 — 台帳は変更なし')
    process.exit(0)
  }

  // 語彙は書き込み時点で強制する — 語彙外の処置セル（「対応済」等の言い換え）が台帳に
  // 入ると L1 が escalated を誘発する（2026-07-23 実戦観測）。入口で弾いて混入させない
  const SEVERITY_OK = new Set(['blocker', 'major', 'minor'])
  const ACTION_OK = new Set(['', '反映済', '却下', '保留', '反証破棄'])
  for (const [i, r] of rowsInput.entries()) {
    if (!r || typeof r.topic !== 'string' || r.topic.trim() === '') {
      console.error(`rows[${i}]: topic（論点の一行要約）が必要`)
      process.exit(2)
    }
    if (!SEVERITY_OK.has(r.severity)) {
      console.error(`rows[${i}]: severity「${r.severity}」は語彙外 — blocker / major / minor`)
      process.exit(2)
    }
    const action = r.action ?? ''
    if (!ACTION_OK.has(action) && !/^再燃→\s*\S+$/.test(action)) {
      console.error(`rows[${i}]: action「${action}」は語彙外 — 空 / 反映済 / 却下 / 保留 / 反証破棄 / 再燃→<ID>`)
      process.exit(2)
    }
  }

  let existing = ''
  try { existing = readFileSync(ledgerPath, 'utf-8') } catch { existing = '' }

  // 既存行の走査 — 同一接頭辞の最大番号（発番フロア）と、(Rd, 論点) の既存索引（冪等判定用）
  let maxNum = 0
  const byRdTopic = new Map<string, string>()
  {
    let inFence = false
    for (const line of existing.split('\n')) {
      if (/^```/.test(line.trim())) { inFence = !inFence; continue }
      if (inFence) continue
      const m = line.trim().match(/^\|(.+)\|$/)
      if (!m) continue
      const cells = splitCells(m[1])
      const idm = (cells[0] ?? '').match(/^([RCF])-(\d+)$/)
      if (!idm || idm[1] !== prefix) continue
      maxNum = Math.max(maxNum, Number(idm[2]))
      byRdTopic.set(`${cells[1]}\x00${cells[3] ?? ''}`, cells[0])
    }
  }

  const escapeCell = (s: unknown): string =>
    String(s ?? '').replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim()

  const appendLines: string[] = []
  const report: string[] = []
  let next = maxNum + 1
  for (const [i, r] of rowsInput.entries()) {
    const index = Number.isInteger(r.index) ? r.index! : i
    const topic = escapeCell(r.topic)
    const dup = byRdTopic.get(`${rd}\x00${topic}`)
    if (dup !== undefined) {
      report.push(`[appended] index=${index} id=${dup} status=existing`)
      continue
    }
    const id = `${prefix}-${next++}`
    appendLines.push(`| ${id} | ${rd} | ${r.severity} | ${topic} | ${escapeCell(r.action ?? '')} | ${escapeCell(r.reason ?? '')} |`)
    byRdTopic.set(`${rd}\x00${topic}`, id)
    report.push(`[appended] index=${index} id=${id} status=new`)
  }

  if (appendLines.length > 0) {
    // 台帳が未作成 / テーブルヘッダがない場合はヘッダから作る（正準形式はここが唯一の出所）
    const hasHeader = /^\|\s*ID\s*\|/m.test(existing)
    const header = hasHeader ? '' : `${existing.trim() === '' ? '# 指摘台帳\n\n' : '\n'}| ID | Rd | 深刻度 | 論点 | 処置 | 根拠・理由 |\n| --- | --- | --- | --- | --- | --- |\n`
    const lead = existing === '' || existing.endsWith('\n') ? '' : '\n'
    appendFileSync(ledgerPath, `${lead}${header}${appendLines.join('\n')}\n`)
  }

  console.log(`# 台帳追記 — ${ledgerPath}`)
  console.log(`接頭辞 ${prefix} / Rd=${rd} / 新規 ${appendLines.length} 件 / 既存一致 ${rowsInput.length - appendLines.length} 件`)
  for (const line of report) console.log(line)
  process.exit(0)
}
