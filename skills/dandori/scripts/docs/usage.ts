/**
 * CLI の usage 文。エントリと各モード（引数不足の報告）が共有する。
 * モードを追加したらここと dandori-docs.ts の RUNNERS の両方に足す。
 */

export const USAGE =
  'usage: node dandori-docs.ts spec <spec.md> [--baseline <旧spec.md>]\n' +
  '       node dandori-docs.ts plan <spec.md> <plan.md>\n' +
  '       node dandori-docs.ts design <spec.md> <design.md>\n' +
  '       node dandori-docs.ts outline <spec.md> <design.md> <outline.md>\n' +
  '       node dandori-docs.ts trace <spec.md> <テストのディレクトリ|ファイル...> [--revision <n>] [--scope <優先ディレクトリ>...]\n' +
  '       node dandori-docs.ts ledger <review-ledger.md> [--mark-zero-round <R|C> <rd|auto>]\n' +
  '       node dandori-docs.ts ledger-append <review-ledger.md> --prefix <R|C|F> --rd <n> (--rows <json> | --rows-stdin)\n' +
  '       node dandori-docs.ts ledger-update <review-ledger.md> (--rows <json> | --rows-stdin)\n' +
  '       node dandori-docs.ts map <mapファイル.md...> [--root <ソースルート>]\n' +
  '       node dandori-docs.ts state <state.yaml>\n' +
  '       node dandori-docs.ts residue <ファイル|ディレクトリ...>'
