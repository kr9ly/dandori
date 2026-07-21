// @ts-nocheck — Workflow スクリプトはトップレベル return を持つ実行フォーマットで、tsc の
// モジュール検査対象外（TS1108 で後続のフロー解析が壊れ、偽の未使用変数警告が出る）
// 再開は**新規実行**で行うこと — resumeFromRunId（キャッシュ再生）を使わない。
// このスクリプトのプロンプトは同一 args なら不変のため、resume では全 agent 呼び出しが
// キャッシュ再生され、ディスク（台帳 / state.yaml / 対象ドキュメント）を読み直さずに
// 停止時の結果をそのまま返す（2026-07-08 実測: 13ms・トークン 0 で旧結果が再返却）。
// 継続状態はディスクが保持し、入口確認エージェントが続き（次ラウンド / 残マイルストーン）を
// 導出する — 新規実行が正しい再開手段。
export const meta = {
  name: 'dandori-review',
  description: 'dandori review 工程の決定的ループ — recall 優先の独立レビュー（finder） → 台帳追記 → 指摘ごと反証（verifier） → 反映 → check-docs ledger 収束判定。レビューアには spec/design のパスだけを渡す',
  whenToUse: 'dandori-review スキル実行時、Workflow が使える環境で決定的な制御フローを機械駆動する。spec の意図に関わる裁定・minor 採否・escalated 後の裁定・state.yaml 更新はメインエージェントに返す。',
}

// ============================================================================
// dandori-review workflow
//
// SKILL.md のレビューループをスクリプトに固定する。狙いは情報隔離の構造的な強制 —
// 「レビューアには spec.md / design.md のパスだけを渡す（要約・言い換え・背景説明・
// 弁解を混ぜない）」「台帳をレビューアに渡さない」「各ラウンドは新しいレビューア
// （前ラウンドの記憶なし）」がプロンプトテンプレートで固定される。
//
// finder/verifier 分離（2026-07-09 導入 — codereview の実測を review に移植）:
// レビューアは recall 優先の発見係で、精度の担保は指摘ごとの独立反証（verifier）に
// 全委譲する。精度をレビューアに求めると自己検閲が起き「毎ラウンド 1 件」のプラトーに
// なる（codereview 2026-07-08 実測）。review の指摘も大半は file:line 付きの事実主張で
// 反証可能 — 「review に反証フェーズは成立しない」という旧裁定は指摘の実態に合わず撤回。
//
// args:
//   specDir     (必須) .dandori/specs/<feature> — spec.md / design.md /
//               review-ledger.md をこの直下に置く規約
//   checkDocs   (必須) check-docs.ts の実行プレフィックス
//               （例: "node <dandori-repo>/skills/dandori/scripts/check-docs.ts"）
//   reviewDocs  (任意) レビュー観点に加える参照ドキュメントのパス配列
//               （resources.md 記載の規約・設計ドキュメント・バグパターン集。パスのみ）
//   checkStateModel (任意) check-state-model.ts の実行プレフィックス
//               （例: "node <dandori-repo>/skills/dandori-spec/scripts/check-state-model.ts"）。
//               spec に dandori-state-model ブロックがある場合、反映エージェントに
//               「反映後にチェッカーを exit 0 まで回す」を強制する — 反映が軸値未定義・
//               Covers 未知値・単軸 dependent 等の形式エラーを持ち込むのを工程内で検出する
//   maxRounds   (任意) ラウンド数の暴走バックストップ（既定 8 — 通常は再燃 / 停滞の
//               escalate が先に効く。件数による打ち切りはしない設計のため大きめ）
//   workRoot    (任意) コードの作業ルート（worktree 並列レーン等、コードがセッションの
//               作業ディレクトリと別の場所にあるとき指定）。レビューア・反証エージェントの
//               プロンプトに決定的に注入され、コードベースの参照先をこの中に固定する
//
// 戻り値 status:
//   passed             — 反証を生き残る blocker/major がゼロのラウンドが出た
//   escalated          — 再燃 / 停滞 / maxRounds 到達。ユーザー裁定へ
//   needs_adjudication — spec の意図（ゴール定義・スコープ）に関わる指摘。ユーザー裁定へ
//   blocked            — spec.md / design.md が見つからない
// ============================================================================

// Claude Code の Workflow ツールは環境によって args を JSON 文字列で渡す — オブジェクトに正規化する
const A = typeof args === 'string' ? JSON.parse(args) : args

if (!A || !A.specDir || !A.checkDocs) {
  throw new Error('args に specDir / checkDocs が必要。任意: reviewDocs（パス配列） / maxRounds / workRoot')
}

const SPEC_DIR = A.specDir.replace(/\/+$/, '')
const SPEC = `${SPEC_DIR}/spec.md`
const DESIGN = `${SPEC_DIR}/design.md`
const LEDGER = `${SPEC_DIR}/review-ledger.md`
const REVIEW_DOCS = Array.isArray(A.reviewDocs) ? A.reviewDocs : []
const CHECK = A.checkDocs
const SM_CHECK = A.checkStateModel || null
const MAX_ROUNDS = A.maxRounds || 8

// 作業ルート（任意）— サブエージェントはセッションの主作業ディレクトリで動くため、コードが
// 別の場所（レーン worktree 等）にあるときはプロンプト注入で参照先を固定する
const WORK_ROOT = A.workRoot ? A.workRoot.replace(/\/+$/, '') : null
const workRootNote = WORK_ROOT
  ? `

作業ルート: ${WORK_ROOT}
- 検証対象のコードベースはこのディレクトリ。コードの読み取り・コマンド実行はこの中で行うこと
- 指摘・反証の根拠（ファイル:行）の相対パス（src/ 等）はこのルート基準
- 他の worktree・リポジトリのコードを検証対象と取り違えないこと`
  : ''

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
          disposition: { type: 'string', enum: ['new', 'rekindle', 'skip_refuted', 'dup_minor'] },
          id: { type: ['string', 'null'], description: '追記した行の R-n ID（行を追加しなかった skip_refuted / dup_minor のみ null）' },
          matched: { type: ['string', 'null'], description: '同一論点と照合した既存行の ID（new は null）' },
        },
      },
    },
  },
}

const REFLECT_SCHEMA = {
  type: 'object',
  required: ['reflected', 'needs_adjudication'],
  properties: {
    reflected: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'note'],
        properties: { id: { type: 'string' }, note: { type: 'string', description: 'どのドキュメントをどう直したか一行' } },
      },
    },
    needs_adjudication: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'reason'],
        properties: { id: { type: 'string' }, reason: { type: 'string', description: 'なぜユーザー裁定が必要か — spec の意図（ゴール定義・スコープ）の何に触れるか、または指摘が誤りと考える根拠（却下相当の場合）' } },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'basis'],
  properties: {
    refuted: { type: 'boolean', description: 'true = 指摘は誤り（反証成立）' },
    basis: { type: 'string', description: '反証の成否の根拠（ファイル:行 / spec・design の該当節）を一行で' },
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
    note: { type: 'string', description: '追記できなかった場合はその内容' },
  },
}

const SETUP_SCHEMA = {
  type: 'object',
  required: ['files_ok', 'max_r_round', 'has_state_model'],
  properties: {
    files_ok: { type: 'boolean' },
    missing: { type: 'string', description: '欠けているファイル' },
    max_r_round: { type: 'integer', description: '台帳の R-n 行の Rd 列の最大値（台帳や R 行がなければ 0）' },
    has_state_model: { type: 'boolean', description: 'spec.md に dandori-state-model ブロックがあるか' },
  },
}

// ---- プロンプトテンプレート（情報隔離はここで固定される）---------------------
// レビューアに渡すのはパスと観点だけ。内容の要約・言い換え・背景説明・仮説・弁解は
// テンプレートに存在しない = 混入できない。台帳のパスも渡さない。

const reviewerPrompt = (hasStateModel) => `あなたは実装ドキュメントの独立レビューアです。以下の2ファイルを読み、批評してください。
- ${SPEC}
- ${DESIGN}

観点:
1. 要件不達 — この設計を実装しても spec のゴールを満たさない箇所はないか
2. エラーパス欠落 — 状態変数の洗い出しに漏れはないか。spec の異常系 B 行で
   カバーされないエラーパスを、実際のコードから逆算して探せ
3. 前提の誤り — design.md の「土台」「不変条件」の主張を鵜呑みにせず、
   コードベースを自分で読んで検証せよ。特に [読解のみ] マークの前提を重点的に疑え。
   [実行検証済] も証拠形式を監査せよ: 実行コマンドと観測結果の併記がないもの、
   コマンドを再実行して主張どおりにならないものは、マークの降格を指摘せよ
4. 整合性 — spec と design の間の矛盾、design が触ると言っていない箇所への隠れた影響
${REVIEW_DOCS.length > 0 ? `5. 規約・既知パターンとの照合 — 以下のドキュメントを読み、違反・既知の失敗パターンへの該当を探せ:
${REVIEW_DOCS.map(p => `   - ${p}`).join('\n')}
` : ''}${hasStateModel ? `
spec.md には状態モデル（dandori-state-model ブロック）がある。組み合わせ網羅・交点カバーは
チェッカーが機械的に担保しているため、モデルが原理的に検出できない型に集中すること:
軸内の逐次連鎖の発見 / 分類述語の値域の穴 / 未発見の状態変数 /
値内部のセマンティクス（照合条件の非対称等）/ エラー優先順位の導出。

各軸の値域を同値分割として監査すること:
- クラス漏れ: どのクラスにも属さない入力値（「その他」に落ちる値）の挙動が宣言されているか
- クラス内非一様性: クラス内の具体値で Then が変わる反例を探せ。特に多重度の罠 —
  「該当データが複数あるとき」に複数候補から 1 件を選ぶ処理（.first()、タイブレーク）は
  選択順序が観測可能な仕様であり、単数クラスと同値ではない

さらに直交宣言の監査を行うこと。状態モデルの orthogonal / orthogonal_groups の各宣言について:
- reason が spec 本文から実際に導けるか検証せよ。本文に根拠のない reason は
  それ自体を指摘せよ（major — 裁定のふりの疑い。ground 送りへの差し戻しを提案）
- 反例となる交点を探せ: その 2 軸の値の組み合わせで挙動が変わるケースを、
  spec の Then の散文（「〜の場合のみ」「〜は除外」）とコードの両方から探すこと。
  見つかれば依存宣言への昇格 + 交点 B 行の追加を指摘せよ（blocker）
` : ''}
各指摘に深刻度を付けること:
- blocker: 要件を満たさない実装になる / 前提が事実と異なる
- major: エラーパス・状態変数の欠落、不変条件の見落とし
- minor: 改善提案・表現の曖昧さ

ルール（あなたは発見係 — 指摘の白黒は後段の独立反証フェーズが付ける）:
- 見落としは反証フェーズでは回復できないが、偽陽性は反証フェーズが破棄できる。
  疑いは自己検閲せず列挙すること。「確信が持てないから黙る」は禁止
- 照合対象をまず全数列挙し、1 件ずつ疑いを探すこと（design の土台・不変条件は全エントリ、
  spec の B 行は全行）。目についた 1 件で走査を止めない
- 各指摘に疑いの根拠（ファイル:行）と、可能なら「何を確認すれば白黒つくか」（check）を付けること
- 深刻度は「指摘が真だった場合」の深刻度で付ける。確信度で下げない
- minor だけは反証フェーズを通らずユーザーに直接届くため、確信のあるもののみ報告すること

コードベースへの読み取りアクセスがあります。修正は行わず、指摘の列挙だけを返すこと。${workRootNote}`

const scribePrompt = (findings, round) => `あなたは指摘台帳の記録係です。台帳: ${LEDGER}（存在しなければヘッダ行から新規作成する）。
正準形式: | ID | Rd | 深刻度 | 論点（一行） | 処置 | 根拠・理由 |

以下の指摘を**全件**台帳に追記してください。今ラウンドは Rd=${round}、ID は R-n 系列の連番
（既存の最大 R 番号の続き。C-n 系列とは独立）。

指摘（JSON）:
${JSON.stringify(findings.map((f, index) => ({ index, severity: f.severity, title: f.title, detail: f.detail, evidence: f.evidence })), null, 2)}

手順（各指摘ごと）:
1. 既存行と同一論点かを照合する
   - 同一論点の既存行の処置が「反証破棄」→ 行を追加しない（反証済みの再生産）。
     disposition=skip_refuted、matched にその ID、id は null
   - **minor の指摘**で同一論点の既存行がある（処置を問わず）→ 行を追加しない
     （minor は反証を通らないため、重複行はそのままユーザーへの重複提示になる）。
     disposition=dup_minor、matched にその ID、id は null
   - 同一論点の既存行の処置がそれ以外 → 新規行を追記するが、処置セルは**空のまま**にする。
     disposition=rekindle、matched に既存 ID（再燃の確定は反証フェーズ後 — 反証で破棄されれば
     再燃ではなく偽陽性の再生産だったことになる）
   - 一致なし → 新規行を追記。disposition=new。処置セルは minor なら「保留」、
     blocker / major なら空のまま（反証・反映フェーズで記録される）
2. 論点セルは title を一行で、根拠・理由セルは（上記以外は）evidence を書く

台帳は追記のみ。既存行の書き換え・削除は禁止。`

const refutePrompt = (f) => `以下の仕様・設計ドキュメントレビューの指摘を反証してください。指摘は recall 優先の
発見係によるもので、偽陽性を多く含む前提です — この反証が唯一の精度ゲートです。
指摘が誤りである可能性 — 事実誤認（ファイル:行の主張が原典と食い違う）、spec / design が
実際には既にカバーしている、既存の確定裁定（precedents）で決着済み、到達不能な条件 — を
対象ドキュメントとコードベースを自分で読んで確認すること。
「到達不能」を反証根拠にする場合は、コード経路だけでなく**データ由来の到達可能性**
（nullable なカラム・スキーマ変更前から残る古いレコード・部分書き込み・外部からの入力値）を
確認してからにすること — 型注釈や現行コードパスのみを根拠に到達不能と断定しない。
真とも偽とも確定できない場合は refuted=false（生存 — 安全側）とする。
反証の成否と根拠（ファイル:行 / ドキュメントの該当節）を報告すること。

対象ドキュメント: spec = ${SPEC} / design = ${DESIGN}

指摘 [${f.severity}]: ${f.title}
詳細: ${f.detail}
根拠: ${f.evidence}${f.check ? `\n白黒を付ける確認手段（発見係の提案）: ${f.check}` : ''}${workRootNote}`

const verdictScribePrompt = (verdicts) => `指摘台帳 ${LEDGER} の処置列を反証結果で更新してください。対象行のみ編集し、他の行は触らないこと。

反証結果(JSON):
${JSON.stringify(verdicts.map(v => ({ id: v.id, refuted: v.refuted, basis: v.basis, rekindleOf: v.rekindleOf })), null, 2)}

- refuted=true → 処置を「反証破棄」にし、根拠・理由セルを反証根拠（basis）で置き換える
- refuted=false かつ rekindleOf あり → 処置を「再燃→<rekindleOf>」、根拠・理由セルを
  「escalate 判定の材料」にする
- refuted=false かつ rekindleOf なし → 何もしない（処置は反映フェーズで記録される）`

const reflectPrompt = (items, smCheck) => `あなたは dandori-review の反映エージェントです。独立レビューの反証フェーズを生き残った
以下の指摘（blocker / major）を spec.md / design.md に反映してください。

指摘（JSON）:
${JSON.stringify(items.map(f => ({ id: f.id, severity: f.severity, title: f.title, detail: f.detail, evidence: f.evidence })), null, 2)}

対象: spec = ${SPEC} / design = ${DESIGN}
指摘台帳: ${LEDGER}

ルール:
- 反映はすべてドキュメントに書き込むこと — 報告にだけ存在する修正はゼロにする
- **spec の意図に関わるもの（ゴール定義・スコープの変更を伴うもの）は反映せず**、
  needs_adjudication に理由つきで返すこと（ユーザー裁定が必要）。
  事実誤認の訂正・記述の精密化・エラーパスの追記は自律で反映してよい
- 指摘が誤りだと確信できる場合も自分で却下しない — needs_adjudication に回すこと
  （却下はユーザー裁定を要する処置）
- 反映した指摘は台帳の該当行（ID で特定）の処置セルを「反映済」にし、
  根拠・理由セルにどのドキュメントをどう直したか一行で記録すること
- needs_adjudication に回した指摘の台帳行は触らない（処置はユーザー裁定後に記録される）${smCheck ? `
- spec.md への反映後、次のコマンドを実行し **exit 0 になるまで形式を修正すること**:
  \`${smCheck} ${SPEC}\`
  直してよいのは自分の反映が持ち込んだ形式エラーのみ（軸に値を追加し忘れた Covers の未知値、
  2 軸未満の dependent エントリ、only で表現すべき単軸制約など）。チェッカーを黙らせるために
  反映内容のセマンティクスを削る・弱めることはしないこと。exit 0 にできない場合はその旨を
  notes に書いて返すこと` : ''}`

// markZeroRound: 「指摘なし」ラウンドの番号。マーカー追記は check-docs の
// --mark-zero-round（決定的・冪等）が行う — エージェントに台帳の自由編集をさせない
// （マーカー追記の Edit が監査改竄と誤検知されエージェントがブロックされた実戦観測への対策）
const judgePrompt = (markZeroRound) => `次のコマンドを実行し、出力とコマンドの exit code を報告してください:
${CHECK} ledger ${LEDGER}${markZeroRound ? ` --mark-zero-round R ${markZeroRound}` : ''}

出力の「R（dandori-review）」節の判定を verdict に対応づける:
「passed」→ passed、「escalated」→ escalated、「継続」→ continue。
R 系列の節が出力にない場合は continue。
再燃・停滞の行や台帳の形式指摘（exit 1 の指摘一覧）があれば notes に要約すること。
（保留の minor 行は採否待ちの正常状態であり形式指摘ではない）`

const setupPrompt = `dandori-review の入口確認を行ってください。コードやドキュメントの修正はしないこと。

1. ${SPEC} と ${DESIGN} が存在するか確認する
2. ${SPEC} に dandori-state-model ブロック（\`\`\`dandori-state-model フェンス）があるか確認する
3. ${LEDGER} が存在すれば読み、R-n 行の Rd 列の最大値を max_r_round として報告する
   （台帳がない・R 行がない場合は 0）`

// ---- メインループ -------------------------------------------------------------

const setup = await agent(setupPrompt, { label: '入口確認', phase: '入口確認', model: 'sonnet', effort: 'low', schema: SETUP_SCHEMA })
if (!setup) throw new Error('入口確認エージェントが結果を返さなかった')
if (!setup.files_ok) {
  return { status: 'blocked', reason: `ファイル欠落: ${setup.missing || '不明'}`, ledger: LEDGER }
}

const startRound = (setup.max_r_round || 0) + 1
let round = startRound
let rRowsExist = (setup.max_r_round || 0) > 0
const minors = []

// minor は反証を通らずユーザーに直接届く — 台帳照合（scribe の dup_minor 処分）で
// 既存論点の再報告を落としてから蓄積する（同一論点が別ラウンドで重複提示される実測への対処）
const addMinors = (findings, scribe) => {
  const byIndex = new Map(scribe.entries.map(e => [e.index, e]))
  findings.forEach((f, i) => {
    if (f.severity !== 'minor') return
    const e = byIndex.get(i)
    if (e && e.disposition === 'dup_minor') return
    minors.push(f)
  })
}

while (true) {
  log(`ラウンド ${round}: 独立レビューア起動（前ラウンドの記憶なし・台帳は渡さない）`)

  // 1. 独立レビュー — レビューアのモデルはセッション継承（この工程の品質の源泉のため
  //    Sonnet に固定しない。codereview のレーンとは違い SKILL に「Sonnet で足りる」の宣言がない）
  const review = await agent(reviewerPrompt(setup.has_state_model), {
    label: `レビューア Rd${round}`, phase: `Rd${round} レビュー`, schema: FINDINGS_SCHEMA,
  })
  if (!review) {
    return { status: 'escalated', reason: 'レビューアが結果を返さなかった — メインで再起動を判断', minors, lastRound: round, ledger: LEDGER }
  }
  const findings = review.findings
  const majors = findings.filter(f => f.severity !== 'minor')
  log(`ラウンド ${round}: 指摘 ${findings.length} 件（blocker/major ${majors.length} / minor ${findings.length - majors.length}）`)

  // 収束: blocker と major が両方ゼロのラウンド
  if (majors.length === 0) {
    if (findings.length > 0) {
      // minor だけでも台帳には全件記録する（記録失敗を握り潰すと指摘が消えたまま
      // passed になる — 台帳の完全性は完了条件なので escalate に倒す）
      const minorScribe = await agent(scribePrompt(findings, round), { label: '台帳追記', phase: `Rd${round} 台帳`, model: 'sonnet', effort: 'low', schema: SCRIBE_SCHEMA })
      if (!minorScribe) {
        return { status: 'escalated', reason: '台帳記録係が結果を返さなかった（minor 記録） — 台帳の状態をメインで確認すること', minors, lastRound: round, ledger: LEDGER }
      }
      addMinors(findings, minorScribe)
      rRowsExist = true
    }
    let judge = null
    if (rRowsExist) {
      // このラウンドが行を追記していない場合、マーカーがないと check-docs は最後の行がある
      // ラウンドまでしか観測できず、過去の停滞パターンから escalated を返し続ける。
      // 「指摘なし」マーカーの追記は check-docs の --mark-zero-round に委ねる
      // （決定的・冪等 — 収束判定と同一コマンドで済む）
      judge = await agent(judgePrompt(findings.length === 0 ? round : null), { label: '収束判定', phase: `Rd${round} 判定`, model: 'sonnet', effort: 'low', schema: JUDGE_SCHEMA })
    }
    // 完了条件は check-docs の exit 0（形式不備なし）まで含む — 未処置行や欠番を残して
    // passed を名乗らない
    const clean = !judge || (judge.verdict !== 'escalated' && judge.exit_code === 0)
    return {
      status: clean ? 'passed' : 'escalated',
      rounds: round - startRound + 1,
      lastRound: round,
      minors,
      judgeNotes: judge ? `${judge.notes || ''}${judge.exit_code !== 0 ? `（check-docs exit ${judge.exit_code} — 台帳の形式不備を解消すること）` : ''}` : '台帳に R 行なし（指摘ゼロのまま収束）',
      ledger: LEDGER,
    }
  }

  // 2. 全指摘を台帳に追記（minor 含む — review は台帳に全件記録する工程）
  const scribe = await agent(scribePrompt(findings, round), { label: '台帳追記', phase: `Rd${round} 台帳`, model: 'sonnet', effort: 'low', schema: SCRIBE_SCHEMA })
  if (!scribe) {
    return { status: 'escalated', reason: '台帳記録係が結果を返さなかった — 台帳の状態をメインで確認すること', findings, minors, lastRound: round, ledger: LEDGER }
  }
  rRowsExist = true
  addMinors(findings, scribe)
  const idByIndex = new Map(scribe.entries.map(e => [e.index, e]))

  // 3. 指摘ごと独立反証（verifier）— blocker / major のみ。minor は反証を通らず
  //    ユーザーに直接届く（finder ルールで「確信のあるもののみ」を要求済み）。
  //    skip_refuted（反証済みの再生産）は台帳行なし・反証にも回さない
  const toRefute = []
  findings.forEach((f, i) => {
    if (f.severity === 'minor') return
    const e = idByIndex.get(i)
    if (!e) {
      log(`台帳記録係の報告に index ${i} がない — 仮 ID で反証を続行（台帳の処置更新は不能）`)
      toRefute.push({ ...f, id: `R-?(${i})`, rekindleOf: null })
      return
    }
    if (e.disposition === 'skip_refuted') return
    if (!e.id) log(`台帳記録係が「${f.title}」の ID を返さなかった — 仮 ID で反証を続行（台帳の処置更新は不能）`)
    toRefute.push({ ...f, id: e.id || `R-?(${i})`, rekindleOf: e.disposition === 'rekindle' ? e.matched : null })
  })

  // 反証エージェントが無応答（skip / 終端エラー）の指摘は安全側で生存扱いにする —
  // blocker/major が黙って消えるのが最悪の失敗モード
  const verdicts = (await parallel(toRefute.map(f => () =>
    agent(refutePrompt(f), { label: `反証:${f.id}`, phase: `Rd${round} 反証`, model: 'sonnet', schema: VERDICT_SCHEMA })
      .then(v => (v
        ? { ...f, refuted: v.refuted, basis: v.basis }
        : { ...f, refuted: false, basis: '反証エージェント無応答 — 安全側で生存扱い' }))))).filter(Boolean)

  if (verdicts.length > 0) {
    // 反証結果の記入は収束判定の生命線 — 未記入のまま進むと反証破棄済みの行が生存として
    // 数えられ、judgeNotes と台帳の言い分が食い違ったまま判定が汚染される（実戦観測）。
    // ACK を検査し、失敗は 1 回だけ再試行、それでも書けなければ明示的に escalate する
    let ack = await agent(verdictScribePrompt(verdicts), { label: '台帳:反証結果', phase: `Rd${round} 台帳`, model: 'sonnet', effort: 'low', schema: ACK_SCHEMA })
    if (!ack || !ack.done) {
      log('反証結果の台帳記入が未完了 — 1 回だけ再試行')
      ack = await agent(verdictScribePrompt(verdicts), { label: '台帳:反証結果(再試行)', phase: `Rd${round} 台帳`, model: 'sonnet', effort: 'low', schema: ACK_SCHEMA })
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
  log(`ラウンド ${round}: blocker/major ${toRefute.length} 件 → 反証生存 ${survivors.length} 件（minor 累計 ${minors.length} 件）`)

  // 4. 反証を生き残った再燃 = escalate 確定（偽陽性の再生産ではなく、反映済み論点への
  //    正当な再指摘 — レビューアと処置の間で解釈が振動している）。反映せずユーザー裁定へ
  const rekindledSurvivors = survivors.filter(v => v.rekindleOf)
  if (rekindledSurvivors.length > 0) {
    log(`再燃生存: ${rekindledSurvivors.map(v => v.rekindleOf).join(', ')} — 反映をスキップして収束判定へ`)
    const judge = await agent(judgePrompt(null), { label: '収束判定', phase: `Rd${round} 判定`, model: 'sonnet', effort: 'low', schema: JUDGE_SCHEMA })
    return {
      status: 'escalated',
      reason: '既存論点が再指摘され反証も生き残った（再燃）— レビューアと処置の間で解釈が振動している',
      rekindled: rekindledSurvivors.map(v => v.rekindleOf),
      judgeNotes: judge ? judge.notes || '' : '',
      minors,
      lastRound: round,
      rounds: round - startRound + 1,
      ledger: LEDGER,
    }
  }

  // 5. 生存ゼロ（全指摘が反証破棄）= 収束ラウンド — check-docs は反証破棄を生存数から
  //    除外するため、このラウンドの生存数は 0 として観測される
  if (survivors.length === 0) {
    const judge = await agent(judgePrompt(null), { label: '収束判定', phase: `Rd${round} 判定`, model: 'sonnet', effort: 'low', schema: JUDGE_SCHEMA })
    const clean = !judge || (judge.verdict !== 'escalated' && judge.exit_code === 0)
    return {
      status: clean ? 'passed' : 'escalated',
      rounds: round - startRound + 1,
      lastRound: round,
      minors,
      judgeNotes: `最終ラウンドの blocker/major は全件反証破棄（発見 ${toRefute.length} 件 → 生存 0）${judge ? `: ${judge.notes || ''}` : ''}`,
      ledger: LEDGER,
    }
  }

  // 6. 反証を生き残った blocker / major を反映（狭ブリーフのエージェント1枚 —
  //    会話にだけ存在する修正を作らない）
  const reflect = await agent(reflectPrompt(survivors, setup.has_state_model ? SM_CHECK : null), { label: `反映 Rd${round}`, phase: `Rd${round} 反映`, schema: REFLECT_SCHEMA })
  if (!reflect) {
    return { status: 'escalated', reason: '反映エージェントが結果を返さなかった — ドキュメントの状態をメインで確認すること', minors, lastRound: round, ledger: LEDGER }
  }
  if (reflect.needs_adjudication.length > 0) {
    return {
      status: 'needs_adjudication',
      items: reflect.needs_adjudication,
      reflected: reflect.reflected,
      minors,
      lastRound: round,
      ledger: LEDGER,
    }
  }
  // 反映の報告から漏れた指摘の可視化（台帳の未処置行として check-docs も検出する）
  const handled = new Set(reflect.reflected.map(x => x.id))
  const unhandled = survivors.filter(f => !handled.has(f.id))
  if (unhandled.length > 0) {
    log(`反映エージェントの報告から漏れた指摘: ${unhandled.map(f => f.id).join(', ')} — 台帳の未処置行として収束判定が検出する`)
  }

  // 4. 収束判定（形式検査込み）
  const judge = await agent(judgePrompt(null), { label: '収束判定', phase: `Rd${round} 判定`, model: 'sonnet', effort: 'low', schema: JUDGE_SCHEMA })
  if (judge && judge.verdict === 'escalated') {
    return { status: 'escalated', judgeNotes: judge.notes || '', minors, lastRound: round, rounds: round - startRound + 1, ledger: LEDGER }
  }

  if (round - startRound + 1 >= MAX_ROUNDS) {
    return { status: 'escalated', reason: `maxRounds（${MAX_ROUNDS}）到達 — バックストップ`, minors, lastRound: round, rounds: MAX_ROUNDS, ledger: LEDGER }
  }

  // 7. 次ラウンド — 新しいレビューアで再レビュー
  round += 1
}
