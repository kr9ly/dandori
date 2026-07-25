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
//   escalated          — 再燃 / 停滞（収束判定が escalated）。ユーザー裁定へ
//   max_rounds         — maxRounds 到達での打ち切り（収束の失敗ではない — 生存指摘は反映済み・
//                        次ラウンドのレビュー前。続行 or 収束確認の裁定へ）
//   needs_adjudication — spec の意図（ゴール定義・スコープ）に関わる指摘。ユーザー裁定へ
//   blocked            — spec.md / design.md が見つからない
// ============================================================================

// Claude Code の Workflow ツールは環境によって args を JSON 文字列で渡す — オブジェクトに正規化する
const A = typeof args === 'string' ? JSON.parse(args) : args

if (!A || !A.specDir || !A.checkDocs) {
  throw new Error('args に specDir / checkDocs が必要。任意: reviewDocs（パス配列） / maxRounds / workRoot')
}

// 型の明示検査 — 単一パス想定の args に配列を渡すと、後段のパス操作（startsWith 等）が
// 「.startsWith is not a function」で即死し、期待形が読み取れないまま workflow が落ちる
// （2026-07-25 実戦観測: codereview の resources に配列を渡して絶対パスガードがクラッシュ）
const requireStr = (name, v) => {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`args.${name} は空でない文字列で渡すこと（現在: ${JSON.stringify(v)}）`)
  }
  return v
}
for (const name of ['specDir', 'checkDocs']) requireStr(name, A[name])
for (const name of ['checkStateModel', 'workRoot']) {
  if (A[name] !== undefined && A[name] !== null) requireStr(name, A[name])
}
if (A.reviewDocs !== undefined && A.reviewDocs !== null) {
  if (!Array.isArray(A.reviewDocs)) {
    throw new Error(`args.reviewDocs はパスの配列で渡すこと（現在: ${JSON.stringify(A.reviewDocs)}）`)
  }
  A.reviewDocs.forEach((p, i) => requireStr(`reviewDocs[${i}]`, p))
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
// 別の場所（レーン worktree 等）にあるときはプロンプト注入で参照先を固定する。
// 台帳・spec ドキュメントは閉じ込めの適用除外 — 除外を明示しないと worktree 内に台帳の
// 複製が作られ書き先が分裂する（codereview 側の 2026-07-22 実戦観測・台帳二重化と同型）。
// workRoot 併用時は specDir に絶対パスを要求する
const WORK_ROOT = A.workRoot ? A.workRoot.replace(/\/+$/, '') : null
if (WORK_ROOT && !SPEC_DIR.startsWith('/')) {
  throw new Error(`workRoot 指定時は specDir を絶対パスで渡すこと（現在: ${SPEC_DIR}）— 台帳・spec の書き先が worktree 内に複製されるのを防ぐため`)
}
// reviewDocs も同型 — 相対パスは「cd workRoot して作業する」エージェントから解決できず、
// 規約・バグパターン照合の観点が黙って欠落する（workRoot 注入不足の同型・2026-07-23 実戦観測）
if (WORK_ROOT) {
  const rel = REVIEW_DOCS.filter(p => !String(p).startsWith('/'))
  if (rel.length > 0) {
    throw new Error(`workRoot 指定時は reviewDocs も絶対パスで渡すこと（相対: ${rel.join(', ')}）`)
  }
}
const workRootNote = WORK_ROOT
  ? `

作業ルート: ${WORK_ROOT}
- 検証対象のコードベースはこのディレクトリ。コードの読み取り・コマンド実行はこの中で行うこと
- 指摘・反証の根拠（ファイル:行）の相対パス（src/ 等）はこのルート基準
- 他の worktree・リポジトリのコードを検証対象と取り違えないこと
- **例外（dandori ドキュメント）**: 台帳・spec・design 等の .dandori 配下ドキュメントは
  ${SPEC_DIR} （絶対パス）だけが正。読み書きは必ずこのパスで行い、${WORK_ROOT} 内に
  .dandori や台帳の複製を作らないこと`
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

// 記録係は「照合係」に縮退している — 台帳への行の書き込みと ID 発番は
// check-docs ledger-append（決定的・冪等）が行い、エージェントは既存行との同一論点照合だけを返す。
// エージェントに追記させる設計では、発番済み ID の行が台帳に書かれない書き落ち・worktree 内
// 複製への二重書き込み・ID 再採番衝突が、プロンプト強化を重ねても再発した（codereview 側と同型・
// 2026-07-25 恒久対策）
const MATCH_SCHEMA = {
  type: 'object',
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'disposition', 'matched'],
        properties: {
          index: { type: 'integer', description: '渡した指摘 JSON の index' },
          disposition: { type: 'string', enum: ['new', 'rekindle', 'skip_refuted', 'dup_minor'] },
          matched: { type: ['string', 'null'], description: '同一論点と照合した既存行の ID（new は null）' },
        },
      },
    },
  },
}

// 追記コマンドの出力転記のみ — エージェントに解釈させない（judge と同じ縮退）
const APPEND_SCHEMA = {
  type: 'object',
  required: ['appended_lines', 'exit_code'],
  properties: {
    appended_lines: {
      type: 'array',
      items: { type: 'string' },
      description: '出力中の「[appended] 」で始まる行の逐語転記（1 行 1 要素）',
    },
    exit_code: { type: 'integer', description: 'コマンドの exit code（0 = 追記成功）' },
    output: { type: 'string', description: 'exit code が 0 でない場合のみ: 生の出力の要点' },
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

// verdict はエージェントに意味づけさせない — checker 出力の [verdict] 行の逐語転記だけを
// 求め、マッピングは judgeVerdict()（スクリプト側・決定的）が行う。エージェントの意味的
// マッピングは「継続」を escalated に誤対応づける事故を起こした（codereview 側の
// 2026-07-22 実戦観測 — --mark-zero-round と同じ「エージェント自由裁量の排除」方針）
const JUDGE_SCHEMA = {
  type: 'object',
  required: ['verdict_line', 'exit_code'],
  properties: {
    verdict_line: { type: ['string', 'null'], description: '出力中の「[verdict] R=...」行の逐語転記（出力にその行がなければ null）' },
    exit_code: { type: 'integer', description: 'コマンドの exit code（0 = 形式指摘なし）' },
    notes: { type: 'string', description: '再燃・停滞・形式指摘があればその内容' },
  },
}

// [verdict] R=<token> をスクリプト側で決定的にマッピングする。行がない・転記が崩れている
// 場合は continue（従来の「R 系列の節が出力にない場合は continue」と同じ安全側 —
// ループは maxRounds がバックストップする）
const judgeVerdict = (judge) => {
  if (!judge || !judge.verdict_line) return 'continue'
  const m = String(judge.verdict_line).match(/\[verdict\]\s*R=(passed|escalated|continue)/)
  if (!m) {
    log(`収束判定の verdict 行が解釈不能（"${judge.verdict_line}"）— continue として続行`)
    return 'continue'
  }
  return m[1]
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

// 台帳の処置セルは checker（check-docs ledger の L1）が語彙検査する — 語彙外の言い換えや
// 処置セルへの注記併記は escalated を誘発する（2026-07-23 実戦観測）。台帳を書く全プロンプトに注入する
const LEDGER_VOCAB = `台帳の処置セルに書いてよいのは「反映済 / 却下 / 保留 / 反証破棄 / 再燃→<ID>」（または空 = 未処置）のみ。
「対応済」「修正済」等の言い換えや、処置セルへの注記・裁定文の併記は語彙エラーになる —
裁定・補足の文章は根拠・理由セルに書くこと。`

const matchPrompt = (findings, round) => `あなたは指摘台帳の照合係です。台帳: ${LEDGER}（存在しなければ既存行ゼロとして扱う）。
正準形式: | ID | Rd | 深刻度 | 論点（一行） | 処置 | 根拠・理由 |

以下の指摘それぞれについて、台帳の既存行と**同一論点かどうかだけ**を判定してください
（今ラウンドは Rd=${round}）。

指摘（JSON）:
${JSON.stringify(findings.map((f, index) => ({ index, severity: f.severity, title: f.title, detail: f.detail, evidence: f.evidence })), null, 2)}

判定（各指摘ごと）:
- 同一論点の既存行の処置が「反証破棄」→ disposition=skip_refuted、matched にその ID（反証済みの再生産）
- **minor の指摘**で同一論点の既存行がある（処置を問わず）→ disposition=dup_minor、matched にその ID
  （minor は反証を通らないため、重複行はそのままユーザーへの重複提示になる）
- 同一論点の既存行の処置がそれ以外 → disposition=rekindle、matched に既存 ID
  （再燃の確定は反証フェーズ後 — 反証で破棄されれば再燃ではなく偽陽性の再生産だったことになる）
- 一致なし → disposition=new、matched は null

**台帳ファイルは編集しないこと**（読み取りのみ）— 行の追記・ID 発番は後段の決定的コマンドが行う。
${LEDGER_VOCAB}`

// 追記は check-docs ledger-append に委ねる（決定的・冪等）— 行の書式・ID 発番・書き先パスが
// スクリプト側で固定され、エージェントの Edit を経由しない。rows JSON はスクリプトが構築する
const appendPrompt = (rows, round) => `次のコマンドを**一字一句そのまま**実行し、出力の「[appended] 」で始まる行を
すべて逐語転記（appended_lines）し、exit code を報告してください。

コマンドの編集（パス・オプション・JSON の書き換え）と、台帳ファイルの手編集はしないこと —
行の書式と ID 発番はこのコマンドが決定的に行います。

${CHECK} ledger-append ${LEDGER} --prefix R --rd ${round} --rows-stdin <<'ROWS_JSON_EOF'
${JSON.stringify(rows, null, 2)}
ROWS_JSON_EOF`

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
- refuted=false かつ rekindleOf なし → 何もしない（処置は反映フェーズで記録される）
${LEDGER_VOCAB}`

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
  根拠・理由セルにどのドキュメントをどう直したか一行で記録すること。
  ${LEDGER_VOCAB}
- needs_adjudication に回した指摘の台帳行は触らない（処置はユーザー裁定後に記録される）${smCheck ? `
- spec.md への反映後、次のコマンドを実行し **exit 0 になるまで形式を修正すること**:
  \`${smCheck} ${SPEC}\`
  直してよいのは自分の反映が持ち込んだ形式エラーのみ（軸に値を追加し忘れた Covers の未知値、
  2 軸未満の dependent エントリ、only で表現すべき単軸制約など）。チェッカーを黙らせるために
  反映内容のセマンティクスを削る・弱めることはしないこと。exit 0 にできない場合はその旨を
  notes に書いて返すこと` : ''}`

// markZero: このラウンドが台帳に行を追記しなかった（= 指摘なし）か。マーカー追記は
// check-docs の --mark-zero-round（決定的・冪等）が行う — エージェントに台帳の自由編集を
// させない（マーカー追記の Edit が監査改竄と誤検知されブロックされた実戦観測への対策）。
// ラウンド番号は `auto`（台帳の実ラウンド番号から導出）で渡す — workflow ローカルの
// 数え上げを渡すと台帳の Rd 系列と食い違うマーカーが打たれ、収束済みなのに escalated に
// なる（codereview 側の 2026-07-25 実戦観測と同型）
const judgePrompt = (markZero) => `次のコマンドを実行し、出力とコマンドの exit code を報告してください:
${CHECK} ledger ${LEDGER}${markZero ? ' --mark-zero-round R auto' : ''}

出力中の「[verdict] R=...」で始まる行を**一字一句そのまま** verdict_line に転記すること
（解釈・言い換え・要約をしない）。その行が出力にない場合は verdict_line を null にする。
再燃・停滞の行や台帳の形式指摘（exit 1 の指摘一覧）があれば notes に要約すること。
（保留の minor 行は採否待ちの正常状態であり形式指摘ではない）`

const setupPrompt = `dandori-review の入口確認を行ってください。コードやドキュメントの修正はしないこと。

1. ${SPEC} と ${DESIGN} が存在するか確認する
2. ${SPEC} に dandori-state-model ブロック（\`\`\`dandori-state-model フェンス）があるか確認する
3. ${LEDGER} が存在すれば読み、R-n 行の Rd 列の最大値を max_r_round として報告する
   （台帳がない・R 行がない場合は 0）`

// ---- メインループ -------------------------------------------------------------

const setup = await tryAgent(setupPrompt, { label: '入口確認', phase: '入口確認', model: 'sonnet', effort: 'low', schema: SETUP_SCHEMA })
if (!setup) throw new Error('入口確認エージェントが結果を返さなかった')
if (!setup.files_ok) {
  return { status: 'blocked', reason: `ファイル欠落: ${setup.missing || '不明'}`, ledger: LEDGER }
}

const startRound = (setup.max_r_round || 0) + 1
let round = startRound
let rRowsExist = (setup.max_r_round || 0) > 0
const minors = []

// minor は反証を通らずユーザーに直接届く — 台帳照合（dup_minor 処分）で既存論点の
// 再報告を落としてから蓄積する（同一論点が別ラウンドで重複提示される実測への対処）
const addMinors = (findings, entries) => {
  const byIndex = new Map(entries.map(e => [e.index, e]))
  findings.forEach((f, i) => {
    if (f.severity !== 'minor') return
    const e = byIndex.get(i)
    if (e && e.disposition === 'dup_minor') return
    minors.push(f)
  })
}

/**
 * 照合（エージェント）→ 追記（決定的コマンド）の 2 段。戻り値は
 * { entries, idByIndex } — entries は照合の処分、idByIndex は追記で発番された行 ID。
 * 照合が無応答なら全件 new として追記に回す（指摘の消失は回復できないため安全側）。
 * 追記が失敗しても null を返さない — 台帳行なしで後段（反証）を続ける。
 */
async function recordFindings(findings, round) {
  const matched = await tryAgent(matchPrompt(findings, round), {
    label: '台帳照合', phase: `Rd${round} 台帳`, model: 'sonnet', effort: 'low', schema: MATCH_SCHEMA,
  })
  if (!matched) log(`台帳照合係が無応答 — 指摘 ${findings.length} 件を全件 new として追記に回す`)
  const entries = matched
    ? matched.entries.filter(e => {
      if (findings[e.index]) return true
      log(`台帳照合係の index ${e.index} が不正 — 対応する指摘を特定できない`)
      return false
    })
    : findings.map((_, index) => ({ index, disposition: 'new', matched: null }))
  const judged = new Set(entries.map(e => e.index))
  findings.forEach((_, index) => {
    if (!judged.has(index)) {
      log(`台帳照合係の判定から漏れた指摘（index ${index}）— new として追記する`)
      entries.push({ index, disposition: 'new', matched: null })
    }
  })

  const toAppend = entries.filter(e => e.disposition === 'new' || e.disposition === 'rekindle')
  const idByIndex = new Map()
  if (toAppend.length === 0) return { entries, idByIndex }

  const rows = toAppend.map(e => ({
    index: e.index,
    severity: findings[e.index].severity,
    topic: findings[e.index].title,
    // minor の新規行だけ「保留」（採否待ち）。blocker / major は空 — 反証・反映フェーズが埋める
    action: findings[e.index].severity === 'minor' && e.disposition === 'new' ? '保留' : '',
    reason: findings[e.index].evidence,
  }))
  const appended = await tryAgent(appendPrompt(rows, round), {
    label: '台帳追記', phase: `Rd${round} 台帳`, model: 'sonnet', effort: 'low', schema: APPEND_SCHEMA,
  })
  if (appended && appended.exit_code === 0) {
    for (const line of appended.appended_lines || []) {
      const m = String(line).match(/\[appended\]\s+index=(\d+)\s+id=(\S+)/)
      if (m) idByIndex.set(Number(m[1]), m[2])
    }
  } else {
    log(`台帳追記コマンドが失敗（exit ${appended ? appended.exit_code : '無応答'}）${appended && appended.output ? `: ${appended.output}` : ''} — 台帳行なしで続行`)
  }
  return { entries, idByIndex }
}

while (true) {
  log(`ラウンド ${round}: 独立レビューア起動（前ラウンドの記憶なし・台帳は渡さない）`)

  // 1. 独立レビュー — レビューアのモデルはセッション継承（この工程の品質の源泉のため
  //    Sonnet に固定しない。codereview のレーンとは違い SKILL に「Sonnet で足りる」の宣言がない）
  const review = await tryAgent(reviewerPrompt(setup.has_state_model), {
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
      // minor だけでも台帳には全件記録する（記録漏れを握り潰すと指摘が消えたまま passed に
      // なる — 台帳の完全性は完了条件）。追記の成否は check-docs の形式検査（未処置行・欠番）が
      // 後段で拾うため、ここでは記録を試みて続行する
      const { entries } = await recordFindings(findings, round)
      addMinors(findings, entries)
      rRowsExist = true
    }
    let judge = null
    if (rRowsExist) {
      // このラウンドが行を追記していない場合、マーカーがないと check-docs は最後の行がある
      // ラウンドまでしか観測できず、過去の停滞パターンから escalated を返し続ける。
      // 「指摘なし」マーカーの追記は check-docs の --mark-zero-round に委ねる
      // （決定的・冪等 — 収束判定と同一コマンドで済む）
      judge = await tryAgent(judgePrompt(findings.length === 0), { label: '収束判定', phase: `Rd${round} 判定`, model: 'sonnet', effort: 'low', schema: JUDGE_SCHEMA })
    }
    // 完了条件は check-docs の exit 0（形式不備なし）まで含む — 未処置行や欠番を残して
    // passed を名乗らない
    const clean = !judge || (judgeVerdict(judge) !== 'escalated' && judge.exit_code === 0)
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
  const { entries, idByIndex } = await recordFindings(findings, round)
  rRowsExist = true
  addMinors(findings, entries)
  const entryByIndex = new Map(entries.map(e => [e.index, e]))

  // 3. 指摘ごと独立反証（verifier）— blocker / major のみ。minor は反証を通らず
  //    ユーザーに直接届く（finder ルールで「確信のあるもののみ」を要求済み）。
  //    skip_refuted（反証済みの再生産）は台帳行なし・反証にも回さない
  const toRefute = []
  findings.forEach((f, i) => {
    if (f.severity === 'minor') return
    const e = entryByIndex.get(i)
    if (e && e.disposition === 'skip_refuted') return
    const id = idByIndex.get(i)
    if (!id) log(`「${f.title}」の台帳行 ID を回収できなかった — 仮 ID で反証を続行（台帳の処置更新は不能）`)
    toRefute.push({ ...f, id: id || `R-?(${i})`, rekindleOf: e && e.disposition === 'rekindle' ? e.matched : null })
  })

  // 反証エージェントが無応答（skip / 終端エラー）の指摘は安全側で生存扱いにする —
  // blocker/major が黙って消えるのが最悪の失敗モード
  const verdicts = (await parallel(toRefute.map(f => () =>
    tryAgent(refutePrompt(f), { label: `反証:${f.id}`, phase: `Rd${round} 反証`, model: 'sonnet', schema: VERDICT_SCHEMA })
      .then(v => (v
        ? { ...f, refuted: v.refuted, basis: v.basis }
        : { ...f, refuted: false, basis: '反証エージェント無応答 — 安全側で生存扱い' }))))).filter(Boolean)

  if (verdicts.length > 0) {
    // 反証結果の記入は収束判定の生命線 — 未記入のまま進むと反証破棄済みの行が生存として
    // 数えられ、judgeNotes と台帳の言い分が食い違ったまま判定が汚染される（実戦観測）。
    // ACK を検査し、失敗は 1 回だけ再試行、それでも書けなければ明示的に escalate する
    let ack = await tryAgent(verdictScribePrompt(verdicts), { label: '台帳:反証結果', phase: `Rd${round} 台帳`, model: 'sonnet', effort: 'low', schema: ACK_SCHEMA })
    if (!ack || !ack.done) {
      log('反証結果の台帳記入が未完了 — 1 回だけ再試行')
      ack = await tryAgent(verdictScribePrompt(verdicts), { label: '台帳:反証結果(再試行)', phase: `Rd${round} 台帳`, model: 'sonnet', effort: 'low', schema: ACK_SCHEMA })
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
    const judge = await tryAgent(judgePrompt(false), { label: '収束判定', phase: `Rd${round} 判定`, model: 'sonnet', effort: 'low', schema: JUDGE_SCHEMA })
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
    const judge = await tryAgent(judgePrompt(false), { label: '収束判定', phase: `Rd${round} 判定`, model: 'sonnet', effort: 'low', schema: JUDGE_SCHEMA })
    const clean = !judge || (judgeVerdict(judge) !== 'escalated' && judge.exit_code === 0)
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
  const reflect = await tryAgent(reflectPrompt(survivors, setup.has_state_model ? SM_CHECK : null), { label: `反映 Rd${round}`, phase: `Rd${round} 反映`, schema: REFLECT_SCHEMA })
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
  const judge = await tryAgent(judgePrompt(false), { label: '収束判定', phase: `Rd${round} 判定`, model: 'sonnet', effort: 'low', schema: JUDGE_SCHEMA })
  if (judgeVerdict(judge) === 'escalated') {
    return { status: 'escalated', judgeNotes: judge.notes || '', minors, lastRound: round, rounds: round - startRound + 1, ledger: LEDGER }
  }

  if (round - startRound + 1 >= MAX_ROUNDS) {
    // 打ち切りは収束の失敗ではない — escalated（再燃・停滞という判定結果）と混ぜると、
    // 実際には収束しているのに「解釈が振動している」と読める報告になる（codereview 側の
    // 2026-07-25 実戦観測と同型）。この時点の状態は「生存指摘は反映済み・次ラウンドのレビュー前」
    return {
      status: 'max_rounds',
      reason: `maxRounds（${MAX_ROUNDS}）到達 — バックストップで打ち切り（収束判定は ${judgeVerdict(judge)}）。` +
        '直近ラウンドの生存指摘は spec / design に反映済みの状態。続行するなら新規実行（台帳の Rd から続きが導出される）',
      judgeNotes: (judge && judge.notes) || '',
      minors, lastRound: round, rounds: MAX_ROUNDS, ledger: LEDGER,
    }
  }

  // 7. 次ラウンド — 新しいレビューアで再レビュー
  round += 1
}
