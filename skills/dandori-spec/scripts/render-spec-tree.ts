/**
 * spec ツリーレンダラー — spec.md の全 B 行を「基準シナリオの分岐の先の想定挙動」
 * として1枚の Mermaid フローチャートに導出する。
 *
 * 用途: spec fix 前の全体確認（人間が葉 = B 行を全部なぞって承認する）、
 *       gate のトレース前の全体把握。出力は生成物であり手編集しない。
 *
 * usage: node render-spec-tree.ts <spec.md> > <出力.md>
 *
 * 背骨は状態モデルの任意セクション `flow:` から取る:
 *   flow:
 *     - { step: "割引適用・金額計算", axes: [coupon, promo], ask: "割引は？" }
 * flow が無い spec では軸の宣言順に1軸=1ステップで退化描画する。
 *
 * 注: パーサ部は check-state-model.ts のコピー（チェッカーが正）。
 *     モデル形式を変更するときは両方を更新すること。
 *     このスクリプトは検証をしない — チェッカーグリーンの spec を入力にする前提。
 */

export {} // モジュール化 — 同ディレクトリの check-state-model.ts とグローバルスコープを衝突させない

declare const process: { argv: string[]; exit(code: number): never }

// ---- 型（check-state-model.ts と同一 + flow） ----------------------------------

interface AxisValue { id: string; note?: string }
interface Axis {
  id: string
  label: string
  base: string
  baseInferred: boolean
  perItem: boolean
  values: AxisValue[]
}
interface Observation { id: string; of: string[]; note?: string }
interface Modifier { id: string; affects: string[]; note?: string }
interface DependentDecl { cells: Record<string, CellSpec>; note: string }
interface OnlyConstraint { axis: string; value: string; requires: Record<string, string[]>; note: string }
interface Chain { from: string; to: string; note: string }
interface GroundDecl { axes: [string, string]; note: string }
interface FlowStep { step: string; ask?: string; axes: string[] }

type CellSpec = { kind: 'any' } | { kind: 'alt'; values: string[] } | { kind: 'mixed'; values: string[] }

interface Cover {
  b: string
  title: string
  excluded?: 'one-off' | 'out-of-model'
  excludedNote?: string
  cells: Record<string, CellSpec>
  extras: string[]
}

interface Model {
  axes: Axis[]
  observations: Observation[]
  modifiers: Modifier[]
  dependent: DependentDecl[]
  only: OnlyConstraint[]
  chains: Chain[]
  ground: GroundDecl[]
  flow: FlowStep[]
}

let hardErrors = 0
function fail(msg: string): void {
  console.error(`[render-error] ${msg}`)
  hardErrors++
}

// ---- YAML サブセットパーサ（check-state-model.ts からコピー） --------------------

function stripComment(line: string): string {
  let inS = false, inD = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS) inD = !inD
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

interface Ln { indent: number; text: string; no: number }

function parseYamlSubset(src: string, baseLineNo: number): unknown {
  const lns: Ln[] = []
  src.split('\n').forEach((raw, i) => {
    const line = stripComment(raw)
    if (line.trim() === '') return
    lns.push({ indent: line.length - line.trimStart().length, text: line.trim(), no: baseLineNo + i })
  })
  if (lns.length === 0) return {}
  const [value, next] = parseBlock(lns, 0)
  if (next < lns.length) fail(`L${lns[next].no}: パースできない行: ${lns[next].text}`)
  return value

  function parseBlock(ls: Ln[], pos: number): [unknown, number] {
    return ls[pos].text.startsWith('- ') || ls[pos].text === '-'
      ? parseSeqBlock(ls, pos) : parseMapBlock(ls, pos)
  }

  function parseSeqBlock(ls: Ln[], pos: number): [unknown[], number] {
    const ind = ls[pos].indent
    const items: unknown[] = []
    while (pos < ls.length && ls[pos].indent === ind && ls[pos].text.startsWith('- ')) {
      const head: Ln = { indent: ind + 2, text: ls[pos].text.slice(2).trim(), no: ls[pos].no }
      let end = pos + 1
      while (end < ls.length && ls[end].indent > ind) end++
      if (/^("[^"]*"|[^:\s{["']+):(\s|$)/.test(head.text)) {
        const sub = [head, ...ls.slice(pos + 1, end)]
        const [v, next] = parseMapBlock(sub, 0)
        if (next < sub.length) fail(`L${sub[next].no}: パースできない行: ${sub[next].text}`)
        items.push(v)
      } else {
        if (end > pos + 1) fail(`L${ls[pos + 1].no}: シーケンス項目の継続行を解釈できない: ${ls[pos + 1].text}`)
        items.push(parseFlow(head.text, head.no))
      }
      pos = end
    }
    return [items, pos]
  }

  function parseMapBlock(ls: Ln[], pos: number): [Record<string, unknown>, number] {
    const ind = ls[pos].indent
    const map: Record<string, unknown> = {}
    while (pos < ls.length && ls[pos].indent === ind && !ls[pos].text.startsWith('- ')) {
      const m = ls[pos].text.match(/^("[^"]*"|[^:\s]+):(?:\s+(.*))?$/)
      if (!m) { fail(`L${ls[pos].no}: マップ行として解釈できない: ${ls[pos].text}`); pos++; continue }
      const key = m[1].replace(/^"|"$/g, '')
      const rest = m[2]?.trim()
      if (rest) {
        map[key] = parseFlow(rest, ls[pos].no)
        pos++
      } else {
        pos++
        if (pos < ls.length && ls[pos].indent > ind) {
          const [v, next] = parseBlock(ls, pos)
          map[key] = v
          pos = next
        } else {
          fail(`L${ls[pos - 1].no}: キー ${key} の値が空`)
          map[key] = null
        }
      }
    }
    return [map, pos]
  }

  function parseFlow(s: string, no: number): unknown {
    let i = 0
    const value = parseValue()
    skipWs()
    if (i < s.length) fail(`L${no}: フロー値の末尾に余分な文字: ${s.slice(i)}`)
    return value

    function skipWs(): void { while (i < s.length && /\s/.test(s[i])) i++ }

    function parseValue(): unknown {
      skipWs()
      const c = s[i]
      if (c === '{') return parseFlowMap()
      if (c === '[') return parseFlowSeq()
      if (c === '"' || c === "'") return parseQuoted()
      const t = parsePlain(/[,\]}]/)
      if (t === 'true') return true
      if (t === 'false') return false
      return t
    }

    function parseFlowMap(): Record<string, unknown> {
      i++
      const map: Record<string, unknown> = {}
      skipWs()
      if (s[i] === '}') { i++; return map }
      for (;;) {
        skipWs()
        const key = (s[i] === '"' || s[i] === "'") ? parseQuoted() : parsePlain(/[:]/)
        skipWs()
        if (s[i] !== ':') { fail(`L${no}: フローマップのキー ${key} の後に : がない`); return map }
        i++
        map[key] = parseValue()
        skipWs()
        if (s[i] === ',') { i++; continue }
        if (s[i] === '}') { i++; return map }
        fail(`L${no}: フローマップが閉じていない`)
        return map
      }
    }

    function parseFlowSeq(): unknown[] {
      i++
      const items: unknown[] = []
      skipWs()
      if (s[i] === ']') { i++; return items }
      for (;;) {
        items.push(parseValue())
        skipWs()
        if (s[i] === ',') { i++; continue }
        if (s[i] === ']') { i++; return items }
        fail(`L${no}: フローシーケンスが閉じていない`)
        return items
      }
    }

    function parseQuoted(): string {
      const q = s[i]
      i++
      let out = ''
      while (i < s.length && s[i] !== q) {
        if (q === '"' && s[i] === '\\' && i + 1 < s.length) { out += s[i + 1]; i += 2; continue }
        out += s[i]
        i++
      }
      if (s[i] !== q) fail(`L${no}: 引用符が閉じていない`)
      i++
      return out
    }

    function parsePlain(stop: RegExp): string {
      let out = ''
      while (i < s.length && !stop.test(s[i])) { out += s[i]; i++ }
      return out.trim()
    }
  }
}

// ---- 入力 ----------------------------------------------------------------------

const specPath = process.argv[2]
if (!specPath) {
  console.error('usage: node render-spec-tree.ts <spec.md>')
  process.exit(2)
}

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
const { readFileSync } = await import('node:fs') as { readFileSync(p: string, e: string): string }

let specLines: string[]
try {
  specLines = readFileSync(specPath, 'utf-8').split('\n')
} catch {
  console.error(`ファイルを読めない: ${specPath}`)
  process.exit(2)
}

function extractBlock(lines: string[], info: string): { body: string; startLine: number } | null {
  const blocks: { body: string; startLine: number }[] = []
  let cur: { start: number; lines: string[] } | null = null
  const open = new RegExp(`^\`\`\`${info}\\s*$`)
  lines.forEach((line, idx) => {
    if (cur === null && open.test(line.trim())) {
      cur = { start: idx + 2, lines: [] }
    } else if (cur !== null && /^```\s*$/.test(line.trim())) {
      blocks.push({ body: cur.lines.join('\n'), startLine: cur.start })
      cur = null
    } else if (cur !== null) {
      cur.lines.push(line)
    }
  })
  if (blocks.length === 0) return null
  return blocks[0]
}

const block = extractBlock(specLines, 'dandori-state-model')
if (block === null) {
  console.error(`${specPath}: dandori-state-model ブロックが見つからない`)
  process.exit(2)
}

// ---- モデル構築（検証なしの寛容版 — チェッカーグリーン前提） ----------------------

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}
}
function asArray(v: unknown): unknown[] { return Array.isArray(v) ? v : [] }
function asString(v: unknown): string { return typeof v === 'string' ? v : '' }
function asStringArray(v: unknown): string[] { return asArray(v).map(asString).filter(s => s !== '') }

function parseCellSpec(v: unknown): CellSpec {
  const s = asString(v)
  if (s === '*') return { kind: 'any' }
  if (s.includes('+')) return { kind: 'mixed', values: s.split('+').map(x => x.trim()) }
  return { kind: 'alt', values: s.split('|').map(x => x.trim()) }
}

function buildModel(raw: unknown): Model {
  const r = asRecord(raw)
  const axes: Axis[] = Object.entries(asRecord(r.axes)).map(([id, def]) => {
    const d = asRecord(def)
    const rawBase = asString(d.base)
    const baseInferred = rawBase.endsWith('?')
    const values: AxisValue[] = asArray(d.values).map(v => {
      if (typeof v === 'string') return { id: v }
      const vr = asRecord(v)
      return { id: asString(vr.id), note: typeof vr.note === 'string' ? vr.note : undefined }
    })
    return {
      id,
      label: typeof d.label === 'string' ? d.label : id,
      base: baseInferred ? rawBase.slice(0, -1) : rawBase,
      baseInferred,
      perItem: d.per_item === true,
      values,
    }
  })
  const observations: Observation[] = Object.entries(asRecord(r.observations)).map(([id, def]) => {
    const d = asRecord(def)
    return { id, of: asStringArray(d.of), note: typeof d.note === 'string' ? d.note : undefined }
  })
  const modifiers: Modifier[] = Object.entries(asRecord(r.modifiers)).map(([id, def]) => {
    const d = asRecord(def)
    return { id, affects: asStringArray(d.affects), note: typeof d.note === 'string' ? d.note : undefined }
  })
  const dependent: DependentDecl[] = asArray(r.dependent).map(o => {
    const d = asRecord(o)
    const cells = Object.fromEntries(
      Object.entries(asRecord(d.cells)).map(([axis, v]) => [axis, parseCellSpec(v)]))
    return { cells, note: asString(d.note) }
  })
  const only: OnlyConstraint[] = asArray(r.only).map(o => {
    const d = asRecord(o)
    return {
      axis: asString(d.axis),
      value: asString(d.value),
      requires: Object.fromEntries(
        Object.entries(asRecord(d.requires)).map(([axis, v]) =>
          [axis, Array.isArray(v) ? asStringArray(v) : [asString(v)]])),
      note: asString(d.note),
    }
  })
  const chains: Chain[] = asArray(r.chains).map(o => {
    const d = asRecord(o)
    return { from: asString(d.from), to: asString(d.to), note: asString(d.note) }
  })
  const ground: GroundDecl[] = asArray(r.ground).map(o => {
    const d = asRecord(o)
    const pair = asStringArray(d.axes)
    return { axes: [pair[0] ?? '', pair[1] ?? ''], note: asString(d.note) }
  })
  const flow: FlowStep[] = asArray(r.flow).map(o => {
    const d = asRecord(o)
    return {
      step: asString(d.step),
      ask: typeof d.ask === 'string' ? d.ask : undefined,
      axes: asStringArray(d.axes),
    }
  })
  return { axes, observations, modifiers, dependent, only, chains, ground, flow }
}

const model = buildModel(parseYamlSubset(block.body, block.startLine))
const axisById = new Map(model.axes.map(a => [a.id, a]))

// ---- B 行と Covers の抽出 -------------------------------------------------------

interface BRow { b: string; title: string; covers: string | null }

function extractBRows(lines: string[]): BRow[] {
  const rows: BRow[] = []
  let cur: BRow | null = null
  let inFence = false
  lines.forEach(line => {
    if (/^```/.test(line.trim())) { inFence = !inFence; return }
    if (inFence) return
    const heading = line.match(/^#{2,6}\s+(B-[\w.()]+(?:〜B-[\w.()]+)?)\s*[:：]\s*(.*)$/)
    if (heading) {
      cur = { b: heading[1], title: heading[2].trim(), covers: null }
      rows.push(cur)
      return
    }
    if (/^#{1,6}\s/.test(line)) { cur = null; return }
    if (cur) {
      const m = line.match(/^\s*-?\s*Covers:\s*(.+)$/)
      if (m && !cur.covers) cur.covers = m[1].trim()
    }
  })
  return rows
}

function parseCovers(row: BRow): Cover | null {
  if (!row.covers) return null
  const raw = row.covers
  const excluded = raw.match(/^(one-off|out-of-model)\s*(?:[—－(（-]\s*(.*?)\s*[)）]?)?$/)
  if (excluded) {
    return {
      b: row.b, title: row.title,
      excluded: excluded[1] as Cover['excluded'], excludedNote: excluded[2], cells: {}, extras: [],
    }
  }
  const cells: Record<string, CellSpec> = {}
  const extras: string[] = []
  for (const tok of raw.split(/\s\+\s/).map(t => t.trim()).filter(t => t !== '')) {
    if (tok === 'base') continue
    const extra = tok.match(/^(obs|mod|chain):(\S+)$/)
    if (extra) { extras.push(tok); continue }
    const cell = tok.match(/^([\w-]+)=(\S+)$/)
    if (cell) { cells[cell[1]] = parseCellSpec(cell[2]); continue }
    fail(`${row.b}: Covers トークンを解釈できない: ${tok}`)
  }
  return { b: row.b, title: row.title, cells, extras }
}

const bRows = extractBRows(specLines)
const allCovers = bRows.map(parseCovers).filter((c): c is Cover => c !== null)
const excludedCovers = allCovers.filter(c => c.excluded !== undefined)
const covers = allCovers.filter(c => c.excluded === undefined)
const noCoversRows = bRows.filter(r => r.covers === null)

// ---- 背骨の決定 -----------------------------------------------------------------

// flow が無ければ軸の宣言順に1軸=1ステップで退化
const flowSteps: FlowStep[] = model.flow.length > 0
  ? model.flow
  : model.axes.map(a => ({ step: a.label, axes: [a.id] }))

// flow に載っていない軸は末尾に補完（描画から軸が消えることはない）
{
  const anchored = new Set(flowSteps.flatMap(s => s.axes))
  for (const axis of model.axes) {
    if (!anchored.has(axis.id)) flowSteps.push({ step: axis.label, axes: [axis.id] })
  }
}

const stepIndexOfAxis = new Map<string, number>()
flowSteps.forEach((s, i) => {
  for (const ax of s.axes) {
    if (stepIndexOfAxis.has(ax)) fail(`flow: 軸 ${ax} が複数のステップに錨付けされている`)
    stepIndexOfAxis.set(ax, i)
  }
})

// ---- B 行の配置 -----------------------------------------------------------------
// 各 B 行は一度だけ置く。配置先 = Covers のセルのうち最も遅いステップの軸。

interface Leaf {
  cover: Cover
  axisId: string | null // null = 基準のみ / 観測・修飾のみ
  edgeLabel: string
}

const leavesByStep = new Map<number, Leaf[]>() // stepIndex → leaves
const trailing: Leaf[] = [] // どのステップにも置けない行（mod のみ等）
const placedAt = new Map<string, string>() // B id → node id（chain エッジ用）

function cellLabel(axisId: string, spec: CellSpec): string {
  if (spec.kind === 'any') return `${axisId}=*`
  return spec.values.join(spec.kind === 'mixed' ? '+' : '/')
}

for (const cover of covers) {
  const cellAxes = Object.keys(cover.cells).filter(a => axisById.has(a))
  if (cellAxes.length > 0) {
    const primary = cellAxes.reduce((best, a) =>
      (stepIndexOfAxis.get(a) ?? -1) > (stepIndexOfAxis.get(best) ?? -1) ? a : best)
    const idx = stepIndexOfAxis.get(primary) ?? flowSteps.length - 1
    const list = leavesByStep.get(idx) ?? []
    list.push({ cover, axisId: primary, edgeLabel: cellLabel(primary, cover.cells[primary]) })
    leavesByStep.set(idx, list)
    continue
  }
  // セルなし: obs の of 軸に置く
  const obsExtra = cover.extras.map(e => e.match(/^obs:(\S+)$/)).find(m => m)
  if (obsExtra) {
    const obs = model.observations.find(o => o.id === obsExtra[1])
    const ofAxes = (obs?.of ?? []).filter(a => stepIndexOfAxis.has(a))
    const ofAxis = ofAxes.length > 0 ? ofAxes[ofAxes.length - 1] : undefined
    if (ofAxis !== undefined) {
      const idx = stepIndexOfAxis.get(ofAxis)!
      const list = leavesByStep.get(idx) ?? []
      list.push({ cover, axisId: null, edgeLabel: '観測' })
      leavesByStep.set(idx, list)
      continue
    }
  }
  trailing.push({ cover, axisId: null, edgeLabel: cover.extras.length > 0 ? cover.extras.join(', ') : 'base' })
}

// ---- ❓ ノードの導出 -------------------------------------------------------------

interface Question { stepIndex: number; text: string }
const questions: Question[] = []

// 値カバレッジの穴（base 以外で明示カバーなし）
const explicitlyCovered = new Set<string>() // `${axis}::${value}`
for (const cover of covers) {
  for (const [axisId, spec] of Object.entries(cover.cells)) {
    if (spec.kind === 'any') continue
    for (const v of spec.values) explicitlyCovered.add(`${axisId}::${v}`)
  }
}
for (const axis of model.axes) {
  for (const v of axis.values) {
    if (v.id === axis.base) continue
    if (!explicitlyCovered.has(`${axis.id}::${v.id}`)) {
      questions.push({
        stepIndex: stepIndexOfAxis.get(axis.id) ?? flowSteps.length - 1,
        text: `${axis.id}=${v.id} をカバーする B 行なし`,
      })
    }
  }
}

// 依存交点の未カバー（チェッカー検査 2 の簡易版 — per-item 軸の any は明示言及が必要）
function cellSatisfied(cover: Cover, axisId: string, spec: CellSpec): boolean {
  const axis = axisById.get(axisId)
  const cSpec = cover.cells[axisId]
  if (spec.kind === 'any') return axis?.perItem ? cSpec !== undefined : true
  const coverValues = cSpec === undefined ? [axis?.base ?? '']
    : cSpec.kind === 'any' ? [] : cSpec.values
  if (spec.kind === 'mixed') return cSpec?.kind === 'mixed' && spec.values.every(v => cSpec.values.includes(v))
  return spec.values.some(v => coverValues.includes(v)) && (cSpec === undefined || cSpec.kind !== 'mixed')
}
for (const d of model.dependent) {
  const coveredBy = covers.find(c =>
    Object.entries(d.cells).every(([axisId, spec]) => cellSatisfied(c, axisId, spec)))
  if (coveredBy) continue
  const axesIn = Object.keys(d.cells).filter(a => stepIndexOfAxis.has(a))
  const idx = axesIn.length > 0
    ? Math.max(...axesIn.map(a => stepIndexOfAxis.get(a)!))
    : flowSteps.length - 1
  questions.push({ stepIndex: idx, text: `交点未カバー: ${d.note}` })
}

// ground 送り（ペア・base 推定）
for (const g of model.ground) {
  const axesIn = g.axes.filter(a => stepIndexOfAxis.has(a))
  const idx = axesIn.length > 0
    ? Math.max(...axesIn.map(a => stepIndexOfAxis.get(a)!))
    : flowSteps.length - 1
  questions.push({ stepIndex: idx, text: `ground 送り: ${g.note}` })
}
for (const axis of model.axes) {
  if (axis.baseInferred) {
    questions.push({
      stepIndex: stepIndexOfAxis.get(axis.id) ?? flowSteps.length - 1,
      text: `ground 送り: ${axis.id} の base=${axis.base} は推定`,
    })
  }
}

// ---- Mermaid 生成 ----------------------------------------------------------------

function sanitize(id: string): string { return id.replace(/[^A-Za-z0-9_]/g, '_') }
function esc(s: string): string {
  return s.replace(/"/g, '#quot;').replace(/[[\]{}<>|]/g, ' ').replace(/\s+/g, ' ').trim()
}
function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

const L: string[] = []
L.push('flowchart TB')

// 背骨
flowSteps.forEach((s, i) => {
  L.push(`  t${i}["${esc(s.step)}"]`)
})
for (let i = 0; i + 1 < flowSteps.length; i++) L.push(`  t${i} --> t${i + 1}`)

// only 制約の注記を B 行の葉に付けるための索引
const onlyNoteFor = new Map<string, string>() // `${axis}::${value}` → 注記
for (const o of model.only) {
  const req = Object.entries(o.requires).map(([a, vs]) => `${a}=${vs.join('|')}`).join(', ')
  onlyNoteFor.set(`${o.axis}::${o.value}`, `only: ${req}`)
}

// 葉
const brownNodes: string[] = []
const questionNodes: string[] = []
flowSteps.forEach((s, i) => {
  const leaves = leavesByStep.get(i) ?? []
  const qs = questions.filter(q => q.stepIndex === i)
  if (leaves.length === 0 && qs.length === 0) return
  const ask = s.ask ?? (s.axes.length === 1 && axisById.has(s.axes[0]) ? `${esc(axisById.get(s.axes[0])!.label)}は？` : `${esc(s.step)}の分岐は？`)
  L.push(`  c${i}{"${esc(ask)}"}`)
  L.push(`  t${i} --- c${i}`)
  leaves.forEach((leaf, j) => {
    const id = `b${i}_${j}_${sanitize(leaf.cover.b)}`
    placedAt.set(leaf.cover.b, id)
    const deltas = Object.entries(leaf.cover.cells)
      .filter(([a]) => a !== leaf.axisId)
      .map(([a, spec]) => `${a}=${cellLabel(a, spec)}`)
    const onlyNotes = leaf.axisId !== null && leaf.cover.cells[leaf.axisId] && leaf.cover.cells[leaf.axisId].kind !== 'any'
      ? (leaf.cover.cells[leaf.axisId] as { values: string[] }).values
          .map(v => onlyNoteFor.get(`${leaf.axisId}::${v}`)).filter((x): x is string => x !== undefined)
      : []
    const sub = [...deltas.map(d => `× ${d}`), ...onlyNotes]
    const label = `${leaf.cover.b}: ${esc(trunc(leaf.cover.title, 40))}${sub.length ? '<br/>（' + esc(sub.join(' / ')) + '）' : ''}`
    L.push(`  ${id}["${label}"]`)
    const dotted = leaf.edgeLabel === '観測'
    L.push(`  c${i} ${dotted ? '-.->' : '-->'}|${esc(trunc(leaf.edgeLabel, 24))}| ${id}`)
    brownNodes.push(id)
  })
  qs.forEach((q, j) => {
    const id = `q${i}_${j}`
    L.push(`  ${id}["❓ ${esc(trunc(q.text, 60))}"]`)
    L.push(`  c${i} -.-> ${id}`)
    questionNodes.push(id)
  })
})

// 末尾クラスタ（基準のみ・修飾のみの行）
if (trailing.length > 0) {
  L.push(`  tEnd["基準シナリオ・修飾"]`)
  L.push(`  t${flowSteps.length - 1} --> tEnd`)
  trailing.forEach((leaf, j) => {
    const id = `bt_${j}_${sanitize(leaf.cover.b)}`
    placedAt.set(leaf.cover.b, id)
    L.push(`  ${id}["${leaf.cover.b}: ${esc(trunc(leaf.cover.title, 40))}"]`)
    L.push(`  tEnd -->|${esc(trunc(leaf.edgeLabel, 24))}| ${id}`)
    brownNodes.push(id)
  })
}

// 連鎖: from 値をカバーする葉 → to 値をカバーする葉（見つかるものだけ）
function leafCoveringValue(valueId: string): string | null {
  const axis = model.axes.find(a => a.values.some(v => v.id === valueId))
  if (!axis) return null
  const cover = covers.find(c => {
    const spec = c.cells[axis.id]
    return spec !== undefined && spec.kind !== 'any' && spec.values.includes(valueId)
  })
  return cover ? placedAt.get(cover.b) ?? null : null
}
const chainEdges = new Set<string>()
for (const c of model.chains) {
  const fromNode = leafCoveringValue(c.from)
  for (const to of c.to.split('/')) {
    const toNode = leafCoveringValue(to.trim())
    if (fromNode && toNode && fromNode !== toNode) {
      const edge = `  ${fromNode} ==>|${esc(trunc(c.note, 20))}| ${toNode}`
      if (!chainEdges.has(edge)) { chainEdges.add(edge); L.push(edge) }
    }
  }
}

// スタイル
L.push('  classDef step stroke-width:2px')
L.push('  classDef brow stroke:#85f,stroke-width:2px')
L.push('  classDef question stroke:#d43,stroke-width:2px,stroke-dasharray:5 4')
L.push(`  class ${flowSteps.map((_, i) => `t${i}`).join(',')} step`)
if (brownNodes.length > 0) L.push(`  class ${brownNodes.join(',')} brow`)
if (questionNodes.length > 0) L.push(`  class ${questionNodes.join(',')} question`)

// ---- 出力 ------------------------------------------------------------------------

if (hardErrors > 0) {
  console.error(`定義エラー ${hardErrors} 件 — 出力は不完全な可能性がある`)
}

const specName = specPath.replace(/^.*\//, '')
const placed = brownNodes.length
const out: string[] = []
out.push(`# spec ツリー — ${specName}`)
out.push('')
out.push(`> 生成物 — 手編集しない。正は \`${specName}\`（B 行 + dandori-state-model ブロック）。`)
out.push(`> 再生成: \`node render-spec-tree.ts ${specName} > このファイル\``)
out.push('')
out.push('基準シナリオの流れを背骨に、分岐（軸の値）の先へ各 B 行 = 想定挙動を置いた全体図。')
out.push('紫枠 = B 行 / 赤破線 ❓ = 穴（未カバー値・未カバー交点・ground 送り）/ 太矢印 = 連鎖。')
out.push(model.flow.length === 0
  ? '（この spec には flow: が無いため、軸の宣言順で退化描画している）'
  : '')
out.push('')
out.push('```mermaid')
out.push(L.join('\n'))
out.push('```')
out.push('')
out.push(`B 行 ${bRows.length} 本: 配置 ${placed} / 除外 ${excludedCovers.length} / Covers なし ${noCoversRows.length} ・ ❓ ${questions.length} 件`)
out.push('')
if (excludedCovers.length > 0) {
  out.push('## 図の対象外（one-off / out-of-model）')
  out.push('')
  for (const c of excludedCovers) {
    out.push(`- ${c.b}: ${c.title} — \`${c.excluded}\`${c.excludedNote ? `（${c.excludedNote}）` : ''}`)
  }
  out.push('')
}
if (noCoversRows.length > 0) {
  out.push('## Covers 未記入の B 行（チェッカーで検出されるはず — 図に置けない）')
  out.push('')
  for (const r of noCoversRows) out.push(`- ${r.b}: ${r.title}`)
  out.push('')
}

console.log(out.join('\n'))

// 配置漏れの自己検査（全 B 行 = 配置 + 除外 + Covers なし）
if (placed + excludedCovers.length + noCoversRows.length !== bRows.length) {
  console.error(`[render-error] 配置検算が合わない: 配置 ${placed} + 除外 ${excludedCovers.length} + Covers なし ${noCoversRows.length} ≠ B 行 ${bRows.length}`)
  process.exit(2)
}
