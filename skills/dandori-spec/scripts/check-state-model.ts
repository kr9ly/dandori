/**
 * 状態モデル静的チェッカー。
 *
 * spec.md を直接パースする:
 *   - `## 状態モデル` セクションの ```dandori-state-model fenced block（機械可読モデル）
 *   - 各 B 行（`### B-N: タイトル` 見出し）直下の `- Covers:` フィールド
 *
 * 検査項目:
 *   0. Covers 欠落 — B 行見出しに Covers フィールドがない（モデルとの乖離防止）
 *   1. 値カバレッジ — 各軸の全値がいずれかの B 行にカバーされているか
 *   2. 依存交点カバレッジ — dependent 宣言の組み合わせを「単一の B 行」がカバーしているか
 *      （per-item 軸は base 省略ルール適用除外 — 明示言及を要求）
 *   3. ペア分類の全数性 — 全軸ペアが直交宣言か依存宣言のどちらかに分類されているか
 *   4. only 制約違反 — B 行の展開タプルが only 制約と矛盾しないか
 *   5. 連鎖カバレッジ — chains の各エントリにカバーする B 行があるか
 *   6. 観測・修飾カバレッジ — observations / modifiers を検証する B 行があるか
 *   7. per-item 軸の混在 — 商品単位軸の値混在（S11+S12）が宣言もカバーもされていない
 *
 * ground 送り（指摘とは別枠 — exit code に影響しない）:
 *   - `ground:` 宣言されたペア（spec 時点で直交/依存を裁定できない → ground の確認項目）。
 *     自己ペア（axes: [stock, stock]）は per-item 混在の裁定送りを表す
 *   - base の推定マーク（`base: S11?` — 基準シナリオが軸を明言していない）
 *   fix ゲートは「指摘ゼロ」で通る（ground 項目は残ってよい）。gate 工程では
 *   ground 項目の残存を要裁定として扱う — 運用は appendix-state-model.md 参照
 *
 * Covers 構文:
 *   - Covers: base                          基準シナリオそのもの
 *   - Covers: base + payment=S5             デルタ（未言及軸は base に展開）
 *   - Covers: base + payment=S1|S2          パラメタライズ（どの値でも同じ挙動を 1 行で覆う）
 *   - Covers: base + stock=S11+S12          混在（per-item 軸で 1 注文内に複数値が同居）
 *   - Covers: base + obs:S14 / mod:S22 / chain:S16   観測・修飾・連鎖のカバー
 *   - Covers: one-off — 理由                単発バグ再現行（直積検査から除外）
 *
 * 状態マップ連携（appendix-state-map.md）— **任意**。spec が軸に `ref:` を書かなければ
 * 従来動作と完全に同一で、状態マップは不要。`ref:` を使ったのにマップが見つからない
 * 場合のみ exit 2（サイレントに検査をスキップしない）:
 *   M1. borrowed 書き込み違反 — borrowed な storage しか持たない状態に writers がいる
 *   M2. SSOT 一意性 — storage 複数で ssot が 1 つでない / 非 SSOT に sync/staleness がない
 *   M3. ref 整合 — spec の ref が未知の状態 ID / 値が canonical の部分集合でない
 *   M4. shared の外部遷移 — shared な storage があるのに external_writers が空
 *   Q1. 影響導出 — 状態 ID → その状態を ref する spec / B 行の一覧（検査でなくクエリ）
 *
 * 実行モード（入力ファイルの fenced block で自動判別）:
 *   node check-state-model.ts <spec.md>                       スペック検査（検査 0〜7 + M3）
 *   node check-state-model.ts <spec.md> --map <states.md>     状態マップの場所を明示
 *   node check-state-model.ts <states.md>                     状態マップ検査（M1/M2/M4）
 *   node check-state-model.ts --impact <状態ID> <spec.md...>  影響導出クエリ（Q1）
 *
 * 状態マップの探索順: --map 指定 > spec のディレクトリから上位へ .dandori/map/states.md
 *
 * 終了コード: 0 = 全検査グリーン / 1 = 指摘あり / 2 = パース・モデル定義エラー
 */

// 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }

// ---- 型 ----------------------------------------------------------------------

interface AxisValue { id: string; note?: string }
interface Axis {
  id: string
  label: string
  base: string
  /** base が推定（基準シナリオが軸を明言していない）— `base: S11?` で表す */
  baseInferred: boolean
  perItem: boolean
  values: AxisValue[]
  /** 状態マップ（states.md）の canonical 状態 ID への参照 — 共有状態に触れる軸のみ任意で付ける */
  ref?: string
}
interface Observation { id: string; of: string[]; note?: string }
interface Modifier { id: string; affects: string[]; note?: string }
interface OrthogonalDecl { axes: [string, string]; reason: string }
interface OrthogonalGroup { group: string[]; reason: string }
interface DependentDecl { cells: Record<string, CellSpec>; note: string; }
interface OnlyConstraint { axis: string; value: string; requires: Record<string, string[]>; note: string }
interface Chain { from: string; to: string; note: string }
/** ground 送り: spec 時点で裁定できないペア（自己ペア = per-item 混在の裁定送り） */
interface GroundDecl { axes: [string, string]; note: string }

/** セル値の指定: '*' 任意 / alt パラメタライズ（V1|V2）/ mixed 混在（V1+V2） */
type CellSpec = { kind: 'any' } | { kind: 'alt'; values: string[] } | { kind: 'mixed'; values: string[] }

interface Cover {
  b: string
  title: string
  line: number
  oneOff: boolean
  oneOffNote?: string
  cells: Record<string, CellSpec>
  extras: string[]
}

interface Model {
  axes: Axis[]
  observations: Observation[]
  modifiers: Modifier[]
  orthogonal: OrthogonalDecl[]
  orthogonalGroups: OrthogonalGroup[]
  dependent: DependentDecl[]
  only: OnlyConstraint[]
  chains: Chain[]
  ground: GroundDecl[]
}

// ---- エラー収集 ---------------------------------------------------------------

let hardErrors = 0
function fail(msg: string): void {
  console.error(`[model-error] ${msg}`)
  hardErrors++
}

// ---- YAML サブセットパーサ ----------------------------------------------------
// 対応: ブロックマップ / `- ` ブロックシーケンス / フローマップ {k: v} /
//       フローシーケンス [a, b] / 引用符スカラー / プレーンスカラー / # コメント
// 非対応（spec 側の規約）: 複数行スカラー、アンカー等。
// カンマ・波括弧・角括弧を含む文字列は "..." で引用すること。

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
      // `- key: value` + 継続行 = シーケンス項目としてのブロックマップ（状態マップの storages 等）
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
      i++ // {
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
      i++ // [
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

// ---- 引数とファイル読み込み ----------------------------------------------------

const argvRest = process.argv.slice(2)
let mapPathArg: string | null = null
let impactId: string | null = null
const inputPaths: string[] = []
for (let i = 0; i < argvRest.length; i++) {
  const a = argvRest[i]
  if (a === '--map') { mapPathArg = argvRest[++i] ?? null; continue }
  if (a === '--impact') { impactId = argvRest[++i] ?? null; continue }
  if (a.startsWith('--')) { console.error(`未知のオプション: ${a}`); process.exit(2) }
  inputPaths.push(a)
}
if (inputPaths.length === 0 || (impactId === null && inputPaths.length !== 1)) {
  console.error('usage: node check-state-model.ts <spec.md | states.md> [--map <states.md>]\n' +
    '       node check-state-model.ts --impact <状態ID> <spec.md...>')
  process.exit(2)
}

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
const { readFileSync, existsSync } = await import('node:fs') as
  { readFileSync(path: string, enc: string): string; existsSync(p: string): boolean }
// @ts-ignore -- 同上
const { dirname, join, resolve } = await import('node:path') as
  { dirname(p: string): string; join(...p: string[]): string; resolve(p: string): string }

function readLines(path: string, what: string): string[] {
  try {
    return readFileSync(path, 'utf-8').split('\n')
  } catch {
    console.error(`${what}を読めない: ${path}`)
    process.exit(2)
  }
}

/** fenced block 抽出（複数あればエラー） */
function extractBlock(lines: string[], info: string): { body: string; startLine: number } | null {
  const blocks: { body: string; startLine: number }[] = []
  let cur: { start: number; lines: string[] } | null = null
  const open = new RegExp(`^\`\`\`${info}\\s*$`)
  lines.forEach((line, idx) => {
    if (cur === null && open.test(line.trim())) {
      cur = { start: idx + 2, lines: [] } // 本文は次行から（1-indexed）
    } else if (cur !== null && /^```\s*$/.test(line.trim())) {
      blocks.push({ body: cur.lines.join('\n'), startLine: cur.start })
      cur = null
    } else if (cur !== null) {
      cur.lines.push(line)
    }
  })
  if (cur !== null) { fail(`${info} ブロックが閉じていない`); return null }
  if (blocks.length === 0) return null
  if (blocks.length > 1) fail(`${info} ブロックが ${blocks.length} 個ある — 1 個に統合すること`)
  return blocks[0]
}

interface Finding { check: string; detail: string }

function printGroupedFindings(list: Finding[]): void {
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

// ---- 状態マップ（states.md の dandori-state-map ブロック — appendix-state-map.md） ----

interface MapStorage {
  at: string
  kind: string
  cls: 'owned' | 'shared' | 'borrowed'
  ssot: boolean
  sync?: string
  staleness?: string
  anchor: string
}
interface MapRef { via: string; anchor: string }
interface MapExternalWriter { who: string; note?: string }
interface MapState {
  id: string
  label: string
  /** canonical 値 ID の列挙。列挙型でない状態（数値等）は null */
  values: string[] | null
  storages: MapStorage[]
  writers: MapRef[]
  externalWriters: MapExternalWriter[]
  readers: MapRef[]
}
interface StateMap { states: MapState[] }

function failMap(msg: string): void {
  console.error(`[map-error] ${msg}`)
  hardErrors++
}

function buildStateMap(raw: unknown): StateMap {
  const r = asRecord(raw)
  for (const key of Object.keys(r)) {
    if (key !== 'states') failMap(`未知のトップレベルキー: ${key}（語彙は固定 — appendix-state-map.md 参照）`)
  }
  const states: MapState[] = Object.entries(asRecord(r.states)).map(([id, def]) => {
    const d = asRecord(def)
    const known = new Set(['label', 'values', 'storages', 'writers', 'external_writers', 'readers'])
    for (const k of Object.keys(d)) if (!known.has(k)) failMap(`states.${id}: 未知のキー ${k}`)

    const values = d.values === undefined ? null : asStringArray(d.values, `states.${id}.values`)
    if (values) {
      const seen = new Set<string>()
      for (const v of values) {
        if (seen.has(v)) failMap(`states.${id}: 値 ${v} が重複`)
        seen.add(v)
      }
    }
    const storages: MapStorage[] = asArray(d.storages).map((s, i) => {
      const sr = asRecord(s)
      const ctx = `states.${id}.storages[${i}]`
      const cls = asString(sr.class, `${ctx}.class`)
      if (cls !== 'owned' && cls !== 'shared' && cls !== 'borrowed') {
        failMap(`${ctx}.class: owned / shared / borrowed のいずれか（実際: ${cls}）`)
      }
      return {
        at: asString(sr.at, `${ctx}.at`),
        kind: asString(sr.kind, `${ctx}.kind`),
        cls: cls as MapStorage['cls'],
        ssot: sr.ssot === true,
        sync: typeof sr.sync === 'string' ? sr.sync : undefined,
        staleness: typeof sr.staleness === 'string' ? sr.staleness : undefined,
        anchor: asString(sr.anchor, `${ctx}.anchor`),
      }
    })
    if (storages.length === 0) failMap(`states.${id}: storages が空 — 保存場所のない状態はマップに載せない`)

    const parseRefs = (v: unknown, field: string): MapRef[] => asArray(v).map((w, i) => {
      const wr = asRecord(w)
      return {
        via: asString(wr.via, `states.${id}.${field}[${i}].via`),
        anchor: asString(wr.anchor, `states.${id}.${field}[${i}].anchor`),
      }
    })
    const externalWriters: MapExternalWriter[] = asArray(d.external_writers).map((w, i) => {
      const wr = asRecord(w)
      return {
        who: asString(wr.who, `states.${id}.external_writers[${i}].who`),
        note: typeof wr.note === 'string' ? wr.note : undefined,
      }
    })

    return {
      id,
      label: typeof d.label === 'string' ? d.label : id,
      values,
      storages,
      writers: parseRefs(d.writers, 'writers'),
      externalWriters,
      readers: parseRefs(d.readers, 'readers'),
    }
  })
  return { states }
}

function loadStateMap(path: string): StateMap {
  const lines = readLines(path, '状態マップ')
  const b = extractBlock(lines, 'dandori-state-map')
  if (b === null) {
    console.error(`${path}: dandori-state-map ブロックが見つからない`)
    process.exit(2)
  }
  return buildStateMap(parseYamlSubset(b.body, b.startLine))
}

/** spec のディレクトリから上位へ .dandori/map/states.md を探す */
function discoverStatesMd(fromFile: string): string | null {
  let dir = resolve(dirname(fromFile))
  for (;;) {
    const cand = join(dir, '.dandori', 'map', 'states.md')
    if (existsSync(cand)) return cand
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** M1 / M2 / M4 — マップ単体の整合検査 */
function checkStateMap(smap: StateMap): Finding[] {
  const out: Finding[] = []
  for (const st of smap.states) {
    if (st.storages.length > 0 && st.storages.every(s => s.cls === 'borrowed') && st.writers.length > 0) {
      out.push({
        check: 'M1:borrowed書き込み違反',
        detail: `状態 ${st.id} は borrowed な storage しか持たないのに writers がいる（${st.writers.map(w => w.via).join(', ')}）` +
          ` — 区分の誤りか、SSOT 侵犯コードの発見`,
      })
    }
    if (st.storages.length >= 2) {
      const ssots = st.storages.filter(s => s.ssot)
      if (ssots.length !== 1) {
        out.push({
          check: 'M2:SSOT一意性',
          detail: `状態 ${st.id} の storage が ${st.storages.length} 個あるのに ssot: true が ${ssots.length} 個 — ちょうど 1 つに裁定する`,
        })
      }
      for (const s of st.storages.filter(s => !s.ssot)) {
        if (!s.sync && !s.staleness) {
          out.push({
            check: 'M2:SSOT一意性',
            detail: `状態 ${st.id} の非 SSOT storage「${s.at}」に sync も staleness もない — 同期責務か鮮度の裁定が必要`,
          })
        }
      }
    }
    if (st.storages.some(s => s.cls === 'shared') && st.externalWriters.length === 0) {
      out.push({
        check: 'M4:shared外部遷移',
        detail: `状態 ${st.id} は shared な storage を持つのに external_writers が空 — 外部起因の遷移の考慮漏れ`,
      })
    }
  }
  return out
}

// ---- 影響導出モード（Q1: --impact <状態ID> <spec.md...>） ------------------------

if (impactId !== null) {
  console.log(`# 影響導出 — 状態 ${impactId}`)
  console.log('')
  let refSpecs = 0
  for (const p of inputPaths) {
    const lines = readLines(p, 'spec')
    const b = extractBlock(lines, 'dandori-state-model')
    if (b === null) { console.log(`- ${p}: dandori-state-model ブロックなし — 対象外`); continue }
    const m = buildModel(parseYamlSubset(b.body, b.startLine))
    const hits = m.axes.filter(a => a.ref === impactId)
    if (hits.length === 0) continue
    refSpecs++
    const rows = extractBRows(lines)
    for (const axis of hits) {
      const direct = rows.filter(r => r.covers && new RegExp(`(^|[\\s+])${axis.id}=`).test(r.covers.raw))
      console.log(`## ${p} — 軸 ${axis.id}（${axis.label}）`)
      console.log(`- 直接カバー: ${direct.length === 0 ? 'なし' : direct.map(r => r.b).join(', ')}`)
      console.log(`- 暗黙（base 値で通過）: ${rows.length - direct.length} 行 — 過大近似では全 B 行が回帰候補`)
      console.log('')
    }
  }
  if (refSpecs === 0) console.log(`（${impactId} を ref する spec なし）`)
  process.exit(hardErrors > 0 ? 2 : 0)
}

// ---- 入力ファイルの種別判定 -----------------------------------------------------

const specPath = inputPaths[0]
const specLines = readLines(specPath, 'ファイル')

// dandori-state-map ブロックだけを持つファイル → 状態マップ検査モード（M1/M2/M4）
if (specLines.some(l => /^```dandori-state-map\s*$/.test(l.trim())) &&
    !specLines.some(l => /^```dandori-state-model\s*$/.test(l.trim()))) {
  const smap = loadStateMap(specPath)
  const mapFindings = checkStateMap(smap)
  console.log(`# 状態マップ検査レポート — ${specPath}`)
  console.log(`状態 ${smap.states.length} / storage ${smap.states.reduce((n, s) => n + s.storages.length, 0)}` +
    ` / writers ${smap.states.reduce((n, s) => n + s.writers.length, 0)}` +
    ` / readers ${smap.states.reduce((n, s) => n + s.readers.length, 0)}`)
  console.log('')
  if (hardErrors > 0) {
    console.error(`マップ定義エラー ${hardErrors} 件 — 検査結果は不完全`)
    process.exit(2)
  }
  if (mapFindings.length === 0) {
    console.log('指摘なし — 全検査グリーン')
    process.exit(0)
  }
  printGroupedFindings(mapFindings)
  console.log(`計 ${mapFindings.length} 件`)
  process.exit(1)
}

// ---- spec.md 抽出 -------------------------------------------------------------

const block = extractBlock(specLines, 'dandori-state-model')
if (block === null) {
  console.error(`${specPath}: dandori-state-model ブロックが見つからない — この spec は状態モデル運用の対象外か、未執筆`)
  process.exit(2)
}

// ---- モデル構築 ---------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}
}
function asArray(v: unknown): unknown[] { return Array.isArray(v) ? v : [] }
function asString(v: unknown, ctx: string): string {
  if (typeof v === 'string' && v !== '') return v
  fail(`${ctx}: 文字列が必要（実際: ${JSON.stringify(v)}）`)
  return ''
}
function asStringArray(v: unknown, ctx: string): string[] {
  return asArray(v).map(x => asString(x, ctx))
}

/** セル値文字列のパース: '*' / 'V1|V2' / 'V1+V2' / 'V' */
function parseCellSpec(v: unknown, ctx: string): CellSpec {
  const s = asString(v, ctx)
  if (s === '*') return { kind: 'any' }
  if (s.includes('+') && s.includes('|')) { fail(`${ctx}: + と | は混用できない: ${s}`); return { kind: 'alt', values: [s] } }
  if (s.includes('+')) return { kind: 'mixed', values: s.split('+').map(x => x.trim()) }
  return { kind: 'alt', values: s.split('|').map(x => x.trim()) }
}

function buildModel(raw: unknown): Model {
  const r = asRecord(raw)
  const known = new Set(['axes', 'observations', 'modifiers', 'orthogonal', 'orthogonal_groups', 'dependent', 'only', 'chains', 'ground'])
  for (const key of Object.keys(r)) {
    if (!known.has(key)) fail(`未知のトップレベルキー: ${key}（語彙は固定 — appendix-state-model.md 参照）`)
  }

  const axes: Axis[] = Object.entries(asRecord(r.axes)).map(([id, def]) => {
    const d = asRecord(def)
    const rawBase = asString(d.base, `axes.${id}.base`)
    const baseInferred = rawBase.endsWith('?')
    const values: AxisValue[] = asArray(d.values).map(v => {
      if (typeof v === 'string') return { id: v }
      const vr = asRecord(v)
      return { id: asString(vr.id, `axes.${id}.values[].id`), note: typeof vr.note === 'string' ? vr.note : undefined }
    })
    return {
      id,
      label: typeof d.label === 'string' ? d.label : id,
      base: baseInferred ? rawBase.slice(0, -1) : rawBase,
      baseInferred,
      perItem: d.per_item === true,
      values,
      ref: typeof d.ref === 'string' ? d.ref : undefined,
    }
  })

  const observations: Observation[] = Object.entries(asRecord(r.observations)).map(([id, def]) => {
    const d = asRecord(def)
    return { id, of: asStringArray(d.of, `observations.${id}.of`), note: typeof d.note === 'string' ? d.note : undefined }
  })
  const modifiers: Modifier[] = Object.entries(asRecord(r.modifiers)).map(([id, def]) => {
    const d = asRecord(def)
    return { id, affects: asStringArray(d.affects, `modifiers.${id}.affects`), note: typeof d.note === 'string' ? d.note : undefined }
  })

  const orthogonal: OrthogonalDecl[] = asArray(r.orthogonal).map((o, i) => {
    const d = asRecord(o)
    const pair = asStringArray(d.axes, `orthogonal[${i}].axes`)
    if (pair.length !== 2) fail(`orthogonal[${i}]: axes は 2 要素（第2要素 '*' = 全軸）`)
    return { axes: [pair[0] ?? '', pair[1] ?? ''], reason: asString(d.reason, `orthogonal[${i}].reason`) }
  })
  const orthogonalGroups: OrthogonalGroup[] = asArray(r.orthogonal_groups).map((o, i) => {
    const d = asRecord(o)
    return { group: asStringArray(d.group, `orthogonal_groups[${i}].group`), reason: asString(d.reason, `orthogonal_groups[${i}].reason`) }
  })
  const dependent: DependentDecl[] = asArray(r.dependent).map((o, i) => {
    const d = asRecord(o)
    const cells = Object.fromEntries(
      Object.entries(asRecord(d.cells)).map(([axis, v]) => [axis, parseCellSpec(v, `dependent[${i}].cells.${axis}`)]))
    if (Object.keys(cells).length < 2) fail(`dependent[${i}]: 交点は 2 軸以上`)
    return { cells, note: asString(d.note, `dependent[${i}].note`) }
  })
  const only: OnlyConstraint[] = asArray(r.only).map((o, i) => {
    const d = asRecord(o)
    return {
      axis: asString(d.axis, `only[${i}].axis`),
      value: asString(d.value, `only[${i}].value`),
      requires: Object.fromEntries(
        Object.entries(asRecord(d.requires)).map(([axis, v]) =>
          [axis, Array.isArray(v) ? asStringArray(v, `only[${i}].requires.${axis}`) : [asString(v, `only[${i}].requires.${axis}`)]])),
      note: asString(d.note, `only[${i}].note`),
    }
  })
  const chains: Chain[] = asArray(r.chains).map((o, i) => {
    const d = asRecord(o)
    return { from: asString(d.from, `chains[${i}].from`), to: asString(d.to, `chains[${i}].to`), note: asString(d.note, `chains[${i}].note`) }
  })
  const ground: GroundDecl[] = asArray(r.ground).map((o, i) => {
    const d = asRecord(o)
    const pair = asStringArray(d.axes, `ground[${i}].axes`)
    if (pair.length !== 2) fail(`ground[${i}]: axes は 2 要素（自己ペア = per-item 混在の裁定送り）`)
    return { axes: [pair[0] ?? '', pair[1] ?? ''], note: asString(d.note, `ground[${i}].note`) }
  })

  return { axes, observations, modifiers, orthogonal, orthogonalGroups, dependent, only, chains, ground }
}

const model = buildModel(parseYamlSubset(block.body, block.startLine))
const axisById = new Map(model.axes.map(a => [a.id, a]))

// ---- ref: 状態マップ参照の解決（任意 — ref を使わない spec では従来動作と同一） -----

const refAxes = model.axes.filter(a => a.ref !== undefined)
let stateMap: StateMap | null = null
let stateMapPath: string | null = null
if (refAxes.length > 0) {
  stateMapPath = mapPathArg ?? discoverStatesMd(specPath)
  if (stateMapPath === null) {
    console.error(`ref: を使う spec には状態マップが必要（ref 使用軸: ${refAxes.map(a => a.id).join(', ')}） — ` +
      `--map <states.md> で指定するか、spec の上位に .dandori/map/states.md を置く`)
    process.exit(2)
  }
  stateMap = loadStateMap(stateMapPath)
}

// ---- モデル内参照の検証 --------------------------------------------------------

function checkAxisRef(axisId: string, ctx: string): Axis | undefined {
  const axis = axisById.get(axisId)
  if (!axis) fail(`${ctx}: 未知の軸 ${axisId}`)
  return axis
}
function checkValueRef(axis: Axis, valueId: string, ctx: string): void {
  if (!axis.values.some(v => v.id === valueId)) fail(`${ctx}: 軸 ${axis.id} に未知の値 ${valueId}`)
}

for (const axis of model.axes) {
  if (axis.values.length === 0) fail(`軸 ${axis.id}: values が空`)
  if (!axis.values.some(v => v.id === axis.base)) fail(`軸 ${axis.id}: base ${axis.base} が values にない`)
  const seen = new Set<string>()
  for (const v of axis.values) {
    if (seen.has(v.id)) fail(`軸 ${axis.id}: 値 ${v.id} が重複`)
    seen.add(v.id)
  }
}
for (const o of model.observations) for (const a of o.of) checkAxisRef(a, `observations.${o.id}.of`)
for (const d of model.orthogonal) {
  checkAxisRef(d.axes[0], 'orthogonal.axes')
  if (d.axes[1] !== '*') checkAxisRef(d.axes[1], 'orthogonal.axes')
}
for (const g of model.orthogonalGroups) for (const a of g.group) checkAxisRef(a, 'orthogonal_groups.group')
for (const g of model.ground) {
  for (const a of g.axes) checkAxisRef(a, `ground(${g.note})`)
  const self = g.axes[0] === g.axes[1]
  if (self && axisById.get(g.axes[0]) && !axisById.get(g.axes[0])!.perItem)
    fail(`ground(${g.note}): 自己ペアは per-item 混在の裁定送り — ${g.axes[0]} は per_item でない`)
}
for (const d of model.dependent) {
  for (const [axisId, spec] of Object.entries(d.cells)) {
    const axis = checkAxisRef(axisId, `dependent(${d.note})`)
    if (axis && spec.kind !== 'any') for (const v of spec.values) checkValueRef(axis, v, `dependent(${d.note})`)
    if (axis && spec.kind === 'mixed' && !axis.perItem) fail(`dependent(${d.note}): 混在指定（+）は per_item 軸のみ — ${axisId} は per_item でない`)
  }
}
for (const o of model.only) {
  const axis = checkAxisRef(o.axis, `only(${o.note})`)
  if (axis) checkValueRef(axis, o.value, `only(${o.note})`)
  for (const [reqAxis, allowed] of Object.entries(o.requires)) {
    const ra = checkAxisRef(reqAxis, `only(${o.note}).requires`)
    if (ra) for (const v of allowed) checkValueRef(ra, v, `only(${o.note}).requires`)
  }
}

// ---- B 行と Covers の抽出 ------------------------------------------------------

interface BRow { b: string; title: string; line: number; covers: { raw: string; line: number } | null }

function extractBRows(lines: string[]): BRow[] {
  const rows: BRow[] = []
  let cur: BRow | null = null
  let inFence = false
  lines.forEach((line, idx) => {
    if (/^```/.test(line.trim())) { inFence = !inFence; return }
    if (inFence) return
    const heading = line.match(/^#{2,6}\s+(B-[\w.()]+(?:〜B-[\w.()]+)?)\s*[:：]\s*(.*)$/)
    if (heading) {
      cur = { b: heading[1], title: heading[2].trim(), line: idx + 1, covers: null }
      rows.push(cur)
      return
    }
    if (/^#{1,6}\s/.test(line)) {
      cur = null
      // B 行らしき見出しの黙殺防止: パースできない B- 見出しはエラーにする
      if (/^#{2,6}\s+B-/.test(line)) fail(`L${idx + 1}: B 行見出しとして解釈できない: ${line.trim()}`)
      return
    }
    if (cur) {
      const m = line.match(/^\s*-?\s*Covers:\s*(.+)$/)
      if (m) {
        if (cur.covers) fail(`${cur.b} (L${idx + 1}): Covers が複数ある`)
        else cur.covers = { raw: m[1].trim(), line: idx + 1 }
      }
    }
  })
  return rows
}

const bRows = extractBRows(specLines)
{
  const seen = new Set<string>()
  for (const row of bRows) {
    if (seen.has(row.b)) fail(`B 行 ID が重複: ${row.b} (L${row.line})`)
    seen.add(row.b)
  }
}

function parseCovers(row: BRow): Cover | null {
  if (!row.covers) return null
  const raw = row.covers.raw
  const oneOff = raw.match(/^one-off\s*(?:[—－(（-]\s*(.*?)\s*[)）]?)?$/)
  if (oneOff) return { b: row.b, title: row.title, line: row.covers.line, oneOff: true, oneOffNote: oneOff[1], cells: {}, extras: [] }

  const cells: Record<string, CellSpec> = {}
  const extras: string[] = []
  const tokens = raw.split(/\s\+\s/).map(t => t.trim()).filter(t => t !== '')
  for (const [ti, tok] of tokens.entries()) {
    if (tok === 'base') {
      if (ti !== 0) fail(`${row.b}: base はデルタの先頭に置く — ${raw}`)
      continue
    }
    const extra = tok.match(/^(obs|mod|chain):(\S+)$/)
    if (extra) { extras.push(tok); continue }
    const cell = tok.match(/^([\w-]+)=(\S+)$/)
    if (cell) {
      const [, axisId, valuePart] = cell
      const axis = checkAxisRef(axisId, row.b)
      const spec = parseCellSpec(valuePart, `${row.b} の ${axisId}`)
      if (spec.kind === 'any') { fail(`${row.b}: Covers に '*' は書けない`); continue }
      if (axis) {
        for (const v of spec.values) checkValueRef(axis, v, row.b)
        if (spec.kind === 'mixed' && !axis.perItem) fail(`${row.b}: 混在指定（+）は per_item 軸のみ — ${axisId} は per_item でない`)
      }
      if (cells[axisId]) fail(`${row.b}: 軸 ${axisId} を二重指定`)
      cells[axisId] = spec
      continue
    }
    fail(`${row.b}: Covers トークンを解釈できない: ${tok}`)
  }
  if (tokens[0] !== 'base') fail(`${row.b}: Covers は base で始める（one-off を除く）— ${raw}`)
  return { b: row.b, title: row.title, line: row.covers.line, oneOff: false, cells, extras }
}

const allCovers = bRows.map(parseCovers).filter((c): c is Cover => c !== null)
const oneOffCovers = allCovers.filter(c => c.oneOff)
const covers = allCovers.filter(c => !c.oneOff)

// extras の参照検証
const chainFroms = new Set(model.chains.map(c => c.from))
const obsIds = new Set(model.observations.map(o => o.id))
const modIds = new Set(model.modifiers.map(m => m.id))
for (const cover of covers) {
  for (const extra of cover.extras) {
    const [kind, id] = extra.split(':')
    const pool = kind === 'obs' ? obsIds : kind === 'mod' ? modIds : chainFroms
    if (!pool.has(id)) fail(`${cover.b}: ${extra} がモデルに宣言されていない`)
  }
}

// ---- B 行タプルの展開 ----------------------------------------------------------

/** cover の各軸の取りうる値集合（デルタ + 未言及軸は base） */
function tupleOf(cover: Cover): Map<string, Set<string>> {
  const t = new Map<string, Set<string>>()
  for (const axis of model.axes) t.set(axis.id, new Set([axis.base]))
  for (const [axisId, spec] of Object.entries(cover.cells)) {
    if (spec.kind !== 'any') t.set(axisId, new Set(spec.values))
  }
  return t
}

const tuples = covers.map(c => ({ cover: c, tuple: tupleOf(c) }))

// ---- 検査 ----------------------------------------------------------------------

const findings: Finding[] = []

// ---- 検査 0: Covers 欠落 -------------------------------------------------------

for (const row of bRows.filter(r => r.covers === null)) {
  findings.push({
    check: '0:Covers欠落',
    detail: `${row.b} (L${row.line}) に Covers フィールドがない — モデル対象外なら one-off、対象なら base + デルタを書く`,
  })
}

// ---- 検査 1: 値カバレッジ ------------------------------------------------------

for (const axis of model.axes) {
  for (const value of axis.values) {
    const covered = tuples.some(({ cover, tuple }) => {
      const vs = tuple.get(axis.id)!
      // 「カバー」= その B 行がこの値を意図して選んでいる（cells で言及）か、
      // 基準値であること（基準シナリオはあらゆる B 行の背景として踏まれる）
      return value.id === axis.base ? true : cover.cells[axis.id] != null && vs.has(value.id)
    })
    if (!covered) {
      findings.push({
        check: '1:値カバレッジ',
        detail: `軸 ${axis.id}（${axis.label}）の値 ${value.id} をカバーする B 行がない`,
      })
    }
  }
}

// ---- 検査 2: 依存交点カバレッジ ------------------------------------------------

for (const dep of model.dependent) {
  const covered = tuples.some(({ cover, tuple }) => {
    return Object.entries(dep.cells).every(([axisId, want]) => {
      const axis = axisById.get(axisId)
      if (!axis) return false
      const explicit = cover.cells[axisId] != null
      // per-item 軸は base 省略ルール適用除外: order レベルの基準通過では
      // 交点がトリビアルに covered 判定されるため、明示言及を要求する
      if (axis.perItem && !explicit) return false
      if (want.kind === 'any') {
        // 任意値でよいが「意図して非基準値を選んでいる」ことは要求しない —
        // 交点の相手軸が基準値でも観測可能なため cells 言及または基準通過で可
        return true
      }
      if (want.kind === 'mixed') {
        const c = cover.cells[axisId]
        return c?.kind === 'mixed' && want.values.every(v => c.values.includes(v))
      }
      const vs = tuple.get(axisId)!
      // 非基準値の要求は cells での明示言及を要求する（偶然の基準一致を除く）
      return want.values.some(w =>
        w === axis.base ? (explicit && vs.has(w)) || !explicit : explicit && vs.has(w))
    })
  })
  if (!covered) {
    const cellsDesc = Object.entries(dep.cells)
      .map(([a, v]) => `${a}=${v.kind === 'any' ? '*' : v.values.join(v.kind === 'mixed' ? '+' : '|')}`)
      .join(' × ')
    findings.push({
      check: '2:依存交点カバレッジ',
      detail: `宣言済み交点 [${cellsDesc}] を単一の B 行でカバーしていない — ${dep.note}`,
    })
  }
}

// ---- 検査 3: ペア分類の全数性 --------------------------------------------------

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('×')
}

const classified = new Map<string, string>()
for (const decl of model.orthogonal) {
  const [a, b] = decl.axes
  const others = b === '*' ? model.axes.map(x => x.id).filter(x => x !== a) : [b]
  for (const o of others) classified.set(pairKey(a, o), `直交: ${decl.reason}`)
}
for (const g of model.orthogonalGroups) {
  for (let i = 0; i < g.group.length; i++)
    for (let j = i + 1; j < g.group.length; j++)
      classified.set(pairKey(g.group[i], g.group[j]), `直交グループ: ${g.reason}`)
}
for (const dep of model.dependent) {
  const axesIn = Object.keys(dep.cells)
  for (let i = 0; i < axesIn.length; i++)
    for (let j = i + 1; j < axesIn.length; j++)
      classified.set(pairKey(axesIn[i], axesIn[j]), `依存: ${dep.note}`)
}
for (const only of model.only) {
  for (const req of Object.keys(only.requires))
    classified.set(pairKey(only.axis, req), `制約: ${only.note}`)
}
// ground 送りペアも「裁定済み」扱い（裁定の中身は ground 工程に委譲 — 別枠でレポート）
for (const g of model.ground) classified.set(pairKey(g.axes[0], g.axes[1]), `ground送り: ${g.note}`)

for (let i = 0; i < model.axes.length; i++) {
  for (let j = i + 1; j < model.axes.length; j++) {
    const key = pairKey(model.axes[i].id, model.axes[j].id)
    if (!classified.has(key)) {
      findings.push({
        check: '3:ペア分類の全数性',
        detail: `未分類の軸ペア: ${model.axes[i].id} × ${model.axes[j].id} — 直交宣言（理由つき）か依存交点の列挙が必要`,
      })
    }
  }
}

// ---- 検査 4: only 制約違反 -----------------------------------------------------

for (const only of model.only) {
  for (const { cover, tuple } of tuples) {
    const vs = tuple.get(only.axis)
    if (!vs?.has(only.value)) continue
    for (const [reqAxis, allowed] of Object.entries(only.requires)) {
      const actual = tuple.get(reqAxis)
      if (!actual) continue
      const satisfiable = [...actual].some(v => allowed.includes(v))
      if (!satisfiable) {
        findings.push({
          check: '4:only制約違反',
          detail: `${cover.b} は ${only.axis}=${only.value} を含むが ${reqAxis} が {${allowed.join(', ')}} のいずれでもない` +
            `（未言及軸は基準値 ${axisById.get(reqAxis)?.base} に展開される）— ${only.note}`,
        })
      }
    }
  }
}

// ---- 検査 5: 連鎖カバレッジ ----------------------------------------------------

for (const chain of model.chains) {
  const covered = covers.some(c => c.extras.includes(`chain:${chain.from}`))
  if (!covered) {
    findings.push({
      check: '5:連鎖カバレッジ',
      detail: `連鎖 ${chain.from} → ${chain.to} をカバーする B 行がない — ${chain.note}`,
    })
  }
}

// ---- 検査 6: 観測・修飾カバレッジ ----------------------------------------------

for (const obs of model.observations) {
  if (!covers.some(c => c.extras.includes(`obs:${obs.id}`)))
    findings.push({ check: '6:観測・修飾', detail: `観測 ${obs.id}（of: ${obs.of.join(', ')}）を検証する B 行がない` })
}
for (const mod of model.modifiers) {
  if (!covers.some(c => c.extras.includes(`mod:${mod.id}`)))
    findings.push({ check: '6:観測・修飾', detail: `修飾 ${mod.id}（affects: ${mod.affects.join(', ')}）を検証する B 行がない` })
}

// ---- 検査 7: per-item 軸の混在 -------------------------------------------------

for (const axis of model.axes.filter(a => a.perItem)) {
  const mixDeclared =
    // 自己ペア直交宣言 = 「混在しても値ごとに独立で合成挙動なし」の裁定
    model.orthogonal.some(d => d.axes[0] === axis.id && d.axes[1] === axis.id) ||
    model.dependent.some(d => d.cells[axis.id]?.kind === 'mixed') ||
    // ground 自己ペア = 混在の裁定を ground に送った（別枠でレポート）
    model.ground.some(g => g.axes[0] === axis.id && g.axes[1] === axis.id)
  const mixCovered = covers.some(c => c.cells[axis.id]?.kind === 'mixed')
  if (!mixDeclared && !mixCovered) {
    findings.push({
      check: '7:per-item混在',
      detail: `商品単位軸 ${axis.id} の値混在（1 注文内に ${axis.values.map(v => v.id).join('/')} が同居）が` +
        `宣言もカバーもされていない — 自己ペア直交宣言（axes: [${axis.id}, ${axis.id}]）か混在 Covers（${axis.id}=値+値）が必要`,
    })
  }
}

// ---- 検査 M3: ref 整合（状態マップ紐づけ — ref 使用時のみ発動） -------------------

if (stateMap !== null) {
  const stById = new Map(stateMap.states.map(s => [s.id, s]))
  for (const axis of refAxes) {
    const st = stById.get(axis.ref!)
    if (!st) {
      findings.push({
        check: 'M3:ref整合',
        detail: `軸 ${axis.id} の ref ${axis.ref} が状態マップ（${stateMapPath}）にない — typo かマップの陳腐化`,
      })
      continue
    }
    if (st.values !== null) {
      for (const v of axis.values) {
        if (!st.values.includes(v.id)) {
          findings.push({
            check: 'M3:ref整合',
            detail: `軸 ${axis.id} の値 ${v.id} が状態 ${axis.ref} の canonical 値 {${st.values.join(', ')}} にない` +
              ` — ref 付き軸は canonical 値 ID を使う（appendix-state-map.md）`,
          })
        }
      }
    }
  }
}

// ---- ground 送り項目（指摘とは別枠） -------------------------------------------

const groundItems: string[] = []
for (const g of model.ground) {
  groundItems.push(g.axes[0] === g.axes[1]
    ? `per-item 混在の裁定: 軸 ${g.axes[0]} — ${g.note}`
    : `ペア裁定: ${g.axes[0]} × ${g.axes[1]}（直交か依存か）— ${g.note}`)
}
for (const axis of model.axes.filter(a => a.baseInferred)) {
  groundItems.push(`base 確定: 軸 ${axis.id}（${axis.label}）の base ${axis.base} は推定 — ` +
    `基準シナリオに明言して ? を外すか、コードで確認して確定する`)
}

// ---- レポート ------------------------------------------------------------------

console.log(`# 状態モデル検査レポート — ${specPath}`)
console.log(`軸 ${model.axes.length} / 値 ${model.axes.reduce((n, a) => n + a.values.length, 0)}` +
  ` / B 行 ${bRows.length}（モデル対象 ${covers.length} / one-off ${oneOffCovers.length}）` +
  ` / 直交宣言 ${model.orthogonal.length + model.orthogonalGroups.length} / 依存交点 ${model.dependent.length}`)
if (stateMap !== null) {
  console.log(`状態マップ: ${stateMapPath}（ref 軸: ${refAxes.map(a => `${a.id}→${a.ref}`).join(', ')}）`)
}
if (oneOffCovers.length > 0) {
  console.log(`one-off（直積検査から除外）: ${oneOffCovers.map(c => c.b).join(', ')}`)
}
console.log('')

if (hardErrors > 0) {
  console.error(`モデル定義エラー ${hardErrors} 件 — 検査結果は不完全`)
  process.exit(2)
}

if (groundItems.length > 0) {
  console.log(`## ground 送り（確認項目 ${groundItems.length} 件 — fix は通過可 / gate では残存を裁定）`)
  for (const item of groundItems) console.log(`- ${item}`)
  console.log('')
}

if (findings.length === 0) {
  console.log(groundItems.length === 0
    ? '指摘なし — 全検査グリーン'
    : `指摘なし — グリーン（ground 送り ${groundItems.length} 件あり）`)
} else {
  printGroupedFindings(findings)
  console.log(`計 ${findings.length} 件`)
  process.exit(1)
}

export {}
