// @ts-nocheck — Workflow スクリプトはトップレベル return を持つ実行フォーマットで、tsc の
// モジュール検査対象外（TS1108 で後続のフロー解析が壊れ、偽の未使用変数警告が出る）
// 再開は**新規実行**で行うこと — resumeFromRunId（キャッシュ再生）を使わない。
// このスクリプトのプロンプトは同一 args なら不変のため、resume では全 agent 呼び出しが
// キャッシュ再生され、ディスク（台帳 / state.yaml / 対象ドキュメント）を読み直さずに
// 停止時の結果をそのまま返す（2026-07-08 実測: 13ms・トークン 0 で旧結果が再返却）。
// 継続状態はディスクが保持し、入口確認エージェントが続き（次ラウンド / 残マイルストーン）を
// 導出する — 新規実行が正しい再開手段。
export const meta = {
  name: 'dandori-refine',
  description: 'dandori refine 工程の決定的フロー — 機械検査先行 → 3レーン軽量レビュー → 採否フィルタ → 適用 + ゲート再実行。1ラウンド固定、ループなし',
  whenToUse: 'dandori-refine スキル実行時、Workflow が使える環境で決定的な制御フローを機械駆動する。入口条件（codereview passed）の確認と state.yaml 更新、採否一覧の提示はメインエージェントが行う。',
}

// ============================================================================
// dandori-refine workflow
//
// SKILL.md の1ラウンド固定フローをスクリプトに固定する。狙いは codereview と同じく
// 情報隔離の構造的な強制 — 「spec.md / design.md をどのレーンにも渡さない」（この工程の
// 照合先は仕様ではなく既存コードの現物）がプロンプトテンプレートで固定される。
// 反証フェーズはなく、接地フィルタ・振る舞い保存フィルタ + ゲート再実行が決着装置。
//
// args:
//   diffCommand  (必須) レビュー対象差分の取得コマンド（codereview と同じ diff）
//   gates        (必須) 正準ゲートコマンドの配列（適用後の再実行に使う）
//   models       (任意) 役割別のモデル上書き（例: {"refute":"opus"}）。役割語彙は role() 参照
//   efforts      (任意) 役割別の reasoning effort 上書き（low|medium|high|xhigh|max）
//   mechCommands (任意) formatter / linter の正準コマンド配列（resources.md 記載のもの。
//                なければ機械検査ステップをスキップ — この工程で導入作業はしない）
//   resources    (任意) .dandori/resources.md のパス（提案の接地先として規約を参照させる）
//   mapDir       (任意) .dandori/map/ のパス（同上）
//   workRoot     (任意) コードの作業ルート（worktree 並列レーン等、コードがセッションの
//                作業ディレクトリと別の場所にあるとき指定）。機械検査・レビュー・採否・適用の
//                プロンプトに決定的に注入され、コードの読み書きとゲート実行をこの中に閉じ込める
//
// 戻り値 status:
//   done     — 適用分が working tree に反映され全ゲート緑（適用ゼロ件も done）
//   gate_red — 適用後のゲートが revert でも緑に戻らなかった。メインで裁定
//   blocked  — 入口ゲートが赤（codereview 通過後の手動編集等） — 適用前に検出して中断
// ============================================================================

// Claude Code の Workflow ツールは環境によって args を JSON 文字列で渡す — オブジェクトに正規化する
const A = typeof args === 'string' ? JSON.parse(args) : args

if (!A || !A.diffCommand || !Array.isArray(A.gates) || A.gates.length === 0) {
  throw new Error('args に diffCommand / gates（配列）が必要。任意: mechCommands / resources / mapDir / workRoot / models / efforts')
}

// 型の明示検査 — 単一パス・単一コマンド想定の args に配列を渡すと、後段の文字列操作が
// 「... is not a function」で即死し、期待形が読み取れないまま workflow が落ちる
// （2026-07-25 実戦観測: codereview の resources に配列を渡して絶対パスガードがクラッシュ）
const requireStr = (name, v) => {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`args.${name} は空でない文字列で渡すこと（現在: ${JSON.stringify(v)}）`)
  }
  return v
}
requireStr('diffCommand', A.diffCommand)
for (const name of ['resources', 'mapDir', 'workRoot']) {
  if (A[name] !== undefined && A[name] !== null) requireStr(name, A[name])
}
A.gates.forEach((g, i) => requireStr(`gates[${i}]`, g))
if (A.mechCommands !== undefined && A.mechCommands !== null) {
  if (!Array.isArray(A.mechCommands)) {
    throw new Error(`args.mechCommands はコマンドの配列で渡すこと（現在: ${JSON.stringify(A.mechCommands)}）`)
  }
  A.mechCommands.forEach((c, i) => requireStr(`mechCommands[${i}]`, c))
}

const DIFF_CMD = A.diffCommand
const GATES = A.gates
const MECH = Array.isArray(A.mechCommands) ? A.mechCommands : []
const RESOURCES = A.resources || null
const MAP_DIR = A.mapDir || null

// 作業ルート（任意）— サブエージェントはセッションの主作業ディレクトリで動くため、コードが
// 別の場所（レーン worktree 等）にあるときはプロンプト注入で作業場所を固定する
const WORK_ROOT = A.workRoot ? A.workRoot.replace(/\/+$/, '') : null
const workRootNote = WORK_ROOT
  ? `

作業ルート: ${WORK_ROOT}
- 対象コードベースはこのディレクトリ。コードの読み書き・コマンド実行はすべてこの中で行うこと
- 相対パス（src/ 等）はこのルート基準。コマンドは \`cd ${WORK_ROOT} && <コマンド>\` で実行する
- このディレクトリ外のコード（他の worktree・リポジトリ）を変更しないこと`
  : ''

// agent() は無応答（ユーザー skip / 終端 API エラー）では null を返すが、StructuredOutput の
// リトライ上限（5 回）超過などでは reject する — throw を伝播させると workflow 全体が failed になり、
// ディスク上の台帳・state が正しくても部分成功ごと失われる（2026-07-23 実戦観測・529 死亡とは別原因）。
// throw は null に縮退させ、既存の無応答パス（安全側の分岐 + 新規実行での再開）へ合流させる
const tryAgent = (prompt, opts) => agent(prompt, opts).then(
  (r) => r,
  (e) => {
    log(`エージェント失敗（${(opts && opts.label) || '?'}）: ${(e && e.message) || e} — 無応答（null）として縮退`)
    return null
  },
)

// ---- 役割別のモデル / effort -----------------------------------------------
// 呼び出し点の base が既定（= 従来の固定値）。args.models / args.efforts で役割単位に
// 上書きする。役割語彙（4 workflow 共通。この工程で登場しない役割もある）:
//   finder — レビューレーン（recall 係）
//   refute — 反証（精度ゲート。生き残った指摘だけが還流するため、ここが精度の上限を決める）
//   fix    — 実装・修正・適用・反映（既定はモデル未指定 = メインからの継承）
//   brief  — ブリーフ組み立て（マニフェスト記載セクションの抽出）
//   triage — 採否・還流の判定
//   scribe — 台帳・state への転記係（判断を持たない。逐語転記のみ）
//   judge  — 収束判定（チェッカー出力の逐語転記）
//   mech   — ゲート・機械検査の実行と結果報告
// 値に null を渡すと未指定（メインからの継承）に落とせる。
const ROLES = new Set(['finder', 'refute', 'fix', 'brief', 'triage', 'scribe', 'judge', 'mech'])
const MODELS = A.models || {}
const EFFORTS = A.efforts || {}
for (const [key, table] of [['models', MODELS], ['efforts', EFFORTS]]) {
  if (typeof table !== 'object' || Array.isArray(table)) {
    throw new Error(`args.${key} は役割名をキーに持つオブジェクトで渡すこと（現在: ${JSON.stringify(table)}）`)
  }
  for (const name of Object.keys(table)) {
    if (!ROLES.has(name)) {
      throw new Error(`args.${key} の役割名 "${name}" は未知 — 使える役割は ${[...ROLES].join(' / ')}`)
    }
  }
}
const role = (name, base = {}) => {
  const o = { ...base }
  if (name in MODELS) { if (MODELS[name] === null) delete o.model; else o.model = MODELS[name] }
  if (name in EFFORTS) { if (EFFORTS[name] === null) delete o.effort; else o.effort = EFFORTS[name] }
  return o
}

// ---- schemas ---------------------------------------------------------------

const PROPOSALS_SCHEMA = {
  type: 'object',
  required: ['proposals'],
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'target', 'change', 'grounding'],
        properties: {
          title: { type: 'string', description: '提案の一行要約' },
          target: { type: 'string', description: '対象箇所（ファイル:行）' },
          change: { type: 'string', description: '具体的な変更内容' },
          grounding: { type: 'string', description: '接地 — 既存コードの実例（ファイル:行）または規約の参照' },
        },
      },
    },
  },
}

const FILTER_SCHEMA = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'accept', 'reason', 'behavior_change'],
        properties: {
          index: { type: 'integer', description: '渡した提案 JSON の index' },
          accept: { type: 'boolean' },
          reason: { type: 'string', description: '棄却理由（採用なら接地確認の要点）' },
          behavior_change: { type: 'boolean', description: 'true = 振る舞い・公開 API・永続データ形式に触れるため棄却（design.md 発見ログ行き候補）' },
        },
      },
    },
  },
}

const APPLY_SCHEMA = {
  type: 'object',
  required: ['applied', 'reverted', 'gates_green', 'gate_output'],
  properties: {
    applied: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'note'],
        properties: { title: { type: 'string' }, note: { type: 'string', description: '適用内容の一行要約' } },
      },
    },
    reverted: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'reason'],
        properties: { title: { type: 'string' }, reason: { type: 'string', description: 'revert 理由（どのゲートがどう赤くなったか）' } },
      },
    },
    gates_green: { type: 'boolean', description: '最終状態で全ゲート緑か' },
    gate_output: { type: 'string', description: '最終ゲート実行の生の出力の要点' },
  },
}

const MECH_SCHEMA = {
  type: 'object',
  required: ['summary'],
  properties: {
    summary: { type: 'string', description: '実行したコマンドと修正内容の要点（修正ゼロならその旨）' },
  },
}

// ---- プロンプトテンプレート（情報隔離はここで固定される）---------------------
// spec.md / design.md はどのレーンにも渡さない — 照合先は既存コードの現物。
// 仕様との適合は impl / gate、テストの忠実度は codereview の管轄。

const GROUNDING_SOURCES = [
  '既存コードの実例（ファイル:行）',
  RESOURCES ? `${RESOURCES} 記載の規約` : null,
  MAP_DIR ? `${MAP_DIR} 記載の規約` : null,
].filter(Boolean).join('、または ')

const COMMON_RULES = `ルール:
- 提案には必ず接地を付けること — ${GROUNDING_SOURCES}。接地のない好みの表明は報告しない
- 振る舞いを変える提案はしない。仕様・公開 API・永続データ形式に触れるものは対象外
- 各提案に、対象箇所（ファイル:行）と具体的な変更内容を付けること
- 修正は行わない。提案の列挙だけを返すこと`

// ゲート実行の規約 — 「起動した」と「完走を見た」を分ける。入口ゲート確認エージェントが
// 全量テスト（数分）の完了を待たず green=false を返し、原因のない偽 blocked になった
// （2026-07-25 実戦観測）。完走した exit code だけを判定根拠にさせる
const GATE_PROTOCOL = `ゲート実行の規約:
- 各コマンドは前景で実行し、**プロセスの終了と exit code を確認するまで判定しない**。
  バックグラウンド実行（\`&\` / run_in_background）や、途中出力を見ただけの打ち切り判断は禁止
- 全量スイートは数分かかることがある。タイムアウトで切れた場合はタイムアウトを延ばして
  完走させ、完走した exit code のみを根拠にすること（未完走を赤として報告しない）
- 赤/緑の根拠は各コマンドの exit code。出力中のエラー文字列だけで赤と決めない`

const LANE_HEADER = `あなたは実装コードのリファインメントレビューアです。コードベースへの読み取りアクセスがあります。
レビュー対象の差分は次のコマンドで取得すること: ${DIFF_CMD}${workRootNote}`

const LANES = {
  idiom: {
    label: 'イディオム一致',
    prompt: `${LANE_HEADER}

照合先: 改変ファイルの周辺既存コード（同じディレクトリ・同じレイヤーの現物を読むこと）。
問い: 命名・コメント密度・エラーハンドリングの流儀が周囲と揃っているか。

${COMMON_RULES}`,
  },
  reinvention: {
    label: '再発明・簡素化',
    prompt: `${LANE_HEADER}

照合先: コードベース全体。
問い: 既存ヘルパー・ユーティリティの再実装はないか。デッドコード、不要な抽象、防衛過剰な実装はないか。

${COMMON_RULES}`,
  },
  testquality: {
    label: 'テスト品質',
    prompt: `${LANE_HEADER}

照合先: 既存テストの流儀（既存のテストファイルの現物を読むこと）。
問い: 過剰モック、脆い assertion、重複フィクスチャ、テストとして読みにくい構造はないか。

${COMMON_RULES}`,
  },
}

const mechPrompt = `リファインメント工程の機械検査を実行してください。formatter / linter の正準コマンド:
${MECH.map(c => `- ${c}`).join('\n')}

- formatter の自動修正はそのまま適用してよい（working tree に書く）
- linter の指摘のうち自動修正（--fix 等）で潰せるものは潰す。手動判断が要る指摘は
  修正せず summary に列挙する（後段のレビューレーンが扱う）
- コマンドの導入・設定変更はしない — スコープ外の変更を diff に混ぜない${workRootNote}`

const filterPrompt = (proposals) => `あなたはリファインメント提案の採否フィルタです。コードベースへの読み取りアクセスがあります。
接地として許される参照先: ${GROUNDING_SOURCES}。
以下の提案を検査し、採用 / 棄却を判定してください。

提案（JSON）:
${JSON.stringify(proposals.map((p, index) => ({ index, title: p.title, target: p.target, change: p.change, grounding: p.grounding })), null, 2)}

判定基準（各提案ごと。必ず対象箇所と接地先の現物を読んで確認すること）:
1. 接地フィルタ — grounding に挙げられた実例・規約が実在し、提案を実際に支持しているか。
   接地が空・実在しない・提案と無関係なら棄却
2. 振る舞い保存フィルタ — 仕様の振る舞い・公開 API・永続データ形式に触れるなら棄却し、
   behavior_change=true を付ける（リファインメントではなく変更のため、正規のフローに乗せる）
3. 採否に迷ったら棄却する（保守側に倒す）。「議論して磨く」対象にはしない

修正は行わない。判定の列挙だけを返すこと。${workRootNote}`

const applyPrompt = (accepted) => `あなたはリファインメント提案の適用エージェントです。
採否フィルタを通過した以下の提案を working tree に適用してください。

提案（JSON）:
${JSON.stringify(accepted.map(p => ({ lane: p.lane, title: p.title, target: p.target, change: p.change, grounding: p.grounding })), null, 2)}

ルール:
- 提案の範囲を超える変更はしない（振る舞い・公開 API・永続データ形式は不変）
- **import の追加を伴う適用（既存部品の再利用等）は、追加する import の依存方向を先に確認する**こと —
  循環 import（特に barrel 経由）を作るとフィーチャー外の無関係なスイートが収集エラーで壊れる。
  循環を作る提案は適用せず reverted に理由つきで含めること
- 適用に無理があると分かった提案（前提が現物と食い違う等）は適用せず reverted に理由つきで含めること
- 全提案の適用後に以下のゲートを実行し、赤になったら**原因の適用だけを revert して**再実行、
  全ゲート緑の状態で終えること。revert した提案は reverted に理由つきで含めること:
${GATES.map(g => `  - ${g}`).join('\n')}
- 最終状態のゲート結果（生の出力の要点）を gate_output で報告すること

${GATE_PROTOCOL}${workRootNote}`

// ---- フロー（1ラウンド固定 — ループしない）------------------------------------

// 1. 機械検査を先に — formatter が直せるものにレビューレーンを使わない
if (MECH.length > 0) {
  log(`機械検査先行: formatter / linter（${MECH.length} 本）`)
  const mech = await tryAgent(mechPrompt, { label: '機械検査', phase: '機械検査', schema: MECH_SCHEMA, ...role('mech', { model: 'sonnet', effort: 'low' }) })
  log(mech ? `機械検査: ${mech.summary}` : '機械検査エージェント無応答 — スキップして続行')
} else {
  log('機械検査: 正準コマンド未宣言のためスキップ（導入提案は dandori-doctor の管轄）')
}

// 2. 3レーン並列 → レーンごとに完了次第、採否フィルタへ（barrier なし）。
//    あわせて入口ゲートの現況確認を並走させる — codereview 通過後の手動編集等で
//    ゲートが赤いまま適用に進むと、適用エージェントが存在しない原因を revert で探し始める
const laneKeys = Object.keys(LANES)
const entryGatePrompt = `次のゲートコマンドを順に実行し、すべて緑か確認してください。コードの修正はしないこと。
赤があれば gate_output に生の出力の要点を入れること:
${GATES.map(c => `- ${c}`).join('\n')}

${GATE_PROTOCOL}
- 全コマンドを完走させて exit code を確認できた場合のみ verified=true にすること。
  完走を確認できなかった（タイムアウト・中断・バックグラウンド化した）場合は
  verified=false で返す — 未完走を赤として報告しないこと
- exit_codes には「<コマンド> → <exit code>」を全コマンド分列挙すること${workRootNote}`

const ENTRY_GATE_SCHEMA = {
  type: 'object',
  required: ['green', 'verified', 'gate_output'],
  properties: {
    green: { type: 'boolean', description: '全コマンドの exit code が 0 か' },
    verified: { type: 'boolean', description: '全コマンドを完走させ exit code を確認できたか' },
    exit_codes: { type: 'string', description: '「<コマンド> → <exit code>」の全コマンド分の列挙' },
    gate_output: { type: 'string' },
  },
}

const entryGateThunk = async () => {
  // 未完走のまま赤を返された場合は 1 回だけ再実行する — 偽 blocked は「原因のない赤」を
  // 探す作業をユーザーに投げ、レビュー結果ごと捨てることになるため、赤の確定にコストをかける
  let g = await tryAgent(entryGatePrompt, {
    label: '入口ゲート確認', phase: 'レビュー', schema: ENTRY_GATE_SCHEMA,
    ...role('mech', { model: 'sonnet', effort: 'low' }),
  })
  if (g && !g.verified) {
    log('入口ゲート: 完走を確認できていない報告（未完走・タイムアウト）— 1 回だけ再実行')
    g = await tryAgent(entryGatePrompt, {
      label: '入口ゲート確認(再実行)', phase: 'レビュー', schema: ENTRY_GATE_SCHEMA,
      ...role('mech', { model: 'sonnet', effort: 'low' }),
    })
  }
  return {
    entryGate: true,
    green: g ? g.green && g.verified : false,
    gate_output: g
      ? `${g.gate_output || ''}${g.exit_codes ? `\nexit codes: ${g.exit_codes}` : ''}${g.verified ? '' : '\n（完走を確認できないままの報告 — ゲートの実行環境かタイムアウトを疑う）'}`
      : '入口ゲート確認エージェント無応答 — 安全側で赤扱い',
  }
}

const laneThunks = laneKeys.map(key => async () => {
  const lane = LANES[key]
  const r = await tryAgent(lane.prompt, { label: `レーン:${lane.label}`, phase: 'レビュー', schema: PROPOSALS_SCHEMA, ...role('finder', { model: 'sonnet' }) })
  if (!r || r.proposals.length === 0) return { accepted: [], rejected: [] }
  const tagged = r.proposals.map(p => ({ ...p, lane: key }))

  const f = await tryAgent(filterPrompt(tagged), { label: `採否:${lane.label}`, phase: '採否フィルタ', schema: FILTER_SCHEMA, ...role('triage', { model: 'sonnet', effort: 'low' }) })
  if (!f) {
    // フィルタ無応答なら保守側に倒す — 全棄却（誤適用より取りこぼしが安い工程）
    return { accepted: [], rejected: tagged.map(p => ({ ...p, reason: '採否フィルタ無応答 — 保守側で棄却' })) }
  }
  const accepted = []
  const rejected = []
  for (const v of f.verdicts) {
    const p = tagged[v.index]
    if (!p) {
      log(`採否:${lane.label}: フィルタの index ${v.index} が不正 — 対応する提案を特定できない`)
      continue
    }
    // accept と behavior_change の自己矛盾はコードで棄却側に強制する —
    // 振る舞い変更が無審査で適用される経路を残さない
    if (v.accept && !v.behavior_change) accepted.push(p)
    else rejected.push({ ...p, reason: v.accept ? `フィルタが accept と behavior_change を同時に返した — 保守側で棄却: ${v.reason}` : v.reason, behavior_change: v.behavior_change })
  }
  // フィルタの判定から漏れた提案は棄却扱い（黙って適用される方が危険）
  const judged = new Set(f.verdicts.map(v => v.index))
  tagged.forEach((p, i) => {
    if (!judged.has(i)) rejected.push({ ...p, reason: '採否フィルタの判定から漏れた — 保守側で棄却' })
  })
  return { accepted, rejected }
})

const parallelResults = (await parallel([entryGateThunk, ...laneThunks])).filter(Boolean)
const entryGate = parallelResults.find(r => r.entryGate)
const results = parallelResults.filter(r => !r.entryGate)
const accepted = results.flatMap(r => r.accepted)
const rejected = results.flatMap(r => r.rejected)
log(`レビュー完了: 採用候補 ${accepted.length} 件 / 棄却 ${rejected.length} 件`)

if (!entryGate || !entryGate.green) {
  return {
    status: 'blocked',
    reason: '入口ゲートが赤 — refine の適用前に緑へ戻すこと（codereview 通過後に working tree が変わった疑い）',
    detail: entryGate ? entryGate.gate_output : '入口ゲート確認スレッドが結果を返さなかった',
    accepted,
    rejected,
  }
}

// behavior_change の棄却は design.md 発見ログ行きの候補としてメインに返す
const behaviorChanges = rejected.filter(p => p.behavior_change)

// 3. 適用 + ゲート再実行（単一エージェント — 並列適用の衝突を避ける）
if (accepted.length === 0) {
  return { status: 'done', applied: [], rejected, behaviorChanges, note: '採用ゼロ — working tree 無変更、ゲートは codereview 通過時の緑のまま' }
}

const apply = await tryAgent(applyPrompt(accepted), { label: '適用', phase: '適用 + ゲート', schema: APPLY_SCHEMA, ...role('fix') })
if (!apply) {
  return { status: 'gate_red', reason: '適用エージェントが結果を返さなかった — working tree の状態をメインで確認すること', accepted, rejected, behaviorChanges }
}
if (!apply.gates_green) {
  return { status: 'gate_red', detail: apply.gate_output, applied: apply.applied, reverted: apply.reverted, rejected, behaviorChanges }
}

// revert された提案も棄却一覧に合流させる（棄却理由 = ゲート赤）
const finalRejected = [...rejected, ...(apply.reverted || []).map(r => ({ title: r.title, reason: `ゲート赤で revert: ${r.reason}` }))]

return {
  status: 'done',
  applied: apply.applied,
  rejected: finalRejected,
  behaviorChanges,
  gateOutput: apply.gate_output,
}
