/**
 * outline モード — outline.md（プログラム設計）の形式検査:
 *   O1. 必須セクション欠落 — ファイル配置 / 型とシグネチャ / コールスタック /
 *       擬似コード / 論点と裁定（見出しの（）補足は無視して前方一致）
 *   O2. 未裁定の論点 — 「論点と裁定」表の裁定列が空・保留語彙のまま残っていないか
 *       （人間ゲートの素通り検出。この工程の存在理由そのもの）
 *   O3. 新規実装の有無の突合 — design.md の「新規実装」とファイル配置の新規追加
 *       （diff の `+`）が片側だけ存在するとき指摘する（outline での分割の発明 =
 *       design への還流漏れ / 新しい責務の置き場が未確定）
 *   O4. B 行参照整合 — B-ID を注記したときだけ、幽霊・削除済みを検出する
 *       （**B 行の記載自体は要求しない**）
 *
 * 検査はここまでで意図的に打ち止めてある。擬似コードの中身も、B 行の網羅も見ない。
 * この工程が扱うのは機械検査に原理的に載らない軸（可読性・再利用性・責務配置）であり、
 * 検査を厚くすると「検査が通った = 設計が良い」という誤読を招く。とくに B 行の
 * カバレッジ突合は plan モードの管轄で、ここに持ち込むと裁定の議題が
 * インターフェースの良し悪しから「抜けている仕様はないか」へ流れる。
 */

import { fail, findings, finishReport, readLines, splitCells } from '../report.ts'
import { B_REF_RE, expandRange, parseSpec, resolveBIdRefs, stripStruck } from '../spec-parse.ts'
import { USAGE } from '../usage.ts'

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }

/** 裁定列が実質空とみなす語彙（ダッシュ類と保留語） */
const PENDING_VERDICT = new Set(['', '-', '—', '–', 'ー', '未', '未定', '未裁定', '保留', 'TBD', 'tbd', '?', '？'])

export function run(argvRest: string[]): void {
  const paths = argvRest.slice(1)
  if (paths.length !== 3 || paths.some(p => p.startsWith('--'))) { console.error(USAGE); process.exit(2) }
  const [specPath, designPath, outlinePath] = paths
  const spec = parseSpec(readLines(specPath, 'spec'), specPath)
  const designLines = readLines(designPath, 'design')
  const lines = readLines(outlinePath, 'outline')

  const specIds = new Set(spec.bs.flatMap(b => expandRange(b.id)))
  const struckIds = new Set(spec.bs.filter(b => b.struck).flatMap(b => expandRange(b.id)))

  // ---- outline.md の走査 ----------------------------------------------------
  // セクションは ## 見出しで区切る。本文はフェンスの内外を区別して保持する
  // （ファイル配置の diff 行はフェンス内、論点表はフェンス外にある）
  interface Sec { name: string; line: number; body: { text: string; line: number; inFence: boolean }[] }
  const sections = new Map<string, Sec>()
  let cur: Sec | null = null
  let inFence = false
  const normalizeSection = (name: string): string => name.split(/[（(]/)[0].trim()

  lines.forEach((raw, idx) => {
    if (/^\s*```/.test(raw)) { inFence = !inFence; if (cur) cur.body.push({ text: raw, line: idx + 1, inFence: true }); return }
    if (!inFence) {
      const sec = raw.match(/^##\s+(.+?)\s*$/)
      if (sec) {
        const name = normalizeSection(sec[1])
        const existing = sections.get(name)
        if (existing) {
          findings.push({ check: 'O1:必須セクション', detail: `## ${name} が複数ある（L${existing.line} と L${idx + 1}）` })
          cur = existing
        } else {
          cur = { name, line: idx + 1, body: [] }
          sections.set(name, cur)
        }
        return
      }
    }
    if (cur) cur.body.push({ text: raw, line: idx + 1, inFence })
  })
  if (inFence) fail(`${outlinePath}: fenced block が閉じていない`)

  // O1: 必須セクション欠落
  const REQUIRED = ['ファイル配置', '型とシグネチャ', 'コールスタック', '擬似コード', '論点と裁定']
  for (const name of REQUIRED) {
    if (!sections.has(name)) {
      findings.push({ check: 'O1:必須セクション', detail: `## ${name} がない（正準定義 — 空でも見出しは置く）` })
    }
  }

  // ---- O2: 未裁定の論点 ------------------------------------------------------
  // 「| # | 論点 | 出所 | 裁定 |」形式。区切り行とヘッダ行は飛ばす
  let issueRows = 0
  let pendingRows = 0
  for (const e of sections.get('論点と裁定')?.body ?? []) {
    if (e.inFence) continue
    const t = e.text.trim()
    if (!t.startsWith('|') || !t.endsWith('|')) continue
    const cells = splitCells(t.slice(1, -1))
    if (cells.length < 4) continue
    if (/^:?-{3,}:?$/.test(cells[0])) continue                   // 区切り行
    if (cells[0] === '#' || cells[3] === '裁定') continue         // ヘッダ行
    issueRows++
    if (PENDING_VERDICT.has(cells[3].trim())) {
      pendingRows++
      findings.push({
        check: 'O2:未裁定の論点',
        detail: `論点 ${cells[0] || `(L${e.line})`} の裁定が空 — 裁定を残して plan へ進むと、その判断が実装後のコードレビューに繰り越される`,
      })
    }
  }

  // ---- O3: 新規実装の有無の突合 ----------------------------------------------
  // 突合は**存在レベル**に留める。パス名と design のエントリ名を文字列照合する案は
  // 採らなかった — design の新規実装は「一覧ハンドラ: 確定済み注文を返す」のように
  // 日本語の責務名で書かれるのが正準形式であり、英語のファイル名と照合すると
  // 常時誤検出になる。誤検出の出るチェッカーはこの工程で最も有害
  // （人間の裁定が「またこれか」で流されるようになると工程ごと形骸化する）
  const addedFiles: string[] = []
  for (const e of sections.get('ファイル配置')?.body ?? []) {
    if (!e.inFence) continue
    const m = e.text.match(/^\+\s*(\S+)/)
    if (!m) continue
    const raw = m[1].split('#')[0].trim()
    if (raw === '' || raw.endsWith('/')) continue   // ディレクトリ行は突合対象外
    addedFiles.push(raw)
  }
  const designHasNewImpl = (() => {
    let inSec = false
    for (const line of designLines) {
      const h = line.match(/^##\s+(.+?)\s*$/)
      if (h) { inSec = h[1].split(/[（(]/)[0].trim() === '新規実装'; continue }
      if (inSec && /^(?:- |\d+\. )/.test(line)) return true
    }
    return false
  })()
  if (sections.has('ファイル配置')) {
    if (addedFiles.length > 0 && !designHasNewImpl) {
      findings.push({
        check: 'O3:design突合',
        detail: `新規ファイル ${addedFiles.length} 件（${addedFiles.join(', ')}）を追加するのに design.md の「新規実装」が空 — ` +
          `outline での分割の発明。design へ還流する（design は上位の記述なので、下で決めた配置で古くなる）`,
      })
    }
    if (addedFiles.length === 0 && designHasNewImpl) {
      findings.push({
        check: 'O3:design突合',
        detail: 'design.md に「新規実装」のエントリがあるのに、ファイル配置に新規追加（diff の `+`）が1件もない — ' +
          '新しい責務をどこに置くかがこの工程で確定していない',
      })
    }
  }

  // ---- O4: B 行参照整合（注記されている場合のみ） -----------------------------
  let bRefs = 0
  for (const sec of sections.values()) {
    for (const e of sec.body) {
      for (const tok of stripStruck(e.text).match(B_REF_RE) ?? []) {
        for (const id of resolveBIdRefs(tok, specIds)) {
          bRefs++
          if (!specIds.has(id)) {
            findings.push({ check: 'O4:B行参照整合', detail: `${sec.name} (L${e.line}) が参照する ${id} が spec にない — typo か spec の陳腐化` })
          } else if (struckIds.has(id)) {
            findings.push({ check: 'O4:B行参照整合', detail: `${sec.name} (L${e.line}) が削除済み（取り消し線）の ${id} を参照している` })
          }
        }
      }
    }
  }

  console.log(`# outline 検査レポート — ${outlinePath}（design: ${designPath}）`)
  console.log(`セクション ${sections.size} / 論点 ${issueRows}（未裁定 ${pendingRows}）` +
    ` / 新規ファイル ${addedFiles.length} / B 行注記 ${bRefs}`)
  console.log('')
  finishReport()
}
