/**
 * state モード — state.yaml の整合検査（ルーターの再開判定の足場）:
 *   Y1. 語彙・形式 — course / phase / 各工程 status の語彙、数値フィールド、
 *       updated の日付形式、revision（2 以上の整数 — 継続改善サイクル）、未知のキー
 *   Y2. feature 一致 — feature がフィーチャーディレクトリ名と一致するか
 *   Y3. フェーズ整合 — phase が phases_done と矛盾しない / 短縮コースに存在しない
 *       工程が記録されていない / 完了済み工程の status・カウンタが完了状態か
 *       （例: phases_done に impl があるのに milestones_done < total）/
 *       annotate は gate 通過後のみ / strip は annotate 完了後のみ /
 *       feedback / cleanup は strip 完了後のみ / done は cleanup 完了後のみ
 *   Y4. 成果物整合 — フェーズが前提とするドキュメント（spec.md / design.md / plan.md /
 *       review-ledger.md）の存在。phase: done では逆に使い捨てドキュメントの処分漏れを
 *       検出する（アーカイブ方針で意図的に残す場合は無視してよい）。
 *       phase: feedback は strip 後（成果物現役）と done 後の再開（処分済み）の
 *       両文脈があるため spec.md の存在だけを要求する
 */

import { dirname, join, resolve, statSync } from '../env.ts'
import { fail, findings, finishReport, readLines } from '../report.ts'
import { USAGE } from '../usage.ts'

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }


export function run(argvRest: string[]): void {
  const paths = argvRest.slice(1)
  if (paths.length !== 1 || paths[0].startsWith('--')) { console.error(USAGE); process.exit(2) }
  const statePath = paths[0]
  const lines = readLines(statePath, 'state.yaml')

  // state.yaml 用ミニパーサ（トップレベル + 1 段ネストのみ — 正準形式が要求する範囲）
  function stripComment(line: string): string {
    const i = line.search(/(^|\s)#/)
    return i === -1 ? line : line.slice(0, i)
  }
  const top: Record<string, string | Record<string, string>> = {}
  let curKey: string | null = null
  lines.forEach((raw, idx) => {
    const line = stripComment(raw)
    if (line.trim() === '') return
    const indent = line.length - line.trimStart().length
    const m = line.trim().match(/^([\w-]+):\s*(.*)$/)
    if (!m) { fail(`${statePath} L${idx + 1}: 解釈できない行: ${raw.trim()}`); return }
    const [, key, value] = m
    if (indent === 0) {
      if (value === '') { top[key] = {}; curKey = key }
      else { top[key] = value.trim(); curKey = null }
    } else if (curKey !== null && typeof top[curKey] === 'object') {
      ;(top[curKey] as Record<string, string>)[key] = value.trim()
    } else {
      fail(`${statePath} L${idx + 1}: ネストの親キーがない: ${raw.trim()}`)
    }
  })

  const FULL_ORDER = ['spec', 'sketch', 'ground', 'review', 'spike', 'plan', 'impl', 'codereview', 'refine', 'gate', 'annotate', 'strip', 'cleanup']
  const SHORT_PHASES = new Set(['spec', 'sketch', 'impl', 'codereview', 'refine', 'gate', 'annotate', 'strip', 'cleanup', 'feedback']) // sketch/codereview/refine は短縮でも任意実施可。annotate/strip/feedback は両コース共通
  // feedback は線形順序の外（done からの継続改善入口）— phases_done には入らない
  const PHASE_VOCAB = new Set([...FULL_ORDER, 'done', 'feedback'])

  const str = (v: unknown): string | null => typeof v === 'string' ? v : null
  const section = (k: string): Record<string, string> =>
    typeof top[k] === 'object' ? top[k] as Record<string, string> : {}

  // Y1: 語彙・形式
  const KNOWN_TOP = new Set(['feature', 'course', 'phase', 'phases_done', 'revision', 'sketch', 'review', 'spike', 'impl', 'codereview', 'refine', 'annotate', 'strip', 'cleanup', 'feedback', 'progress', 'updated'])
  for (const k of Object.keys(top)) {
    if (!KNOWN_TOP.has(k)) findings.push({ check: 'Y1:語彙・形式', detail: `未知のトップレベルキー: ${k}（正準定義は dandori ルーターの SKILL.md）` })
  }
  const course = str(top.course)
  if (course !== null && course !== 'full' && course !== 'short') {
    findings.push({ check: 'Y1:語彙・形式', detail: `course「${course}」は語彙外 — full / short` })
  }
  const phase = str(top.phase)
  if (phase === null) findings.push({ check: 'Y1:語彙・形式', detail: 'phase がない' })
  else if (!PHASE_VOCAB.has(phase)) findings.push({ check: 'Y1:語彙・形式', detail: `phase「${phase}」は語彙外` })
  // revision は改訂サイクルの記録 — どのフェーズでも許容（cleanup 前のループ中・done 後の再開後を通じて残る）
  const revisionRaw = str(top.revision)
  if (revisionRaw !== null && (!/^\d+$/.test(revisionRaw) || Number(revisionRaw) < 2)) {
    findings.push({ check: 'Y1:語彙・形式', detail: `revision「${revisionRaw}」が 2 以上の整数でない — 初回サイクルは書かない（dandori-feedback が 2 から採番）` })
  }
  const doneRaw = str(top.phases_done) ?? ''
  const phasesDone = doneRaw.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(s => s !== '')
  for (const p of phasesDone) {
    if (!FULL_ORDER.includes(p)) findings.push({ check: 'Y1:語彙・形式', detail: `phases_done の「${p}」は語彙外` })
  }
  const STATUS_VOCAB: Record<string, Set<string>> = {
    sketch: new Set(['pending', 'done', 'skipped']),
    review: new Set(['in_progress', 'passed', 'escalated']),
    spike: new Set(['pending', 'done', 'skipped']),
    codereview: new Set(['in_progress', 'passed', 'escalated', 'skipped']),
    refine: new Set(['pending', 'done', 'skipped']),
    annotate: new Set(['pending', 'done', 'skipped']),
    strip: new Set(['pending', 'done', 'skipped']),
    cleanup: new Set(['pending', 'done']), // クローズは省略不可 — B-ID 残置の裁定は strip.skipped 側
  }
  for (const [sec, vocab] of Object.entries(STATUS_VOCAB)) {
    const s = section(sec).status
    if (s !== undefined && !vocab.has(s)) {
      findings.push({ check: 'Y1:語彙・形式', detail: `${sec}.status「${s}」は語彙外 — ${[...vocab].join(' / ')}` })
    }
  }
  const numeric = (sec: string, key: string): number | null => {
    const v = section(sec)[key]
    if (v === undefined) return null
    if (!/^\d+$/.test(v)) {
      findings.push({ check: 'Y1:語彙・形式', detail: `${sec}.${key}「${v}」が非負整数でない` })
      return null
    }
    return Number(v)
  }
  const rounds = numeric('review', 'rounds')
  numeric('codereview', 'rounds')
  numeric('feedback', 'items')
  {
    const ts = section('feedback')['trace_scope']
    if (ts !== undefined && ts !== 'delta' && ts !== 'full') {
      findings.push({ check: 'Y1:語彙・形式', detail: `feedback.trace_scope「${ts}」は語彙外 — delta / full` })
    }
  }
  // milestones_done は整数カウンタ（逐次実装）と ID リスト（並列実装 — 完了順が
  // マイルストーン番号順と一致しない場合に必要。dandori-impl workflow.js はこちらで記録）の両形式を受理する
  const milestonesDone = (): number | null => {
    const v = section('impl')['milestones_done']
    if (v === undefined) return null
    if (/^\d+$/.test(v)) return Number(v)
    if (/^\[.*\]$/.test(v)) {
      const ids = v.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(s => s !== '')
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
      if (dup.length > 0) {
        findings.push({ check: 'Y1:語彙・形式', detail: `impl.milestones_done に重複 ID（${[...new Set(dup)].join(', ')}）` })
      }
      return new Set(ids).size
    }
    findings.push({ check: 'Y1:語彙・形式', detail: `impl.milestones_done「${v}」が非負整数でも ID リスト（[M1, M2] 形式）でもない` })
    return null
  }
  const mDone = milestonesDone()
  const mTotal = numeric('impl', 'milestones_total')
  numeric('refine', 'applied')
  numeric('refine', 'rejected')
  numeric('annotate', 'annotated')
  const updated = str(top.updated)
  if (updated !== null && !/^\d{4}-\d{2}-\d{2}$/.test(updated)) {
    findings.push({ check: 'Y1:語彙・形式', detail: `updated「${updated}」が YYYY-MM-DD 形式でない` })
  }

  // Y2: feature ↔ ディレクトリ名
  const feature = str(top.feature)
  const dirName = dirname(resolve(statePath)).split('/').pop() ?? ''
  if (feature !== null && feature !== dirName) {
    findings.push({ check: 'Y2:feature一致', detail: `feature「${feature}」がディレクトリ名「${dirName}」と一致しない` })
  }

  // Y3: フェーズ整合
  if (phase !== null && phase !== 'done' && phasesDone.includes(phase)) {
    findings.push({ check: 'Y3:フェーズ整合', detail: `phase「${phase}」が phases_done に入っている — 完了済みなら phase を次工程へ進める` })
  }
  if (phase === 'done' && !phasesDone.includes('gate')) {
    findings.push({ check: 'Y3:フェーズ整合', detail: 'phase: done なのに phases_done に gate がない — gate を通らずに done にはならない' })
  }
  if (phase === 'feedback' && !phasesDone.includes('gate')) {
    findings.push({ check: 'Y3:フェーズ整合', detail: 'phase: feedback なのに phases_done に gate がない — feedback は gate 通過後の安定点。gate を通らずに feedback にはならない' })
  }
  if (phase === 'feedback' && !phasesDone.includes('strip')) {
    findings.push({ check: 'Y3:フェーズ整合', detail: 'phase: feedback なのに phases_done に strip がない — feedback は annotate → strip を経た安定点（strip を skip した場合も phases_done には入る）' })
  }
  if (phase === 'done' && !phasesDone.includes('cleanup')) {
    findings.push({ check: 'Y3:フェーズ整合', detail: 'phase: done なのに phases_done に cleanup がない — done は cleanup（店じまい）完了後のみ。改訂待ちなら phase: feedback が正' })
  }
  if (phase === 'annotate' && !phasesDone.includes('gate')) {
    findings.push({ check: 'Y3:フェーズ整合', detail: 'phase: annotate なのに phases_done に gate がない — annotate（コメント保全）は gate 通過直後の工程' })
  }
  if (phase === 'strip' && !phasesDone.includes('annotate')) {
    findings.push({ check: 'Y3:フェーズ整合', detail: 'phase: strip なのに phases_done に annotate がない — strip（除去）の前に annotate（消える Why のコメント保全）を通す' })
  }
  if (phase === 'cleanup' && !phasesDone.includes('strip')) {
    findings.push({ check: 'Y3:フェーズ整合', detail: 'phase: cleanup なのに phases_done に strip がない — cleanup（店じまい）は annotate → strip → feedback の完全 fix 裁定後' })
  }
  // phase: feedback の間は phases_done が前サイクル（コース再判定前）の記録 — 短縮コース検査は免除
  if (course === 'short' && phase !== 'feedback') {
    for (const p of [phase, ...phasesDone]) {
      if (p !== null && p !== 'done' && !SHORT_PHASES.has(p)) {
        findings.push({ check: 'Y3:フェーズ整合', detail: `短縮コースに工程「${p}」は存在しない（spec → impl → gate — sketch / codereview / refine は任意実施のみ）` })
      }
    }
  }
  if (phasesDone.includes('impl') && mDone !== null && mTotal !== null && mDone < mTotal) {
    findings.push({ check: 'Y3:フェーズ整合', detail: `phases_done に impl があるのに milestones ${mDone}/${mTotal} — 全マイルストーン完了が impl の完了条件` })
  }
  if (mDone !== null && mTotal !== null && mDone > mTotal) {
    findings.push({ check: 'Y3:フェーズ整合', detail: `milestones_done（${mDone}）が milestones_total（${mTotal}）を超えている` })
  }
  const doneNeedsStatus: [string, string[]][] = [
    ['sketch', ['done', 'skipped']],
    ['review', ['passed', 'escalated']],
    ['spike', ['done', 'skipped']],
    ['codereview', ['passed', 'escalated', 'skipped']],
    ['refine', ['done', 'skipped']],
    ['annotate', ['done', 'skipped']],
    ['strip', ['done', 'skipped']],
    ['cleanup', ['done']],
  ]
  for (const [sec, ok] of doneNeedsStatus) {
    const s = section(sec).status
    if (phasesDone.includes(sec) && s !== undefined && !ok.includes(s)) {
      findings.push({ check: 'Y3:フェーズ整合', detail: `phases_done に ${sec} があるのに ${sec}.status が「${s}」 — 完了状態（${ok.join(' / ')}）でない` })
    }
  }
  if (rounds !== null && rounds >= 1 && phase !== null && FULL_ORDER.indexOf(phase) < FULL_ORDER.indexOf('review') && !phasesDone.includes('review')) {
    // review 実施済みなのに phase が review より前 = 逆行。逆行自体は正当だが phases_done から外した記録が必要
    findings.push({ check: 'Y3:フェーズ整合', detail: `review.rounds が ${rounds} なのに phase「${phase}」が review より前 — 逆行なら理由を design.md の発見ログに記録する（この指摘は記録済みなら無視してよい）` })
  }

  // Y4: 成果物整合
  const featureDir = dirname(resolve(statePath))
  const exists = (name: string): boolean => {
    try { statSync(join(featureDir, name)); return true } catch { return false }
  }
  if (phase === 'feedback') {
    // gate 後の安定点（成果物現役）と done 後の再開（処分済み）の両文脈があるため、
    // 成果物の存在/処分はどちらも正常 — spec.md だけを前提として要求する
    if (!exists('spec.md')) {
      findings.push({ check: 'Y4:成果物整合', detail: 'phase: feedback なのに spec.md がない — 改訂は fix 済み spec への差分として入る' })
    }
  } else if (phase !== 'done') {
    const needs: [string, string, string][] = [
      ['spec', 'spec.md', 'spec 完了の成果物'],
      ['ground', 'design.md', 'ground 完了の成果物'],
      ['plan', 'plan.md', 'plan 完了の成果物'],
      ['review', 'review-ledger.md', 'review 完了なら台帳が残っているはず'],
    ]
    for (const [p, file, why] of needs) {
      if (phasesDone.includes(p) && !exists(file)) {
        findings.push({ check: 'Y4:成果物整合', detail: `phases_done に ${p} があるのに ${file} がない（${why}）` })
      }
    }
    // sketch は skipped でも phases_done に入りうるので、status が skipped でない場合のみ成果物を要求する
    if (phasesDone.includes('sketch') && section('sketch').status !== 'skipped' && !exists('sketch.md')) {
      findings.push({ check: 'Y4:成果物整合', detail: 'phases_done に sketch があるのに sketch.md がない（sketch 完了の成果物 — skipped なら sketch.status に記録する）' })
    }
    // strip は trace.md を B 行↔テスト対応の作業リストとして使い、cleanup が処分する（処分は cleanup の最後）
    if ((phase === 'strip' || phase === 'cleanup') && !exists('trace.md')) {
      findings.push({ check: 'Y4:成果物整合', detail: `phase: ${phase} なのに trace.md がない — strip の作業リスト・cleanup の処分対象（gate は trace.md を処分しない）` })
    }
  } else {
    // 既定運用（docs/appendix-records.md）では spec.md 含む全ドキュメントを
    // 墓碑コミットで処分してクローズする — 残っていたら処分漏れの疑い
    for (const [file, hint] of [
      ['spec.md', '.dandori/records.md の retain 宣言で意図的に残すなら無視してよい'],
      ['sketch.md', 'アーカイブ方針で意図的に残すなら無視してよい'],
      ['plan.md', 'アーカイブ方針で意図的に残すなら無視してよい'],
      ['trace.md', 'アーカイブ方針で意図的に残すなら無視してよい'],
      ['review-ledger.md', 'アーカイブ方針で意図的に残すなら無視してよい'],
    ] as [string, string][]) {
      if (exists(file)) {
        findings.push({ check: 'Y4:成果物整合', detail: `phase: done なのに ${file} が残っている — クローズ手順（墓碑コミット）の処分漏れの疑い（${hint}）` })
      }
    }
  }

  console.log(`# state.yaml 整合検査レポート — ${statePath}`)
  console.log(`feature: ${feature ?? '（なし）'} / course: ${course ?? '（なし）'} / phase: ${phase ?? '（なし）'} / phases_done: [${phasesDone.join(', ')}]`)
  console.log('')
  finishReport()
}
