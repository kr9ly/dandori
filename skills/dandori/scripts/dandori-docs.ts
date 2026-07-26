/**
 * dandori 正準ドキュメントの横断ツール。
 *
 * 各 SKILL.md の「正準定義」に対する形式検査（spec / plan / design / outline / ledger / state / map）と、
 * 決定的な生成・書き込み（trace の初期トレース表生成、ledger-append の行追記）、
 * ストリップの受け入れ検査（residue）をモード引数で切り替える。名前が check でないのは、
 * 検査だけでなく生成・追記を含むため — エージェントに任せると壊れる決定的作業をここに集める。
 *
 * 各モードの検査 ID の体系と設計判断は `docs/modes/<モード>.ts` の冒頭に置いてある。
 * 共通部品は `docs/` 直下: env（Node API）/ report（指摘と終了コード）/
 * spec-parse（spec.md のパースと B-ID 解決）/ scan（ファイル走査と B-ID トークン）。
 *
 * 状態モデル・状態マップの検査は check-state-model.ts の管轄（このツールは重複しない）。
 *
 * 実行:
 *   node dandori-docs.ts spec <spec.md>
 *   node dandori-docs.ts spec <spec.md> --baseline <旧spec.md>
 *     （fix 済み spec を再編集したとき: git show HEAD:<path> > /tmp/base.md で取り出す）
 *   node dandori-docs.ts plan <spec.md> <plan.md>
 *   node dandori-docs.ts design <spec.md> <design.md>
 *   node dandori-docs.ts outline <spec.md> <design.md> <outline.md>
 *   node dandori-docs.ts trace <spec.md> <テストのディレクトリ|ファイル...> [--revision <n>] [--scope <優先ディレクトリ>...]
 *   node dandori-docs.ts ledger <review-ledger.md> [--mark-zero-round <R|C> <rd|auto>]
 *   node dandori-docs.ts ledger-append <review-ledger.md> --prefix <R|C|F> --rd <n> --rows-stdin <<'JSON' ... JSON
 *     （--rows <json> でも渡せる。追記は決定的・冪等 — 行の書式と ID 発番はここが唯一の出所）
 *   node dandori-docs.ts map <mapファイル.md...> [--root <ソースルート>]
 *     （アンカーはソースルートの git リポジトリルート相対。--root 省略時は map の所在から導出）
 *   node dandori-docs.ts state <state.yaml>
 *   node dandori-docs.ts residue <ファイル|ディレクトリ...>
 *
 * 終了コード: 0 = 全検査グリーン / 1 = 指摘あり / 2 = パース・形式エラー
 *
 * 自己テスト: リポジトリルートで `node --test tests/*.test.mjs`（CLI 境界の回帰テスト）。
 * このツールは全工程のゲートを握るため、誤検出がそのままプロセスの空転になる — 触ったら回す。
 */

// 静的 import で書く（top-level await は ESM 専用構文 — tsx 等が CJS と判定した環境で
// SyntaxError になる実戦観測 2026-07-22。静的 import は CJS 変換でも ESM でも動く）
import { USAGE } from './docs/usage.ts'
import * as specMode from './docs/modes/spec.ts'
import * as planMode from './docs/modes/plan.ts'
import * as designMode from './docs/modes/design.ts'
import * as outlineMode from './docs/modes/outline.ts'
import * as traceMode from './docs/modes/trace.ts'
import * as ledgerMode from './docs/modes/ledger.ts'
import * as ledgerAppendMode from './docs/modes/ledger-append.ts'
import * as mapMode from './docs/modes/map.ts'
import * as stateMode from './docs/modes/state.ts'
import * as residueMode from './docs/modes/residue.ts'

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }

const RUNNERS: Record<string, (argvRest: string[]) => void> = {
  spec: specMode.run,
  plan: planMode.run,
  design: designMode.run,
  outline: outlineMode.run,
  trace: traceMode.run,
  ledger: ledgerMode.run,
  'ledger-append': ledgerAppendMode.run,
  map: mapMode.run,
  state: stateMode.run,
  residue: residueMode.run,
}


const argvRest = process.argv.slice(2)
const mode = argvRest[0]
const run = RUNNERS[mode]
if (!run) {
  console.error(USAGE)
  process.exit(2)
}

// 各モードは argvRest の index 1 以降だけを読む（index 0 はモード名）
run(argvRest)
