/**
 * 指摘の蓄積と終了コードの決定。全モードがこのモジュールの findings に push し、
 * 最後に finishReport() で 0（グリーン）/ 1（指摘あり）/ 2（形式エラー）を返す。
 */

import { readFileSync } from './env.ts'

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }

let hardErrors = 0
export function fail(msg: string): void {
  console.error(`[doc-error] ${msg}`)
  hardErrors++
}

export function readLines(path: string, what: string): string[] {
  try {
    return readFileSync(path, 'utf-8').split('\n')
  } catch {
    console.error(`${what}を読めない: ${path}`)
    process.exit(2)
  }
}

/**
 * Markdown テーブル行の内側をセルに分割する。セル内の `\|`（エスケープ済みパイプ —
 * 型のユニオン表記 `'a' \| 'b'` 等）は区切りとして扱わず、`|` に復元して返す
 */
export function splitCells(inner: string): string[] {
  return inner.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
}

export interface Finding { check: string; detail: string }
export const findings: Finding[] = []

export function printGroupedFindings(list: Finding[]): void {
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

export function finishReport(): never {
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
