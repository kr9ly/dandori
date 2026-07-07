export const meta = {
  name: 'dandori-impl',
  description: 'dandori impl 工程の決定的ループ — マイルストーンごとに ブリーフ組み立て → 実装ディスパッチ → 独立ゲート検証 → 発見の還流 を逐次で回す',
  whenToUse: 'dandori-impl スキル実行時、Workflow が使える環境でマイルストーンループを機械駆動する。spec 波及・不変条件抵触の裁定と最終フェーズ遷移はメインエージェントに返す。マイルストーンの並列化はこのスクリプトの対象外（依存とファイル重複の判断はメインの領分 — 迷ったら逐次）。',
}

// ============================================================================
// dandori-impl workflow
//
// SKILL.md のマイルストーンループをスクリプトに固定する。狙いは希釈防止の構造的な強制 —
// 「マニフェスト記載のセクションだけを渡す（spec/design の全文を渡さない）」を、
// ブリーフ組み立てエージェント（抽出係）と実装エージェントの分離で実現する。
// 実装エージェントのプロンプトには spec.md / design.md のパスが存在しない = 全文を読めない。
//
// args:
//   specDir      (必須) .dandori/specs/<feature> — spec.md / design.md / plan.md /
//                state.yaml をこの直下に置く規約
//   maxFixRounds (任意) ゲート赤時の修正ディスパッチ回数の上限（既定 2）
//
// 戻り値 status:
//   done               — 残りマイルストーンすべてのゲートが緑
//   needs_adjudication — spec の振る舞いに波及する [発見]。ユーザー裁定へ
//   halted             — 実装エージェントが不変条件抵触で停止した。ユーザー裁定へ
//   gate_red           — 修正ディスパッチを使い切ってもゲートが赤。メインで裁定
//   blocked            — plan.md / state.yaml が見つからない・整合しない
// ============================================================================

if (!args || !args.specDir) {
  throw new Error('args に specDir が必要。任意: maxFixRounds')
}

const SPEC_DIR = args.specDir.replace(/\/+$/, '')
const SPEC = `${SPEC_DIR}/spec.md`
const DESIGN = `${SPEC_DIR}/design.md`
const PLAN = `${SPEC_DIR}/plan.md`
const STATE = `${SPEC_DIR}/state.yaml`
const MAX_FIX_ROUNDS = args.maxFixRounds || 2

// ---- schemas ---------------------------------------------------------------

const SETUP_SCHEMA = {
  type: 'object',
  required: ['files_ok', 'milestones'],
  properties: {
    files_ok: { type: 'boolean' },
    missing: { type: 'string', description: '欠けている・整合しないもの' },
    milestones: {
      type: 'array',
      description: 'plan.md の全マイルストーン（plan 記載順）',
      items: {
        type: 'object',
        required: ['id', 'title', 'done'],
        properties: {
          id: { type: 'string', description: 'M1 等のマイルストーン ID' },
          title: { type: 'string' },
          done: { type: 'boolean', description: 'state.yaml の impl.milestones_done に含まれるか' },
        },
      },
    },
  },
}

const BRIEF_SCHEMA = {
  type: 'object',
  required: ['brief', 'gates'],
  properties: {
    brief: { type: 'string', description: '実装エージェントに渡すブリーフ本文（対応 B 行 / 関連設計エントリ / 不変条件全文 / 手順概略 / 関連する発見ログ項目 / 参照パス）' },
    gates: { type: 'array', items: { type: 'string' }, description: 'このマイルストーンのゲートコマンド（plan.md 記載の正準）' },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  required: ['summary', 'discoveries', 'halted', 'gates_green', 'gate_output'],
  properties: {
    summary: { type: 'string', description: '実装内容の要約（変更ファイルと要点）' },
    discoveries: {
      type: 'array',
      description: '[発見] の一覧 — 仕様・設計の記述と現実のコードの食い違い',
      items: {
        type: 'object',
        required: ['what', 'mismatch', 'response'],
        properties: {
          what: { type: 'string', description: '何が' },
          mismatch: { type: 'string', description: 'どう食い違うか' },
          response: { type: 'string', description: 'あなたの対応（回避した/保留した）' },
        },
      },
    },
    halted: { type: 'boolean', description: 'true = 不変条件に抵触する変更が必要になり、実装せず停止した' },
    halt_reason: { type: 'string', description: 'halted 時: どの不変条件にどう抵触するか' },
    gates_green: { type: 'boolean' },
    gate_output: { type: 'string', description: 'ゲート実行の生の出力の要点' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['green', 'gate_output'],
  properties: {
    green: { type: 'boolean' },
    gate_output: { type: 'string', description: '生の出力の要点（赤があれば失敗箇所）' },
  },
}

const DISCOVERY_SCHEMA = {
  type: 'object',
  required: ['classified'],
  properties: {
    classified: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'impact', 'reason'],
        properties: {
          index: { type: 'integer', description: '渡した発見 JSON の index' },
          impact: { type: 'string', enum: ['design_only', 'spec_impact'], description: 'design.md の記述修正で済むか、spec.md の振る舞いに波及するか' },
          reason: { type: 'string', description: '判定根拠。design_only なら design.md をどう修正したかも一行で' },
        },
      },
    },
  },
}

const ACK_SCHEMA = {
  type: 'object',
  required: ['done'],
  properties: {
    done: { type: 'boolean' },
    note: { type: 'string' },
  },
}

// ---- プロンプトテンプレート（希釈防止はここで固定される）---------------------

const setupPrompt = `dandori-impl の入口確認を行ってください。コードやドキュメントの修正はしないこと。

1. ${PLAN} と ${STATE} が存在するか確認する
2. ${PLAN} の全マイルストーン（ID とタイトル）を plan 記載順に列挙する
3. ${STATE} の impl.milestones_done を読み、各マイルストーンの done を判定する
4. milestones_done に plan.md に存在しない ID があれば files_ok=false とし missing で報告する`

const briefPrompt = (m) => `あなたはブリーフ組み立て係です。マイルストーン ${m.id}（${m.title}）の実装エージェントに渡す
ブリーフを組み立ててください。あなた自身は実装しない。

手順:
1. ${PLAN} の ${m.id} のマニフェストを読む
2. マニフェスト記載の spec.md / design.md のセクション**だけ**を ${SPEC} / ${DESIGN} から抽出する
   （全文を貼らない — 希釈防止。ただし design.md の不変条件は常に全文含める）
3. ${DESIGN} の発見ログのうち、このマイルストーンに関係する項目を含める
4. マニフェストにリソースマップ由来の参照先（規約等）があれば、その**パス**をブリーフに含め、
   「実装前に読んで従うこと」と指示する（内容は貼り込まない）
5. ${PLAN} の ${m.id} のゲート（正準コマンド）を gates として返す

ブリーフの構成: 対応 B 行（本文ごと）/ 関連する設計エントリ / 不変条件全文 / 手順概略 /
関連する発見ログ項目 / 参照パス（あれば）。マニフェスト外の情報を足さないこと。`

const implPrompt = (m, brief, gates) => `以下のブリーフに従って実装してください。

# マイルストーン ${m.id}: ${m.title}

${brief}

ルール:
- 不変条件に抵触する変更が必要になったら、実装せず停止して報告すること
  （halted=true + halt_reason。その場合 gates_green=false、gate_output は「未実行」とする）
- 実装中に「仕様・設計の記述と現実のコードが食い違う」箇所を見つけたら、
  勝手に解釈して進めず、discoveries に構造化して報告すること:
  what（何が）/ mismatch（どう食い違うか）/ response（あなたの対応 — 回避した/保留した）
- 完了時に以下のゲートを自分で実行し、結果（生の出力の要点）を gate_output で報告すること:
${gates.map(g => `  - ${g}`).join('\n')}
- テストを通すためにテスト側を弱める変更は禁止
- 作成・変更するテストの名前（test タイトルまたは describe）に、検証対象の
  B 行 ID を含めること（例: test("B-3: 在庫ゼロは 409 を返す", ...)）。
  1 テストが複数 B 行を検証するなら全 ID を列挙する`

const fixPrompt = (m, brief, gates, gateOutput) => `マイルストーン ${m.id}（${m.title}）の実装後、以下のゲートが赤になっています。
原因を調べて修正してください。

ゲート出力の要点:
${gateOutput}

実装時のブリーフ（不変条件全文を含む — 修正もこの制約下で行うこと）:
${brief}

ルール:
- テストを通すためにテスト側を弱める変更は禁止
- 不変条件に抵触する変更が必要になったら、実装せず停止して報告すること
  （halted=true + halt_reason。その場合 gates_green=false、gate_output は「未実行」とする）
- 仕様・設計との食い違いを見つけたら discoveries に構造化して報告すること
- 修正後、以下のゲートを自分で実行し、結果を gate_output で報告すること:
${gates.map(g => `  - ${g}`).join('\n')}`

const verifyPrompt = (gates) => `次のゲートコマンドを順に実行し、すべて緑か確認してください。コードの修正はしないこと。
実装エージェントの自己申告の検証が目的です。赤があれば gate_output に生の出力の要点を入れること:
${gates.map(g => `- ${g}`).join('\n')}`

const discoveryPrompt = (m, discoveries) => `あなたは発見ログの還流係です。マイルストーン ${m.id} の実装エージェントが報告した
以下の [発見]（仕様・設計と現実のコードの食い違い）を処理してください。

発見（JSON）:
${JSON.stringify(discoveries.map((d, index) => ({ index, what: d.what, mismatch: d.mismatch, response: d.response })), null, 2)}

手順（各発見ごと）:
1. ${DESIGN} の発見ログに「[発見] <何が> <どう食い違うか> <対応>」形式で追記する（全件必須）
2. 影響を分類する:
   - design.md の記述修正で済む → design.md の該当記述を修正し、impact=design_only
   - spec.md の振る舞い（B 行の意味・ゴール・スコープ）に波及する → **spec.md は修正せず**
     impact=spec_impact（ユーザー裁定に回る）
   - 迷ったら spec_impact に倒す（裁定の取りこぼしの方が高くつく）
spec.md は読んでよいが修正しないこと。`

const statePrompt = (mid) => `${STATE} の impl.milestones_done に ${mid} を追記してください。
他のキーは変更しないこと。すでに含まれていれば何もしない。`

const recordPrompt = (m, discoveries) => `${DESIGN} の発見ログに、マイルストーン ${m.id} の実装エージェントが報告した以下の [発見] を
「[発見] <何が> <どう食い違うか> <対応>」形式で全件追記してください。
追記のみ行い、既存記述の修正・分類・その他の変更はしないこと（この後ユーザー裁定に回る）。

発見（JSON）:
${JSON.stringify(discoveries.map(d => ({ what: d.what, mismatch: d.mismatch, response: d.response })), null, 2)}`

// 早期リターン（halted / gate_red）でも [発見] を design.md に永続化してから返す —
// 「会話（戻り値）にしか存在しない発見」を作らない。記録係無応答時は recorded: false で
// 返し、メインに追記を委ねる
async function recordDiscoveries(m, discoveries, phase) {
  if (discoveries.length === 0) return true
  const ack = await agent(recordPrompt(m, discoveries), { label: `発見記録:${m.id}`, phase, model: 'sonnet', effort: 'low', schema: ACK_SCHEMA })
  return Boolean(ack && ack.done)
}

// ---- メインループ（逐次 — 並列化はメインの領分）--------------------------------

const setup = await agent(setupPrompt, { label: '入口確認', phase: '入口確認', model: 'sonnet', effort: 'low', schema: SETUP_SCHEMA })
if (!setup) throw new Error('入口確認エージェントが結果を返さなかった')
if (!setup.files_ok) {
  return { status: 'blocked', reason: `plan.md / state.yaml の欠落・不整合: ${setup.missing || '不明'}` }
}

const remaining = setup.milestones.filter(m => !m.done)
if (remaining.length === 0) {
  return { status: 'done', completed: [], note: '残りマイルストーンなし — 全件 milestones_done 済み' }
}
log(`残りマイルストーン ${remaining.length} 件: ${remaining.map(m => m.id).join(' → ')}（逐次）`)

const completed = []
const allDiscoveries = []

for (const m of remaining) {
  // 1. ブリーフ組み立て（抽出係 — マニフェスト記載セクションだけを取り出す）
  const briefed = await agent(briefPrompt(m), { label: `ブリーフ:${m.id}`, phase: `${m.id} ブリーフ`, model: 'sonnet', schema: BRIEF_SCHEMA })
  if (!briefed) {
    return { status: 'blocked', reason: `${m.id}: ブリーフ組み立て係が結果を返さなかった`, completed, discoveries: allDiscoveries }
  }
  if (!Array.isArray(briefed.gates) || briefed.gates.length === 0) {
    return { status: 'blocked', reason: `${m.id}: plan.md からゲートを抽出できなかった — plan のマニフェストを確認すること`, completed, discoveries: allDiscoveries }
  }

  // 2. 実装ディスパッチ（モデルはセッション継承 — 実装は能力が要る）。
  //    プロンプトに spec/design のパスを渡さない = 全文を読ませない（希釈防止）
  let report = await agent(implPrompt(m, briefed.brief, briefed.gates), { label: `実装:${m.id}`, phase: `${m.id} 実装`, schema: IMPL_SCHEMA })
  if (!report) {
    return { status: 'gate_red', reason: `${m.id}: 実装エージェントが結果を返さなかった — working tree の状態をメインで確認すること`, completed, discoveries: allDiscoveries }
  }
  if (report.halted) {
    const pending = report.discoveries.map(d => ({ ...d, milestone: m.id }))
    const recorded = await recordDiscoveries(m, pending, `${m.id} 還流`)
    return { status: 'halted', milestone: m.id, reason: report.halt_reason || '不変条件抵触（詳細未報告）', discoveries: [...allDiscoveries, ...pending], discoveriesRecorded: recorded, completed }
  }

  // 3. ゲート検証 — 実装エージェントの「通りました」を信用せず独立に再実行
  let verified = await agent(verifyPrompt(briefed.gates), { label: `ゲート検証:${m.id}`, phase: `${m.id} 検証`, model: 'sonnet', effort: 'low', schema: VERIFY_SCHEMA })
  let fixRounds = 0
  while ((!verified || !verified.green) && fixRounds < MAX_FIX_ROUNDS) {
    fixRounds += 1
    log(`${m.id}: ゲート赤 — 修正ディスパッチ ${fixRounds}/${MAX_FIX_ROUNDS}`)
    const fix = await agent(fixPrompt(m, briefed.brief, briefed.gates, verified ? verified.gate_output : '検証エージェント無応答'), { label: `修正:${m.id}#${fixRounds}`, phase: `${m.id} 実装`, schema: IMPL_SCHEMA })
    if (!fix) break
    if (fix.halted) {
      const pending = [...report.discoveries, ...fix.discoveries].map(d => ({ ...d, milestone: m.id }))
      const recorded = await recordDiscoveries(m, pending, `${m.id} 還流`)
      return { status: 'halted', milestone: m.id, reason: fix.halt_reason || '不変条件抵触（詳細未報告）', discoveries: [...allDiscoveries, ...pending], discoveriesRecorded: recorded, completed }
    }
    report = { ...report, discoveries: [...report.discoveries, ...fix.discoveries] }
    verified = await agent(verifyPrompt(briefed.gates), { label: `ゲート検証:${m.id}#${fixRounds}`, phase: `${m.id} 検証`, model: 'sonnet', effort: 'low', schema: VERIFY_SCHEMA })
  }
  if (!verified || !verified.green) {
    const pending = report.discoveries.map(d => ({ ...d, milestone: m.id }))
    const recorded = await recordDiscoveries(m, pending, `${m.id} 還流`)
    return {
      status: 'gate_red',
      milestone: m.id,
      detail: verified ? verified.gate_output : 'ゲート検証エージェントが結果を返さなかった',
      completed,
      discoveries: [...allDiscoveries, ...pending],
      discoveriesRecorded: recorded,
    }
  }

  // 4. [発見] の還流 — design.md 発見ログへの追記（全件）+ 影響分類
  let specImpacts = []
  if (report.discoveries.length > 0) {
    const handled = await agent(discoveryPrompt(m, report.discoveries), { label: `発見還流:${m.id}`, phase: `${m.id} 還流`, model: 'sonnet', schema: DISCOVERY_SCHEMA })
    if (!handled) {
      // 還流係無応答 — 発見を失わないため記録だけ行い、安全側で全件 spec_impact 扱いにして裁定に回す
      specImpacts = report.discoveries.map(d => ({ ...d, milestone: m.id, impact: 'spec_impact', reason: '還流係無応答 — 安全側で裁定に回す' }))
      await recordDiscoveries(m, specImpacts, `${m.id} 還流`)
      allDiscoveries.push(...specImpacts)
    } else {
      for (const c of handled.classified) {
        const d = report.discoveries[c.index]
        if (!d) {
          log(`発見還流係の index ${c.index} が不正 — 対応する発見を特定できない`)
          continue
        }
        const entry = { ...d, milestone: m.id, impact: c.impact, reason: c.reason }
        allDiscoveries.push(entry)
        if (c.impact === 'spec_impact') specImpacts.push(entry)
      }
      // 分類から漏れた発見は安全側で裁定に回す（集計にも含める）
      const judged = new Set(handled.classified.map(c => c.index))
      report.discoveries.forEach((d, i) => {
        if (!judged.has(i)) {
          const entry = { ...d, milestone: m.id, impact: 'spec_impact', reason: '還流係の分類から漏れた — 安全側で裁定に回す' }
          specImpacts.push(entry)
          allDiscoveries.push(entry)
        }
      })
    }
  }
  if (specImpacts.length > 0) {
    // spec 波及は一時停止してユーザー裁定 — このマイルストーンの milestones_done は記録しない
    // （裁定の結果次第で plan からやり直しがあり得るため）
    return { status: 'needs_adjudication', milestone: m.id, items: specImpacts, completed, discoveries: allDiscoveries }
  }

  // 5. 進捗の永続化 — 途中クラッシュで完了済みマイルストーンが失われないよう都度記録する
  await agent(statePrompt(m.id), { label: `state更新:${m.id}`, phase: `${m.id} 完了`, model: 'sonnet', effort: 'low', schema: ACK_SCHEMA })
  completed.push(m.id)
  log(`${m.id} 完了: ゲート緑（修正 ${fixRounds} 回）/ 発見 ${report.discoveries.length} 件`)
}

return { status: 'done', completed, discoveries: allDiscoveries }
