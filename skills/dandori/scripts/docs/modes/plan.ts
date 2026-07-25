/**
 * plan モード — spec.md ↔ plan.md の B 行カバレッジ突合:
 *   B-ID 参照は trace と同じ帰属規則で解決する — 注記括弧つき（B-36(計算) 等。空白・
 *   全角文字で途切れたトークンを含む）は基底 ID が spec にあればそちらに帰属、
 *   数値開始でないトークン（B-ORDER 等）は参照として扱わない。design モードも同様。
 *   P1. 未カバー B 行 — spec の B 行がどのマイルストーンにも割り当てられていない
 *       （= 実装されない仕様）
 *   P2. 幽霊参照 — plan が参照する B-ID が spec に存在しない（typo か spec の陳腐化）
 *   P3. 削除済み参照 — 取り消し線つき B 行への参照
 *   P4. 空マイルストーン — 対応 B 行がゼロのマイルストーン（スコープ外の作業）
 */

import { join } from '../env.ts'
import { fail, findings, finishReport, readLines, splitCells } from '../report.ts'
import { B_REF_RE, expandRange, parseSpec, resolveBIdRefs, stripStruck } from '../spec-parse.ts'
import { USAGE } from '../usage.ts'

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }


export function run(argvRest: string[]): void {
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
    for (const tok of stripStruck(text).match(B_REF_RE) ?? []) {
      for (const id of resolveBIdRefs(tok, specIds)) {
        if (!m.refs.has(id)) m.refs.set(id, line)
      }
    }
  }

  let curM: Milestone | null = null
  let inTaioCont = false // 「- 対応:」行の直後 — インデントされた継続行（折り返し・ネスト）も参照源にする
  let inFence = false
  planLines.forEach((line, idx) => {
    if (/^```/.test(line.trim())) { inFence = !inFence; return }
    if (inFence) return
    const sec = line.match(/^##\s+(M[\w.]+)\s*[:：]/)
    if (sec) { curM = milestone(sec[1], idx + 1); inTaioCont = false; return }
    if (/^#{1,6}\s/.test(line)) { curM = null; inTaioCont = false; return }
    const cells = line.trim().match(/^\|(.+)\|$/)
    if (cells) {
      inTaioCont = false
      const parts = splitCells(cells[1])
      if (/^M[\w.]+$/.test(parts[0])) {
        collectRefs(milestone(parts[0], idx + 1), parts.slice(1).join(' '), idx + 1)
      }
      return
    }
    if (curM && /^\s*-\s*対応\s*[:：]/.test(line)) { collectRefs(curM, line, idx + 1); inTaioCont = true; return }
    if (inTaioCont && curM && /^\s+\S/.test(line)) { collectRefs(curM, line, idx + 1); return }
    inTaioCont = false
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
