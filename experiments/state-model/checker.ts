/**
 * 状態モデル静的チェッカー（実験版）。
 *
 * 検査項目:
 *   1. 値カバレッジ — 各軸の全値がいずれかの B 行にカバーされているか
 *   2. 依存交点カバレッジ — dependent 宣言の組み合わせを「単一の B 行」がカバーしているか
 *   3. ペア分類の全数性 — 全軸ペアが「直交宣言」か「依存宣言」のどちらかに分類されているか
 *   4. only 制約違反 — B 行の展開タプルが only 制約と矛盾しないか
 *   5. 連鎖カバレッジ — chains の各エントリにカバーする B 行があるか
 *   6. 観測・修飾カバレッジ — observations / modifiers を検証する B 行があるか
 *   7. per-item 軸の混在 — 商品単位軸の値混在が直交宣言も交点列挙もされていない場合に警告
 *
 * 実行: node checker.ts [--as-of=fix]
 *   --as-of=fix: addedBy マークつきの要素（レビューで後から追加された値・宣言・連鎖）を
 *   除外し、spec fix 時点のモデルを復元して検査する（バックテスト）
 */
import type { Model, Cover } from './model-types.ts'

// 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }

const asOfFix = process.argv.includes('--as-of=fix')
const modelArg = process.argv.find(a => a.startsWith('--model='))?.slice('--model='.length)
  ?? './cart-payment.model.ts'
const { model: fullModel } = await import(modelArg) as { model: Model }

// ---- モデルの時点復元 --------------------------------------------------------

function restrict(m: Model): Model {
  if (!asOfFix) return m
  const axes = m.axes.map(a => ({ ...a, values: a.values.filter(v => !v.addedBy) }))
  const knownValues = new Map(axes.map(a => [a.id, new Set(a.values.map(v => v.id))]))
  const chains = m.chains.filter(c => !c.addedBy)
  const chainIds = new Set(chains.map(c => `chain:${c.from}`))
  const covers = m.covers
    .filter(c => !c.addedBy)
    .map(c => ({
      ...c,
      cells: Object.fromEntries(
        Object.entries(c.cells).map(([axis, v]) => {
          const known = knownValues.get(axis) ?? new Set()
          const vs = (Array.isArray(v) ? v : [v]).filter(x => known.has(x))
          return [axis, vs] as const
        }).filter(([, vs]) => (vs as string[]).length > 0),
      ),
      extras: c.extras?.filter(e => !e.startsWith('chain:') || chainIds.has(e)),
    }))
  return {
    ...m,
    axes,
    chains,
    covers,
    orthogonal: m.orthogonal.filter(d => !d.addedBy),
    orthogonalGroups: m.orthogonalGroups?.filter(d => !d.addedBy),
    dependent: m.dependent.filter(d => !d.addedBy),
  }
}

const model = restrict(fullModel)
const axisById = new Map(model.axes.map(a => [a.id, a]))

// ---- B 行タプルの展開 --------------------------------------------------------

/** cover の各軸の取りうる値集合（デルタ + 未言及軸は base） */
function tupleOf(cover: Cover): Map<string, Set<string>> {
  const t = new Map<string, Set<string>>()
  for (const axis of model.axes) t.set(axis.id, new Set([axis.base]))
  for (const [axisId, v] of Object.entries(cover.cells)) {
    if (!axisById.has(axisId)) fail(`${cover.b}: 未知の軸 ${axisId}`)
    const vs = Array.isArray(v) ? v : [v]
    const known = new Set(axisById.get(axisId)!.values.map(x => x.id))
    for (const x of vs) if (!known.has(x)) fail(`${cover.b}: 軸 ${axisId} に未知の値 ${x}`)
    t.set(axisId, new Set(vs))
  }
  return t
}

let hardErrors = 0
function fail(msg: string): void {
  console.error(`[model-error] ${msg}`)
  hardErrors++
}

const tuples = model.covers.map(c => ({ cover: c, tuple: tupleOf(c) }))

// ---- 検査 1: 値カバレッジ ----------------------------------------------------

interface Finding { check: string; detail: string }
const findings: Finding[] = []

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

// ---- 検査 2: 依存交点カバレッジ ----------------------------------------------

for (const dep of model.dependent) {
  const covered = tuples.some(({ cover, tuple }) => {
    return Object.entries(dep.cells).every(([axisId, v]) => {
      const axis = axisById.get(axisId)
      if (!axis) { fail(`dependent: 未知の軸 ${axisId}`); return false }
      const vs = tuple.get(axisId)!
      if (v === '*') {
        // 任意値でよいが「意図して非基準値を選んでいる」ことは要求しない —
        // 交点の相手軸が基準値でも観測可能なため cells 言及または基準通過で可
        return true
      }
      const wanted = Array.isArray(v) ? v : [v]
      // 非基準値の要求は cells での明示言及を要求する（偶然の基準一致を除く）
      return wanted.some(w =>
        w === axis.base ? cover.cells[axisId] != null && vs.has(w) || !cover.cells[axisId]
          : cover.cells[axisId] != null && vs.has(w))
    })
  })
  if (!covered) {
    const cellsDesc = Object.entries(dep.cells).map(([a, v]) => `${a}=${Array.isArray(v) ? v.join('|') : v}`).join(' × ')
    findings.push({
      check: '2:依存交点カバレッジ',
      detail: `宣言済み交点 [${cellsDesc}] を単一の B 行でカバーしていない — ${dep.note}`,
    })
  }
}

// ---- 検査 3: ペア分類の全数性 ------------------------------------------------

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('×')
}

const classified = new Map<string, string>()
for (const decl of model.orthogonal) {
  const [a, b] = decl.axes
  const others = b === '*' ? model.axes.map(x => x.id).filter(x => x !== a) : [b]
  for (const o of others) classified.set(pairKey(a, o), `直交: ${decl.reason}`)
}
for (const g of model.orthogonalGroups ?? []) {
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

const unclassified: string[] = []
for (let i = 0; i < model.axes.length; i++) {
  for (let j = i + 1; j < model.axes.length; j++) {
    const key = pairKey(model.axes[i].id, model.axes[j].id)
    if (!classified.has(key)) unclassified.push(`${model.axes[i].id} × ${model.axes[j].id}`)
  }
}
for (const pair of unclassified) {
  findings.push({
    check: '3:ペア分類の全数性',
    detail: `未分類の軸ペア: ${pair} — 直交宣言（理由つき）か依存交点の列挙が必要`,
  })
}

// ---- 検査 4: only 制約違反 ---------------------------------------------------

for (const only of model.only) {
  for (const { cover, tuple } of tuples) {
    const vs = tuple.get(only.axis)!
    if (!vs.has(only.value)) continue
    for (const [reqAxis, allowed] of Object.entries(only.requires)) {
      const actual = tuple.get(reqAxis)!
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

// ---- 検査 5: 連鎖カバレッジ --------------------------------------------------

for (const chain of model.chains) {
  const covered = model.covers.some(c => c.extras?.includes(`chain:${chain.from}`))
  if (!covered) {
    findings.push({
      check: '5:連鎖カバレッジ',
      detail: `連鎖 ${chain.from} → ${chain.to} をカバーする B 行がない — ${chain.note}`,
    })
  }
}

// ---- 検査 6: 観測・修飾カバレッジ --------------------------------------------

for (const obs of model.observations) {
  if (!model.covers.some(c => c.extras?.includes(`obs:${obs.id}`)))
    findings.push({ check: '6:観測・修飾', detail: `観測 ${obs.id}（${obs.ref}）を検証する B 行がない` })
}
for (const mod of model.modifiers) {
  if (!model.covers.some(c => c.extras?.includes(`mod:${mod.id}`)))
    findings.push({ check: '6:観測・修飾', detail: `修飾 ${mod.id}（${mod.ref}）を検証する B 行がない` })
}

// ---- 検査 7: per-item 軸の混在 ----------------------------------------------

for (const axis of model.axes.filter(a => a.perItem)) {
  const mixDeclared =
    model.orthogonal.some(d => d.axes[0] === axis.id && d.axes[1] === axis.id) ||
    model.dependent.some(d => {
      const v = d.cells[axis.id]
      return Array.isArray(v) && v.length > 1
    })
  const mixCovered = tuples.some(({ cover }) => {
    const v = cover.cells[axis.id]
    return Array.isArray(v) && v.length > 1 && cover.title.includes('混在')
  })
  if (!mixDeclared && !mixCovered) {
    findings.push({
      check: '7:per-item混在',
      detail: `商品単位軸 ${axis.id} の値混在（1 注文内に ${axis.values.map(v => v.id).join('/')} が同居）が` +
        `直交宣言も交点列挙もされていない — 混在時の挙動は未検討の可能性`,
    })
  }
}

// ---- レポート ----------------------------------------------------------------

console.log(`# 状態モデル検査レポート — ${asOfFix ? 'spec fix 時点復元（バックテスト）' : '現行モデル'}`)
console.log(`軸 ${model.axes.length} / 値 ${model.axes.reduce((n, a) => n + a.values.length, 0)}` +
  ` / B 行 ${model.covers.length} / 直交宣言 ${model.orthogonal.length} / 依存交点 ${model.dependent.length}`)
console.log('')

if (hardErrors > 0) {
  console.error(`モデル定義エラー ${hardErrors} 件 — 検査結果は不完全`)
  process.exit(2)
}

if (findings.length === 0) {
  console.log('指摘なし — 全検査グリーン')
} else {
  const byCheck = new Map<string, Finding[]>()
  for (const f of findings) {
    if (!byCheck.has(f.check)) byCheck.set(f.check, [])
    byCheck.get(f.check)!.push(f)
  }
  for (const [check, list] of [...byCheck.entries()].sort()) {
    console.log(`## ${check}（${list.length} 件）`)
    for (const f of list) console.log(`- ${f.detail}`)
    console.log('')
  }
  console.log(`計 ${findings.length} 件`)
}
