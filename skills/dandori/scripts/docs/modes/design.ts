/**
 * design モード — design.md の形式検査と spec.md との B 行対応突合:
 *   D1. 必須セクション欠落 — 土台 / 改変箇所 / 新規実装 / 不変条件 /
 *       リスクランキング / 発見ログ（見出しの（）補足は無視して前方一致）
 *   D2. 検証マーク — 土台の各エントリに [実行検証済] / [読解のみ] が付いているか。
 *       [実行検証済] は再実行可能な証拠形式（バッククォートのコマンド併記）を要求。
 *       エントリはインデントされた継続行を含めて 1 エントリとして読む。### サブ見出しに
 *       マークを付けたグループ（配下のエントリ群にまとめて適用）も認める
 *   D3. B 行参照整合 — 土台/改変箇所/新規実装が参照する B-ID の幽霊・削除済み検出
 *   D4. 未対応 B 行 — spec の B 行が土台/改変/新規のどこにも対応しない
 *       （spec か調査のどちらかに穴 — ground の完了条件）
 *   D5. 軸対応 — spec に状態モデルがあるとき、## 軸対応 節が全軸を判定語彙
 *       （[1箇所] / [散在: 理由] / ⚠）つきでカバーしているか。軸キーの typo・
 *       1 軸複数エントリ・理由なし [散在] も検出（モデル自体の検査は
 *       check-state-model.ts の管轄 — ここでは axes のキーだけ読む）
 */

import { fail, findings, finishReport, readLines } from '../report.ts'
import { B_REF_RE, expandRange, parseSpec, resolveBIdRefs, stripStruck } from '../spec-parse.ts'
import { USAGE } from '../usage.ts'

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }


export function run(argvRest: string[]): void {
  const paths = argvRest.slice(1)
  if (paths.length !== 2 || paths.some(p => p.startsWith('--'))) { console.error(USAGE); process.exit(2) }
  const [specPath, designPath] = paths
  const specLines = readLines(specPath, 'spec')
  const spec = parseSpec(specLines, specPath)
  const designLines = readLines(designPath, 'design')

  const specIds = new Set(spec.bs.flatMap(b => expandRange(b.id)))
  const struckIds = new Set(spec.bs.filter(b => b.struck).flatMap(b => expandRange(b.id)))

  // design.md のセクション走査。見出しの（）補足（例: 土台（利用する既存実装））は無視して
  // 前方一致で正準セクション名に正規化する
  function normalizeSection(name: string): string {
    return name.split(/[（(]/)[0].trim()
  }
  interface DesignEntry { text: string; line: number; groupMarked: boolean }
  const sections = new Map<string, DesignEntry[]>()
  const sectionLines = new Map<string, number>()
  const MARK_RE = /\[(実行検証済|読解のみ)([:：]?)\s*([^\]]*)\]/
  let curSec: string | null = null
  // ### サブ見出しに検証マークを付けて配下のエントリ群にまとめて適用するイディオム
  // （例: ### DB leaf（[実行検証済: `npx vp test run src/db/` 472 PASS]））
  let curGroupMarked = false
  let lastEntry: DesignEntry | null = null
  let inFence = false
  designLines.forEach((line, idx) => {
    if (/^```/.test(line.trim())) { inFence = !inFence; return }
    if (inFence) return
    const sec = line.match(/^##\s+(.+?)\s*$/)
    if (sec) {
      curSec = normalizeSection(sec[1])
      curGroupMarked = false
      lastEntry = null
      if (sections.has(curSec)) {
        findings.push({
          check: 'D1:必須セクション',
          detail: `## ${curSec} が複数ある（L${sectionLines.get(curSec)} と L${idx + 1}）`,
        })
      } else {
        sections.set(curSec, [])
        sectionLines.set(curSec, idx + 1)
      }
      return
    }
    const sub = line.match(/^###+\s+(.+?)\s*$/)
    if (sub) {
      lastEntry = null
      const gm = sub[1].match(MARK_RE)
      curGroupMarked = gm !== null
      if (gm && gm[1] === '実行検証済' && (gm[3].trim() === '' || !gm[3].includes('`'))) {
        findings.push({
          check: 'D2:検証マーク',
          detail: `グループ見出し (L${idx + 1}) の [実行検証済] に再実行可能な証拠がない — ` +
            `実行コマンドをバッククォートで併記する`,
        })
      }
      return
    }
    // エントリはトップレベルの箇条書き（`- ` / `1. ` 番号付きも可）。
    // インデントされた継続行（ネスト含む）は本体に連結する
    if (curSec && /^(?:- |\d+\. )/.test(line)) {
      lastEntry = { text: line, line: idx + 1, groupMarked: curGroupMarked }
      sections.get(curSec)!.push(lastEntry)
      return
    }
    if (lastEntry && /^\s+\S/.test(line)) lastEntry.text += ' ' + line.trim()
  })
  if (inFence) fail(`${designPath}: fenced block が閉じていない`)

  // D1: 必須セクション欠落
  const REQUIRED = ['土台', '改変箇所', '新規実装', '不変条件', 'リスクランキング', '発見ログ']
  for (const name of REQUIRED) {
    if (!sections.has(name)) {
      findings.push({ check: 'D1:必須セクション', detail: `## ${name} がない（正準定義 — 空でも見出しは置く）` })
    }
  }

  // D2: 土台エントリの検証マーク（グループ見出しのマークを継承しているエントリは免除）
  for (const e of sections.get('土台') ?? []) {
    const mark = e.text.match(MARK_RE)
    if (!mark) {
      if (!e.groupMarked) {
        findings.push({
          check: 'D2:検証マーク',
          detail: `土台エントリ (L${e.line}) に [実行検証済] / [読解のみ] マークがない: ${e.text.slice(0, 60)}`,
        })
      }
      continue
    }
    if (mark[1] === '実行検証済') {
      const payload = mark[3].trim()
      if (payload === '' || !payload.includes('`')) {
        findings.push({
          check: 'D2:検証マーク',
          detail: `土台エントリ (L${e.line}) の [実行検証済] に再実行可能な証拠がない — ` +
            `実行コマンドをバッククォートで併記する（例: [実行検証済: \`npm test -- xx\` 12 passed — 観測要点]）`,
        })
      }
    }
  }

  // D3 / D4: B 行参照の突合（土台・改変箇所・新規実装が参照源）
  const refSections = ['土台', '改変箇所', '新規実装']
  const referenced = new Set<string>()
  for (const secName of refSections) {
    for (const e of sections.get(secName) ?? []) {
      for (const tok of stripStruck(e.text).match(B_REF_RE) ?? []) {
        for (const id of resolveBIdRefs(tok, specIds)) {
          referenced.add(id)
          if (!specIds.has(id)) {
            findings.push({
              check: 'D3:B行参照整合',
              detail: `${secName} (L${e.line}) が参照する ${id} が spec にない — typo か spec の陳腐化`,
            })
          } else if (struckIds.has(id)) {
            findings.push({
              check: 'D3:B行参照整合',
              detail: `${secName} (L${e.line}) が削除済み（取り消し線）の ${id} を参照している`,
            })
          }
        }
      }
    }
  }
  for (const b of spec.bs.filter(b => !b.struck)) {
    for (const id of expandRange(b.id)) {
      if (!referenced.has(id)) {
        findings.push({
          check: 'D4:未対応B行',
          detail: `${id}（${b.title}）が土台/改変箇所/新規実装のどこにも対応していない — spec か調査のどちらかに穴`,
        })
      }
    }
  }

  // D5: 軸対応 — spec に状態モデルがあるとき、全軸がコード構造に対応付いているか
  const axisKeys: string[] = []
  {
    let inModel = false
    let inAxes = false
    for (const line of specLines) {
      if (!inModel) {
        if (/^```dandori-state-model\s*$/.test(line.trim())) inModel = true
        continue
      }
      if (/^```\s*$/.test(line.trim())) break
      if (/^axes:\s*$/.test(line)) { inAxes = true; continue }
      if (/^\S/.test(line)) { inAxes = false; continue } // 次のトップレベルキー
      if (inAxes) {
        const m = line.match(/^  ([A-Za-z_]\w*):\s*(\{.*\})?\s*$/)
        if (m) axisKeys.push(m[1])
      }
    }
  }
  const axisEntries = sections.get('軸対応')
  if (axisKeys.length > 0) {
    if (!axisEntries) {
      findings.push({
        check: 'D5:軸対応',
        detail: 'spec に状態モデルがあるのに ## 軸対応 がない（正準定義 — 全軸をコード構造に接地する）',
      })
    } else {
      const covered = new Map<string, number>() // 軸キー → エントリ行
      for (const e of axisEntries) {
        const head = e.text.match(/^- ([^:：[]+)[:：]/)
        if (!head) {
          findings.push({
            check: 'D5:軸対応',
            detail: `軸対応エントリ (L${e.line}) が「- <軸キー>: ...」形式でない: ${e.text.slice(0, 60)}`,
          })
          continue
        }
        const keys = head[1].split(/[,、]/).map(s => s.trim()).filter(Boolean)
        for (const k of keys) {
          if (!axisKeys.includes(k)) {
            findings.push({
              check: 'D5:軸対応',
              detail: `軸対応 (L${e.line}) の軸キー「${k}」が状態モデルにない — typo かモデルの陳腐化`,
            })
          } else if (covered.has(k)) {
            findings.push({
              check: 'D5:軸対応',
              detail: `軸「${k}」の対応が複数エントリにある（L${covered.get(k)} と L${e.line}）— 1 軸 1 エントリ`,
            })
          } else {
            covered.set(k, e.line)
          }
        }
        const verdict = e.text.match(/\[1箇所\]|\[散在[:：]([^\]]*)\]|\[散在\]|⚠/)
        if (!verdict) {
          findings.push({
            check: 'D5:軸対応',
            detail: `軸対応 (L${e.line}) に判定（[1箇所] / [散在: 理由] / ⚠）がない`,
          })
        } else if (verdict[0].startsWith('[散在') && !(verdict[1] ?? '').trim()) {
          findings.push({
            check: 'D5:軸対応',
            detail: `軸対応 (L${e.line}) の [散在] に理由がない — dependent 宣言等の相互作用根拠を書く（書けないなら ⚠ + 行き先）`,
          })
        }
      }
      for (const k of axisKeys) {
        if (!covered.has(k)) {
          findings.push({
            check: 'D5:軸対応',
            detail: `軸「${k}」が軸対応節にない — 全軸の対応をコード構造に接地する（散在なら理由つきで）`,
          })
        }
      }
    }
  }

  console.log(`# design 検査レポート — ${specPath} ↔ ${designPath}`)
  console.log(`セクション ${sections.size} / 土台エントリ ${(sections.get('土台') ?? []).length}` +
    ` / B 行参照 ${referenced.size}` +
    (axisKeys.length > 0 ? ` / 状態モデル軸 ${axisKeys.length}（軸対応エントリ ${(axisEntries ?? []).length}）` : ''))
  console.log('')
  finishReport()
}
