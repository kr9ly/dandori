/**
 * Node API の集約。@types/node を入れずに素実行するため、必要な関数だけを
 * 手書きの型で受け取る。process の型宣言もここ 1 箇所に閉じる。
 *
 * 静的 import で書く（top-level await は ESM 専用構文 — tsx 等が CJS と判定した環境で
 * SyntaxError になる実戦観測 2026-07-22。静的 import は CJS 変換でも ESM でも動く）
 */

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
import * as _fs from 'node:fs'
// @ts-ignore -- 同上
import * as _path from 'node:path'
// @ts-ignore -- 同上
import * as _cp from 'node:child_process'

export const { readFileSync, readdirSync, statSync, appendFileSync } = _fs as {
  readFileSync(path: string, enc: string): string
  readdirSync(path: string): string[]
  statSync(path: string): { isDirectory(): boolean; size: number }
  appendFileSync(path: string, data: string): void
}
export const { join, dirname, resolve } = _path as {
  join(...p: string[]): string
  dirname(p: string): string
  resolve(...p: string[]): string
}
export const { execFileSync } = _cp as {
  execFileSync(cmd: string, args: string[], opts: { cwd: string; encoding: string; stdio: unknown[] }): string
}
