/**
 * ファイル走査と B-ID トークンの正規化。trace（B-ID ↔ テスト突合）と
 * residue（プロセス言及の残存検査）が共有する。
 */

import { readdirSync, statSync, join } from './env.ts'

export const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'vendor', 'target', '.dandori'])
export const SCAN_MAX_FILE_SIZE = 1024 * 1024

// B-ID トークンの grep パターン。括弧内は補足注記としてハイフンを許す
// （テストコメントの B-1(C-25): 形式 — 括弧の外にハイフンを許すと B-3-B-4 等の
// 連結表記を丸ごと 1 トークンに食ってしまうため、括弧内に限定する）
export const B_TOKEN_RE = /B-[\w.]+(?:\([\w.-]*\))?/g

/** grep トークンを B-ID に正規化する。B-ID 候補でないもの（B-ORDER 等）は null */
export function normalizeBIdToken(raw: string): string | null {
  let id = raw.replace(/\.+$/, '') // 文末ピリオド由来のゴミを除去
  // 閉じ括弧は開き括弧と釣り合わない分だけ末尾から剥がす（B-15(b) は保持、B-15) は B-15 に）
  while (id.endsWith(')') && (id.match(/\(/g) ?? []).length < (id.match(/\)/g) ?? []).length) {
    id = id.slice(0, -1)
  }
  while (id.endsWith('(')) id = id.slice(0, -1) // ID は開き括弧で終わらない
  id = id.replace(/\.+$/, '')
  // B-ID は数値開始が正準 — フィクスチャ文字列（B-ORDER 等）を候補にしない
  if (!/^B-\d/.test(id)) return null
  return id
}

export function walkFiles(path: string, onFile: (path: string) => void): void {
  let st: { isDirectory(): boolean; size: number }
  try { st = statSync(path) } catch {
    console.error(`走査対象を読めない: ${path}`)
    process.exit(2)
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (SCAN_SKIP_DIRS.has(name)) continue
      walkFiles(join(path, name), onFile)
    }
  } else if (st.size <= SCAN_MAX_FILE_SIZE) {
    onFile(path)
  }
}

