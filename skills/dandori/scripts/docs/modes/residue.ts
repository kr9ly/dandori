/**
 * residue モード — dandori-strip のプロセス言及残存検査:
 *   gate 通過後のストリップで、フィーチャーのファイルからプロセス由来の言及が
 *   除去しきれたかを機械確認する。`dandori-ok:` を含む行は裁定済みの機能的依存として
 *   除外する（その行自身と**直後の 1 行** — コメント行にマーカーを置き、次行のパス参照等を
 *   守る形を許す。2 行以上に及ぶ参照は各行にマーカーが必要）。
 *   RS1. B-ID トークン残存 — テスト名・コメント中の B-数字 トークン
 *   RS2. dandori 言及残存 — dandori の文字列（.dandori/ パス参照を含む）
 *   RS3. プロセス語彙残存 — レビュー指摘 ID（R-n / C-n / F-n）・工程ドキュメント参照
 *        （design.md / spec.md / plan.md / trace.md / sketch.md / review-ledger）・
 *        地雷リスト参照・軸対応・spec §n（get-cart 初回クローズで手動掃除 21 件が
 *        検出網の外だった実績からの拡充）。V1 等の状態変数 ID はハイフンなしの
 *        英数字列で誤検出（V8 エンジン・バージョン表記）が多いため対象外 — 目視で拾う
 *   対象は今回のフィーチャーが触れたファイルに限ること（並行フィーチャーの B-ID は現役）
 */

import { join, readFileSync } from '../env.ts'
import { findings, finishReport } from '../report.ts'
import { B_TOKEN_RE, normalizeBIdToken, walkFiles } from '../scan.ts'
import { USAGE } from '../usage.ts'

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }


export function run(argvRest: string[]): void {
  const roots = argvRest.slice(1)
  if (roots.length === 0 || roots.some(p => p.startsWith('--'))) { console.error(USAGE); process.exit(2) }

  // RS3: プロセス語彙のパターン集。V1 等のハイフンなし状態変数 ID は誤検出が多く対象外（ヘッダ参照）
  const RS3_PATTERNS: Array<{ re: RegExp; label: string }> = [
    { re: /(?<![\w-])[RCF]-\d+(?![\w-])/, label: 'レビュー指摘 ID（R-n / C-n / F-n）' },
    { re: /(?:design|spec|plan|trace|sketch)\.md|review-ledger/, label: '工程ドキュメント参照' },
    { re: /地雷(?:\s*\d+|リスト)/, label: '地雷リスト参照' },
    { re: /軸対応/, label: '状態モデル軸対応の語彙' },
    { re: /spec\s*§/, label: 'spec セクション参照' },
  ]

  let scannedFiles = 0
  let exemptLines = 0
  for (const root of roots) {
    walkFiles(root, (path) => {
      let text: string
      try { text = readFileSync(path, 'utf-8') } catch { return }
      if (text.includes('\u0000')) return // バイナリ
      scannedFiles++
      let exemptNext = false
      text.split('\n').forEach((line, idx) => {
        // dandori-ok: <理由> の行は裁定済みの機能的依存 — その行と直後の 1 行を除外
        // （マーカー自身も dandori を含む。コメント行にマーカー、次行に守りたい参照、の形を許す）
        if (line.includes('dandori-ok:')) { exemptLines++; exemptNext = true; return }
        if (exemptNext) { exemptLines++; exemptNext = false; return }
        const loc = `${path}:${idx + 1}`
        for (const raw of line.match(B_TOKEN_RE) ?? []) {
          const id = normalizeBIdToken(raw)
          if (id === null) continue
          findings.push({
            check: 'RS1:B-IDトークン残存',
            detail: `${id} が残っている: ${loc} — テスト名・コメントから剥がすか、機能的依存なら dandori-ok: で裁定を記録する`,
          })
        }
        if (/dandori/i.test(line)) {
          findings.push({
            check: 'RS2:dandori言及残存',
            detail: `${loc}: ${line.trim().slice(0, 80)}`,
          })
        }
        for (const { re, label } of RS3_PATTERNS) {
          if (re.test(line)) {
            findings.push({
              check: 'RS3:プロセス語彙残存',
              detail: `${label}: ${loc} — 自然文に書き換えるか、機能的依存なら dandori-ok: で裁定を記録する: ${line.trim().slice(0, 60)}`,
            })
          }
        }
      })
    })
  }

  console.log(`# プロセス言及残存検査 — ${roots.join(', ')}`)
  console.log(`走査 ${scannedFiles} ファイル / dandori-ok 除外 ${exemptLines} 行`)
  console.log('')
  finishReport()
}
