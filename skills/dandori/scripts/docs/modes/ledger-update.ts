/**
 * ledger-update モード — 台帳の処置セル更新（検査ではなく書き込み）:
 *   既存行の処置・根拠セルの更新を、語彙・参照整合の強制つきでスクリプト側に固定する。
 *   ledger-append（2026-07-25）は「行の追記」だけを Edit から外したが、処置の更新
 *   （反証破棄・反映済・再燃→）はエージェントの Edit に残っており、第 5 波で
 *   (a) 処置が空のまま指摘が返却から漏れる書き落とし（追記側と同族）と
 *   (b) 語彙揺れ（「反映済み」）+ 同一 Rd 行への「再燃→」誤用による escalated 誤判定
 *   が再発した（2026-07-28 恒久対策 — 台帳書き込みの Edit 面を全面撤去する仕上げ）。
 *   強制する不変条件:
 *     - 処置語彙（反映済 / 却下 / 保留 / 反証破棄 / 再燃→<ID>。空への更新は不可）
 *     - 却下・反証破棄は理由必須（L2 と同一基準を書き込み時点で前倒し）
 *     - 再燃→<ID> の参照先は実在し、かつ**前のラウンド**の行であること —
 *       同一 Rd の行への再燃は「ラウンド内重複」の誤記で、escalated 誤判定を誘発する
 *     - 反証破棄の行は上書き不可（反証済み確定の巻き戻し禁止 — 冪等な同値再指定のみ許す)
 *   冪等 — 既に同じ処置（と理由）ならファイルに触れず status=unchanged を返す。
 *   入力は JSON 配列 [{id, action, reason?}]、出力は
 *   `[updated] id=<ID> status=<changed|unchanged>` の機械可読行。
 *   検証は全行を書き込み前に行い、1 件でも不正があれば何も書かずに exit 2（部分適用なし）。
 */

import { readFileSync, writeFileSync } from '../env.ts'
import { splitCells } from '../report.ts'
import { USAGE } from '../usage.ts'

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }


export function run(argvRest: string[]): void {
  let rowsRaw: string | null = null
  let fromStdin = false
  const paths: string[] = []
  for (let i = 1; i < argvRest.length; i++) {
    const a = argvRest[i]
    if (a === '--rows') { rowsRaw = argvRest[++i] ?? null; continue }
    if (a === '--rows-stdin') { fromStdin = true; continue }
    if (a.startsWith('--')) { console.error(`未知のオプション: ${a}\n${USAGE}`); process.exit(2) }
    paths.push(a)
  }
  if (paths.length !== 1) {
    console.error(`ledger-update には台帳パス 1 つが必要\n${USAGE}`)
    process.exit(2)
  }
  if (fromStdin === (rowsRaw !== null)) {
    console.error(`--rows <json> と --rows-stdin はどちらか一方を指定する\n${USAGE}`)
    process.exit(2)
  }
  const ledgerPath = paths[0]

  let rowsInput: { id: string; action: string; reason?: string }[]
  try {
    // @ts-ignore -- stdin は fd 0（'/dev/stdin' はプラットフォーム差がある）
    const raw = fromStdin ? readFileSync(0 as unknown as string, 'utf-8') : rowsRaw!
    rowsInput = JSON.parse(raw)
    if (!Array.isArray(rowsInput)) throw new Error('配列でない')
  } catch (e) {
    console.error(`--rows の JSON を解釈できない（期待形: [{"id":"C-3","action":"反証破棄","reason":"..."}]）: ${(e as { message?: string }).message ?? e}`)
    process.exit(2)
  }
  if (rowsInput.length === 0) {
    console.log('更新対象ゼロ件 — 台帳は変更なし')
    process.exit(0)
  }

  let text: string
  try { text = readFileSync(ledgerPath, 'utf-8') } catch {
    console.error(`台帳を読めない: ${ledgerPath}`)
    process.exit(2)
  }

  // 台帳のパース — 行番号つきで ID → 行の索引を作る（重複 ID は更新先が定まらないため拒否）
  interface Row { id: string; rd: number; cells: string[]; lineIdx: number }
  const lines = text.split('\n')
  const byId = new Map<string, Row>()
  const dupIds = new Set<string>()
  {
    let inFence = false
    lines.forEach((line, lineIdx) => {
      if (/^```/.test(line.trim())) { inFence = !inFence; return }
      if (inFence) return
      const m = line.trim().match(/^\|(.+)\|$/)
      if (!m) return
      const cells = splitCells(m[1])
      if (!/^[RCF]-\d+$/.test(cells[0] ?? '')) return
      if (byId.has(cells[0])) { dupIds.add(cells[0]); return }
      byId.set(cells[0], { id: cells[0], rd: Number(cells[1]), cells, lineIdx })
    })
  }

  // 語彙・参照整合の検証 — 全件を書き込み前に行い、不正があれば何も書かない（部分適用なし）
  const errors: string[] = []
  for (const [i, r] of rowsInput.entries()) {
    if (!r || typeof r.id !== 'string' || !/^[RCF]-\d+$/.test(r.id)) {
      errors.push(`rows[${i}]: id「${r?.id}」が R-n / C-n / F-n 形式でない`)
      continue
    }
    if (dupIds.has(r.id)) {
      errors.push(`rows[${i}]: ${r.id} が台帳内で重複している — 先に ledger モードの指摘（L4）を解消すること`)
      continue
    }
    const row = byId.get(r.id)
    if (!row) {
      errors.push(`rows[${i}]: ${r.id} が台帳にない`)
      continue
    }
    if (row.cells.length !== 6) {
      errors.push(`rows[${i}]: ${r.id} の行の列数が ${row.cells.length}（正準は 6）— 先に行形式を直すこと`)
      continue
    }
    const action = r.action ?? ''
    const rekindle = action.match(/^再燃→\s*(\S+)$/)
    if (!['反映済', '却下', '保留', '反証破棄'].includes(action) && !rekindle) {
      errors.push(`rows[${i}]: action「${action}」は語彙外 — 反映済 / 却下 / 保留 / 反証破棄 / 再燃→<ID>（空への更新は不可）`)
      continue
    }
    if ((action === '却下' || action === '反証破棄') && !(r.reason ?? '').trim()) {
      errors.push(`rows[${i}]: ${r.id} の ${action} には reason が必須（${action === '却下' ? '却下は理由必須' : '反証破棄は反証根拠必須'}）`)
      continue
    }
    if (rekindle) {
      const target = byId.get(rekindle[1])
      if (!target) {
        errors.push(`rows[${i}]: ${r.id} の 再燃→${rekindle[1]} の参照先が台帳にない`)
        continue
      }
      if (!(target.rd < row.rd)) {
        errors.push(`rows[${i}]: ${r.id}（Rd${row.rd}）から同一/後続ラウンドの ${target.id}（Rd${target.rd}）への再燃は不正 — ` +
          '同一ラウンド内の重複は再燃ではない（dup_in_round — 先行行の側で処置される）')
        continue
      }
    }
    // 反証済み確定の巻き戻し禁止 — 同値の再指定（冪等な再実行）だけを許す
    if (row.cells[4] === '反証破棄' && action !== '反証破棄') {
      errors.push(`rows[${i}]: ${r.id} は反証破棄で確定済み — 「${action}」への上書きは不可（再指摘は新規行として追記する）`)
    }
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(e)
    console.error('台帳は変更していない（部分適用なし）')
    process.exit(2)
  }

  const escapeCell = (s: unknown): string =>
    String(s ?? '').replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim()

  const report: string[] = []
  let changed = 0
  for (const r of rowsInput) {
    const row = byId.get(r.id)!
    const newAction = escapeCell(r.action)
    const newReason = r.reason === undefined ? row.cells[5] : escapeCell(r.reason)
    if (row.cells[4] === newAction && row.cells[5] === newReason) {
      report.push(`[updated] id=${r.id} status=unchanged`)
      continue
    }
    row.cells[4] = newAction
    row.cells[5] = newReason
    lines[row.lineIdx] = `| ${row.cells.map(escapeCell).join(' | ')} |`
    changed++
    report.push(`[updated] id=${r.id} status=changed`)
  }

  if (changed > 0) writeFileSync(ledgerPath, lines.join('\n'))

  console.log(`# 台帳処置更新 — ${ledgerPath}`)
  console.log(`更新 ${changed} 件 / 変更なし ${rowsInput.length - changed} 件`)
  for (const line of report) console.log(line)
  process.exit(0)
}
