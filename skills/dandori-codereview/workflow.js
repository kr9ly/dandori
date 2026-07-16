// @ts-nocheck — Workflow スクリプトはトップレベル return を持つ実行フォーマットで、tsc の
// モジュール検査対象外（TS1108 で後続のフロー解析が壊れ、偽の未使用変数警告が出る）
// 再開は**新規実行**で行うこと — resumeFromRunId（キャッシュ再生）を使わない。
// このスクリプトのプロンプトは同一 args なら不変のため、resume では全 agent 呼び出しが
// キャッシュ再生され、ディスク（台帳 / state.yaml / 対象ドキュメント）を読み直さずに
// 停止時の結果をそのまま返す（2026-07-08 実測: 13ms・トークン 0 で旧結果が再返却）。
// 継続状態はディスクが保持し、入口確認エージェントが続き（次ラウンド / 残マイルストーン）を
// 導出する — 新規実行が正しい再開手段。
export const meta = {
  name: 'dandori-codereview',
  description: 'dandori codereview 工程の決定的ループ — 入口検査 → 4レーン独立レビュー → 台帳追記 → 指摘ごと反証 → 修正 → check-docs ledger 収束判定',
  whenToUse: 'dandori-codereview スキル実行時、Workflow が使える環境で決定的な制御フローを機械駆動する。裁定（spec 波及・escalate 後・minor 採否）と state.yaml 更新はメインエージェントに返す。',
}

// ============================================================================
// dandori-codereview workflow
//
// SKILL.md の制御フローをスクリプトに固定する。狙いは速度ではなく情報隔離の
// 構造的な強制 — 「パスのみ渡す」「台帳をレビュア・反証エージェントに渡さない」
// 「blind レーンに spec/design を渡さない」がプロンプトテンプレートで固定される。
//
// args:
//   specDir         (必須) .dandori/specs/<feature> — spec.md / design.md /
//                   review-ledger.md をこの直下に置く規約
//   diffCommand     (必須) レビュー対象差分の取得コマンド（例: "git diff; git status --porcelain"）
//   gates           (必須) 正準ゲートコマンドの配列（unit / e2e。resources.md の正準を使う）
//   checkDocs       (必須) check-docs.ts の実行プレフィックス（例: "node <dandori-repo>/skills/dandori/scripts/check-docs.ts"）
//   resources       (任意) .dandori/resources.md のパス（周辺整合レーンの規約参照用）
//   mutationCommand (任意) diff スコープ限定のミューテーションテストコマンド
//   maxRounds       (任意) ラウンド数の暴走バックストップ（既定 6）
//
// 戻り値 status:
//   passed             — 反証を生き残る blocker/major がゼロのラウンドが出た
//   escalated          — 再燃 / 停滞 / maxRounds 到達。ユーザー裁定へ
//   needs_adjudication — spec の振る舞いに波及する指摘。ユーザー裁定へ
//   gate_red           — 修正後のゲートが緑にならなかった。impl 修正ループへ
//   blocked            — 入口条件（テスト緑 / ファイル存在）を満たさない
// ============================================================================

// Claude Code の Workflow ツールは環境によって args を JSON 文字列で渡す — オブジェクトに正規化する
const A = typeof args === 'string' ? JSON.parse(args) : args

if (!A || !A.specDir || !A.diffCommand || !Array.isArray(A.gates) || A.gates.length === 0 || !A.checkDocs) {
  throw new Error('args に specDir / diffCommand / gates（配列） / checkDocs が必要。任意: resources / mutationCommand / maxRounds')
}

const SPEC_DIR = A.specDir.replace(/\/+$/, '')
const SPEC = `${SPEC_DIR}/spec.md`
const DESIGN = `${SPEC_DIR}/design.md`
const LEDGER = `${SPEC_DIR}/review-ledger.md`
const RESOURCES = A.resources || null
const DIFF_CMD = A.diffCommand
const GATES = A.gates
const CHECK = A.checkDocs
const MUTATION = A.mutationCommand || null
const MAX_ROUNDS = A.maxRounds || 6

// ---- schemas ---------------------------------------------------------------

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'title', 'detail', 'evidence'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          title: { type: 'string', description: '論点の一行要約（台帳の論点セルになる）' },
          detail: { type: 'string', description: '指摘の内容' },
          evidence: { type: 'string', description: '根拠（ファイル:行）' },
          check: { type: 'string', description: '何を確認すれば白黒つくか（反証フェーズへのヒント。任意）' },
        },
      },
    },
    error: { type: 'string', description: '実行失敗時のみ: 生の出力の要点' },
  },
}

const SCRIBE_SCHEMA = {
  type: 'object',
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'disposition', 'id', 'matched'],
        properties: {
          index: { type: 'integer', description: '渡した指摘 JSON の index' },
          disposition: { type: 'string', enum: ['new', 'rekindle', 'skip_refuted', 'dup_in_round'] },
          id: { type: ['string', 'null'], description: '追記した行の C-n ID（行を追加しなかった skip_refuted / dup_in_round のみ null）' },
          matched: { type: ['string', 'null'], description: '同一論点と照合した既存行の ID（new は null）' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'basis'],
  properties: {
    refuted: { type: 'boolean', description: 'true = 指摘は誤り（反証成立）' },
    basis: { type: 'string', description: '反証の成否の根拠（ファイル:行）を一行で' },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  required: ['fixed', 'needs_adjudication', 'gates_green', 'gate_output'],
  properties: {
    fixed: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'note'],
        properties: { id: { type: 'string' }, note: { type: 'string' } },
      },
    },
    needs_adjudication: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'reason'],
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    gates_green: { type: 'boolean' },
    gate_output: { type: 'string', description: 'ゲート実行の生の出力の要点' },
  },
}

const JUDGE_SCHEMA = {
  type: 'object',
  required: ['verdict', 'exit_code'],
  properties: {
    verdict: { type: 'string', enum: ['passed', 'escalated', 'continue'] },
    exit_code: { type: 'integer', description: 'コマンドの exit code（0 = 形式指摘なし）' },
    notes: { type: 'string', description: '再燃・停滞・形式指摘があればその内容' },
  },
}

const ACK_SCHEMA = {
  type: 'object',
  required: ['done'],
  properties: {
    done: { type: 'boolean' },
    note: { type: 'string', description: '更新できなかった行があればその内容' },
  },
}

const SETUP_SCHEMA = {
  type: 'object',
  required: ['gates_green', 'files_ok', 'max_c_round'],
  properties: {
    gates_green: { type: 'boolean' },
    gate_summary: { type: 'string', description: '赤があれば生の出力の要点' },
    files_ok: { type: 'boolean' },
    missing: { type: 'string', description: '欠けているファイル' },
    max_c_round: { type: 'integer', description: '台帳の C-n 行の最大 Rd（台帳や C 行がなければ 0）' },
  },
}

// ---- プロンプトテンプレート（情報隔離はここで固定される）---------------------

// レーンは発見係（finder）— 精度の担保は反証フェーズ（verifier）に全委譲する。
// 精度をレーンに求めると自己検閲が起き、反証フェーズが飢える（2026-07-08 実測:
// 4 レーンの生報告が計 blocker/major 1 件・反証破棄 0 のまま「毎ラウンド 1 件」の
// プラトーが続いた）
const COMMON_RULES = `ルール（あなたは発見係 — 指摘の白黒は後段の独立反証フェーズが付ける）:
- 見落としは反証フェーズでは回復できないが、偽陽性は反証フェーズが破棄できる。
  疑いは自己検閲せず列挙すること。「確信が持てないから黙る」は禁止
- 照合対象をまず全数列挙し、1 件ずつ疑いを探すこと。目についた 1 件で走査を止めない
- 各指摘に疑いの根拠（ファイル:行）と、可能なら「何を確認すれば白黒つくか」（check）を付けること
- 深刻度は「指摘が真だった場合」の深刻度で付ける。確信度で下げない
  - blocker: 仕様を満たさない / データ破壊・欠損につながる
  - major: エッジケースの欠落、不変条件違反の可能性、隠れた波及
  - minor: 改善提案・可読性。minor だけは反証フェーズを通らずユーザーに直接届くため、
    確信のあるもののみ報告すること
- 修正は行わない。指摘の列挙だけを返すこと`

const LANE_HEADER = `あなたは実装コードの独立レビューアです。コードベースへの読み取りアクセスがあります。
レビュー対象の差分は次のコマンドで取得すること: ${DIFF_CMD}`

const FIDELITY_QUESTION = MUTATION
  ? `テストが仕様の意図した条件を符号化しているか — 実装の現状を追認するだけのオラクルになっていないか。assertion の強さ・境界の網羅そのものはミューテーションテスト（別途実行済み）の結果を正とするため対象外。`
  : `各 B 行の緑のテストが本当にその振る舞いを固定しているか — assertion の強さ、境界条件の網羅、セットアップが仕様の条件を再現しているか。`

const LANES = {
  fidelity: {
    label: 'テスト忠実度',
    prompt: `${LANE_HEADER}

照合先: ${SPEC} を読むこと。
問い: ${FIDELITY_QUESTION}
「実装が spec を満たすか」自体は impl / gate の管轄なので対象外。
走査対象の全数列挙: spec の全 B 行を列挙し、1 行ずつテストとの対応を疑うこと。

${COMMON_RULES}`,
  },
  invariants: {
    label: '不変条件',
    prompt: `${LANE_HEADER}

照合先: ${DESIGN} を読むこと。
問い: 不変条件それぞれについて、diff がそれを破る経路がないか呼び出し元まで遡って検証せよ。
走査対象の全数列挙: design の不変条件を全数列挙し、1 件ずつ破れの疑いを探すこと。

${COMMON_RULES}`,
  },
  // blind レーンには spec / design のパスを渡さない — 仕様を知るレビュアの
  // 「仕様どおりだから OK」バイアスを避けるため、仕様を知らない目を1枚混ぜる
  blind: {
    label: 'blind バグ探し',
    prompt: `${LANE_HEADER}

問い: バグ・エッジケース欠落・並行性問題・リソースリークはないか。
走査対象の全数列挙: diff の全ファイル・全 hunk を走査すること。

${COMMON_RULES}`,
  },
  integration: {
    label: '周辺整合',
    prompt: `${LANE_HEADER}

照合先: ${DESIGN}${RESOURCES ? ` と ${RESOURCES} に記載の規約` : ''} を読むこと。
問い: 呼び出し元への波及、規約違反、design が改変箇所と宣言していない場所への影響はないか。
走査対象の全数列挙: 改変ファイルごとに呼び出し元を列挙して 1 件ずつ確認すること。

${COMMON_RULES}`,
  },
}

const scribePrompt = (majors, round) => `あなたは指摘台帳の記録係です。台帳: ${LEDGER}（存在しなければヘッダ行から新規作成する）。
正準形式: | ID | Rd | 深刻度 | 論点（一行） | 処置 | 根拠・理由 |

以下の新規指摘を台帳に追記してください。今ラウンドは Rd=${round}、ID は C-n 系列の連番
（既存の最大 C 番号の続き。R-n 系列とは独立）。

指摘（JSON）:
${JSON.stringify(majors.map((f, index) => ({ index, severity: f.severity, title: f.title, detail: f.detail, evidence: f.evidence })), null, 2)}

手順（各指摘ごと）:
1. 既存行と同一論点かを照合する
   - 同一論点の既存行の処置が「反証破棄」→ 行を追加しない（反証済みの再生産）。disposition=skip_refuted、matched にその ID
   - 同一論点の既存行の処置が**空**（今ラウンドで別レーンが先に記録した未処置行）→ 行を追加しない（同一ラウンド内の重複指摘 — 先行行の側で反証される）。disposition=dup_in_round、matched にその ID
   - 同一論点の既存行の処置がそれ以外（反映済・却下など）→ 新規行を追加。disposition=rekindle、matched にその ID
   - 一致する既存行なし → 新規行を追加。disposition=new
2. 追加する行の論点セルは title を一行で、処置セルは空、根拠・理由セルは evidence を書く

台帳は追記のみ。既存行の書き換え・削除は禁止。`

const refutePrompt = (f) => `以下のコードレビュー指摘を反証してください。指摘は recall 優先の発見係によるもので、
偽陽性を多く含む前提です — この反証が唯一の精度ゲートです。指摘が誤りである可能性 —
事実誤認、実際には到達不能なパス、既存仕様として正当な挙動 — を
コードを読んで確認すること。
「到達不能」を反証根拠にする場合は、コード経路だけでなく**データ由来の到達可能性**
（nullable なカラム・スキーマ変更前から残る古いレコード・部分書き込み・外部からの入力値）を
確認してからにすること — 型注釈や現行コードパスのみを根拠に到達不能と断定しない。
真とも偽とも確定できない場合は refuted=false（生存 — 安全側）とする。
反証の成否と根拠（ファイル:行）を報告すること。
${f.lane === 'mutation' ? '\nこの指摘は生存ミュータント由来。反証の争点は等価ミュータント（意味を変えない変異で、殺しようがない）かどうか。\n' : ''}
指摘 [${f.severity}]: ${f.title}
詳細: ${f.detail}
根拠: ${f.evidence}${f.check ? `\n白黒を付ける確認手段（発見係の提案）: ${f.check}` : ''}
レビュー対象の差分の取得コマンド: ${DIFF_CMD}`

const verdictScribePrompt = (verdicts) => `指摘台帳 ${LEDGER} の処置列を反証結果で更新してください。対象行のみ編集し、他の行は触らないこと。

反証結果(JSON):
${JSON.stringify(verdicts.map(v => ({ id: v.id, refuted: v.refuted, basis: v.basis, rekindleOf: v.rekindleOf })), null, 2)}

- refuted=true → 処置を「反証破棄」にし、根拠・理由セルを反証根拠（basis）で置き換える
- refuted=false かつ rekindleOf あり → 処置を「再燃→<rekindleOf>」にする
- refuted=false かつ rekindleOf なし → 何もしない（処置は修正フェーズで記録される）`

const fixPrompt = (survivors) => `あなたは dandori-impl の修正ループ（単発）を実行する実装エージェントです。
コードレビューの反証フェーズを生き残った以下の指摘を修正してください。

指摘（JSON）:
${JSON.stringify(survivors.map(s => ({ id: s.id, severity: s.severity, lane: s.lane, title: s.title, detail: s.detail, evidence: s.evidence })), null, 2)}

参照: spec = ${SPEC} / design = ${DESIGN}${RESOURCES ? ` / 規約 = ${RESOURCES}` : ''}
指摘台帳: ${LEDGER}

ルール:
- 指摘が spec.md の振る舞い（B 行の意味）に波及する場合は、その指摘を**修正せず**
  needs_adjudication に理由つきで返すこと（ユーザー裁定が必要）
- 指摘が design.md の記述とのズレを含む場合は design.md の発見ログに
  「[発見] <何が> <どう食い違うか> <対応>」形式で追記すること
- テストを通すためにテスト側を弱める変更は禁止
- lane=mutation の指摘（生存ミュータント）はテスト追加で殺すこと
- 作成・変更するテストの名前（test タイトルまたは describe）に、検証対象の B 行 ID を含めること
- 修正した指摘は台帳の該当行（ID で特定）の処置列を「反映済」にし、根拠・理由セルに対応を一行で記録すること
- 完了時に以下のゲートを自分で実行し、緑になるまで修正すること。生の出力の要点を gate_output で報告すること:
${GATES.map(g => `  - ${g}`).join('\n')}`

const zeroRoundPrompt = (round) => `指摘台帳 ${LEDGER} の末尾に次の 1 行をそのまま追記してください。他の行は変更しないこと:

<!-- round: C Rd=${round} 指摘なし -->`

const judgePrompt = `次のコマンドを実行し、出力とコマンドの exit code を報告してください:
${CHECK} ledger ${LEDGER}

出力の「C（dandori-codereview）」節の判定を verdict に対応づける:
「passed」→ passed、「escalated」→ escalated、「継続」→ continue。
C 系列の節が出力にない場合は continue。
再燃・停滞の行や台帳の形式指摘（exit 1 の指摘一覧）があれば notes に要約すること。`

const setupPrompt = `dandori-codereview の入口検査を行ってください。

1. 次のゲートコマンドを順に実行し、すべて緑か確認する:
${GATES.map(g => `   - ${g}`).join('\n')}
2. ${SPEC} と ${DESIGN} が存在するか確認する
3. ${LEDGER} が存在すれば読み、C-n 行の Rd 列の最大値を max_c_round として報告する
   （台帳がない・C 行がない場合は 0）

コードの修正はしないこと。赤のゲートがあれば gate_summary に生の出力の要点を入れること。`

const mutationPrompt = `ミューテーションテストを diff スコープ限定で実行してください（改変行だけを変異させる。
フルコードベースへの実行はしない — 実行時間が破綻する）。
レビュー対象の差分の取得コマンド: ${DIFF_CMD}
実行コマンド: ${MUTATION}

生存ミュータントそれぞれを指摘として返すこと:
- severity: major
- title: どのファイル:行のどんな変異が生き残ったか（一行）
- detail: その変異が示す「どのテストにも固定されていない振る舞い」
- evidence: ファイル:行

実行に失敗した場合は findings を空配列にし、error に生の出力の要点を入れて返すこと。`

// ---- 台帳書き込みの直列化 ----------------------------------------------------
// レーン完了ごとに反証をパイプライン開始する（barrier を置かない）一方、
// 台帳 (review-ledger.md) への追記は並行させると競合するため、書き込み系
// エージェントだけ Promise チェーンで直列化する。

let ledgerChain = Promise.resolve()
const serializedLedger = (fn) => {
  const p = ledgerChain.then(fn)
  ledgerChain = p.then(() => {}, () => {})
  return p
}

// ---- レーン1本分のチェーン: レビュー → 台帳追記 → 指摘ごと反証 ------------------

const minors = []

// 指摘リストを 台帳追記 → 反証 に流す（レーン・ミューテーション共通の後段）
async function processFindings(laneKey, findings, round, label) {
  const tagged = findings.map(f => ({ ...f, lane: laneKey }))
  // minor は台帳に載らないため run 内の重複だけ機械排除する（同一 title の再報告 —
  // ラウンドを跨いで別レーンが同じ指摘を再発見するケース）。言い換えられた重複の照合は
  // 提示前のメインの仕事（SKILL.md「重複排除して最後に一括で提示」）
  for (const f of tagged.filter(f => f.severity === 'minor')) {
    if (!minors.some(m => m.title === f.title)) minors.push(f)
  }
  const majors = tagged.filter(f => f.severity !== 'minor')
  if (majors.length === 0) return []

  const scribe = await serializedLedger(() =>
    agent(scribePrompt(majors, round), {
      label: `台帳:${laneKey}`, phase: `Rd${round} 台帳`, model: 'sonnet', effort: 'low', schema: SCRIBE_SCHEMA,
    }))
  if (!scribe) {
    // 記録係が無応答でも指摘は消さない — 台帳行なし（id null）のまま反証に回す
    log(`${label}: 台帳記録係が無応答 — 指摘 ${majors.length} 件を台帳行なしで反証に回す`)
    return refuteAll(majors.map((f, i) => ({ ...f, id: `C-?(${laneKey}:${i})`, rekindleOf: null })), round)
  }

  const toRefute = []
  for (const e of scribe.entries) {
    if (e.disposition === 'skip_refuted' || e.disposition === 'dup_in_round') continue
    const f = majors[e.index]
    if (!f) {
      log(`${label}: 台帳記録係の index ${e.index} が不正 — 対応する指摘を特定できない`)
      continue
    }
    if (!e.id) log(`${label}: 台帳記録係が「${f.title}」の ID を返さなかった — 仮 ID で反証を続行（台帳の処置更新は不能）`)
    toRefute.push({ ...f, id: e.id || `C-?(${laneKey}:${e.index})`, rekindleOf: e.disposition === 'rekindle' ? e.matched : null })
  }
  if (toRefute.length === 0) return []
  return refuteAll(toRefute, round)
}

// 反証エージェントが無応答（skip / 終端エラー）の指摘は安全側で生存扱いにする —
// blocker/major が黙って消えるのが最悪の失敗モード
async function refuteAll(toRefute, round) {
  const verdicts = await parallel(toRefute.map(f => () =>
    agent(refutePrompt(f), { label: `反証:${f.id}`, phase: `Rd${round} 反証`, model: 'sonnet', schema: VERDICT_SCHEMA })
      .then(v => (v
        ? { ...f, refuted: v.refuted, basis: v.basis }
        : { ...f, refuted: false, basis: '反証エージェント無応答 — 安全側で生存扱い' }))))
  return verdicts.filter(Boolean)
}

async function runLane(laneKey, prompt, round, label) {
  const r = await agent(prompt, { label, phase: `Rd${round} レビュー`, model: 'sonnet', schema: FINDINGS_SCHEMA })
  if (!r) return []
  if (r.error) {
    log(`${label}: 実行失敗 — ${r.error}`)
    return []
  }
  return processFindings(laneKey, r.findings, round, label)
}

// ---- メインループ -------------------------------------------------------------

log(`入口検査: ゲート再実行（${GATES.length} 本）+ 台帳の現在ラウンド確認`)
const setup = await agent(setupPrompt, { label: '入口検査', phase: '入口検査', model: 'sonnet', schema: SETUP_SCHEMA })
if (!setup) throw new Error('入口検査エージェントが結果を返さなかった')
if (!setup.files_ok) {
  return { status: 'blocked', reason: `ファイル欠落: ${setup.missing || '不明'}`, ledger: LEDGER }
}
if (!setup.gates_green) {
  return { status: 'blocked', reason: '入口ゲートが赤 — dandori-impl の修正ループ（§2〜3 単発）へ差し戻し', detail: setup.gate_summary || '', ledger: LEDGER }
}

const startRound = (setup.max_c_round || 0) + 1
let round = startRound
let active = Object.keys(LANES)
// 台帳に C 行が存在するか — 収束判定（check-docs）を呼ぶべきかの判断材料。
// 再開セッション（過去ラウンドの C 行あり）でも判定を飛ばさないため setup から引き継ぐ
let cRowsExist = (setup.max_c_round || 0) > 0

while (true) {
  log(`ラウンド ${round} 開始: レーン = ${active.map(k => LANES[k].label).join(' / ')}`)

  // 機械検査先行 — ミューテーションテストはレーン起動前に実行する（SKILL.md の順序保証。
  // テスト忠実度レーンのプロンプトが「別途実行済み」を前提にするため、並行にしない）
  let mutationFindings = []
  if (MUTATION && round === startRound) {
    log('機械検査先行: ミューテーションテスト（diff スコープ限定）')
    const m = await agent(mutationPrompt, { label: 'ミューテーション', phase: `Rd${round} 機械検査`, model: 'sonnet', schema: FINDINGS_SCHEMA })
    if (!m) log('ミューテーションエージェント無応答 — スキップして続行')
    else if (m.error) log(`ミューテーション実行失敗 — ${m.error}（スキップして続行）`)
    else mutationFindings = m.findings
  }

  const thunks = active.map(key => () => runLane(key, LANES[key].prompt, round, `レーン:${LANES[key].label}`))
  if (mutationFindings.length > 0) {
    thunks.push(() => processFindings('mutation', mutationFindings, round, 'ミューテーション'))
  }

  // 各 thunk 内で レビュー→台帳→反証 が独立に流れる。barrier はラウンド末尾
  // （修正フェーズが全生存指摘を必要とする）にしかない
  const verdicts = (await parallel(thunks)).filter(Boolean).flat()
  if (verdicts.length > 0) cRowsExist = true

  if (verdicts.length > 0) {
    // 反証結果の記入は収束判定の生命線 — 未記入のまま進むと反証破棄済みの行が生存として
    // 数えられ、判定が汚染される（review 側の実戦観測と同型）。ACK を検査し、失敗は
    // 1 回だけ再試行、それでも書けなければ明示的に escalate する
    let ack = await serializedLedger(() =>
      agent(verdictScribePrompt(verdicts), { label: '台帳:反証結果', phase: `Rd${round} 台帳`, model: 'sonnet', effort: 'low', schema: ACK_SCHEMA }))
    if (!ack || !ack.done) {
      log('反証結果の台帳記入が未完了 — 1 回だけ再試行')
      ack = await serializedLedger(() =>
        agent(verdictScribePrompt(verdicts), { label: '台帳:反証結果(再試行)', phase: `Rd${round} 台帳`, model: 'sonnet', effort: 'low', schema: ACK_SCHEMA }))
    }
    if (!ack || !ack.done) {
      return {
        status: 'escalated',
        reason: `反証結果を台帳に記入できなかった（${(ack && ack.note) || '記録係無応答'}）— 処置列が空欄のまま閉じると判定が汚染される。台帳をメインで修復してから新規実行で再開すること`,
        minors, lastRound: round, ledger: LEDGER,
      }
    }
  }

  const survivors = verdicts.filter(v => !v.refuted)
  log(`ラウンド ${round}: blocker/major ${verdicts.length} 件 → 反証生存 ${survivors.length} 件（minor 累計 ${minors.length} 件）`)

  if (survivors.length === 0) {
    // 生存ゼロのラウンド = 収束。台帳に C 行があれば check-docs で機械確認する
    // （過去ラウンド由来の再燃・停滞・形式不備を見逃さないため、再開セッションでも呼ぶ）
    let judge = null
    if (cRowsExist) {
      if (verdicts.length === 0) {
        // このラウンドは行を追記していない（指摘ゼロ / 全て反証済みの再生産）— マーカーが
        // ないと check-docs は最後の行があるラウンドまでしか観測できず、過去の停滞パターン
        // から escalated を返し続ける。「指摘なし」マーカーで今ラウンドを可視化する
        await serializedLedger(() =>
          agent(zeroRoundPrompt(round), { label: '台帳:ラウンド記録', phase: `Rd${round} 台帳`, model: 'sonnet', effort: 'low', schema: ACK_SCHEMA }))
      }
      judge = await agent(judgePrompt, { label: '収束判定', phase: `Rd${round} 判定`, model: 'sonnet', effort: 'low', schema: JUDGE_SCHEMA })
    }
    // 完了条件は check-docs の exit 0（形式不備なし）まで含む — 未処置行や欠番を残して
    // passed を名乗らない
    const clean = !judge || (judge.verdict !== 'escalated' && judge.exit_code === 0)
    return {
      status: clean ? 'passed' : 'escalated',
      rounds: round - startRound + 1,
      lastRound: round,
      minors,
      judgeNotes: judge
        ? (verdicts.length === 0
          ? `最終ラウンドは指摘ゼロ（「指摘なし」マーカーを台帳に記録済み）: ${judge.notes || ''}`
          : judge.notes || '')
        : '台帳に C 行なし（指摘ゼロのまま収束）',
      ledger: LEDGER,
    }
  }

  const fix = await agent(fixPrompt(survivors), { label: '修正', phase: `Rd${round} 修正`, schema: FIX_SCHEMA })
  if (!fix) {
    return { status: 'gate_red', reason: '修正エージェントが結果を返さなかった', survivors, minors, lastRound: round, ledger: LEDGER }
  }
  if (fix.needs_adjudication && fix.needs_adjudication.length > 0) {
    return {
      status: 'needs_adjudication',
      items: fix.needs_adjudication,
      fixed: fix.fixed,
      minors,
      lastRound: round,
      ledger: LEDGER,
    }
  }
  if (!fix.gates_green) {
    return { status: 'gate_red', detail: fix.gate_output, fixed: fix.fixed, minors, lastRound: round, ledger: LEDGER }
  }
  // fix 報告の完全性クロスチェック — 報告から漏れた指摘は台帳の未処置行として
  // check-docs（L2）が検出するが、ここでも可視化しておく
  const handledIds = new Set([...(fix.fixed || []), ...(fix.needs_adjudication || [])].map(x => x.id))
  const unhandled = survivors.filter(s => !handledIds.has(s.id))
  if (unhandled.length > 0) {
    log(`修正エージェントの報告から漏れた指摘: ${unhandled.map(s => s.id).join(', ')} — 台帳の未処置行として収束判定が検出する`)
  }

  const judge = await agent(judgePrompt, { label: '収束判定', phase: `Rd${round} 判定`, model: 'sonnet', effort: 'low', schema: JUDGE_SCHEMA })
  if (judge && judge.verdict === 'escalated') {
    return { status: 'escalated', judgeNotes: judge.notes || '', minors, lastRound: round, rounds: round - startRound + 1, ledger: LEDGER }
  }

  if (round - startRound + 1 >= MAX_ROUNDS) {
    return { status: 'escalated', reason: `maxRounds（${MAX_ROUNDS}）到達 — バックストップ`, minors, lastRound: round, rounds: MAX_ROUNDS, ledger: LEDGER }
  }

  // 修正に関係するレーンだけ新しいエージェントで再レビュー（前ラウンドの記憶を持たせない）。
  // 生存ミュータント由来の修正はテスト追加なので、テスト忠実度レーンで再確認する
  const laneSet = new Set(survivors.map(s => (s.lane === 'mutation' ? 'fidelity' : s.lane)))
  active = Object.keys(LANES).filter(k => laneSet.has(k))
  round += 1
}
