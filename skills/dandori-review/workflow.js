// @ts-nocheck — Workflow スクリプトはトップレベル return を持つ実行フォーマットで、tsc の
// モジュール検査対象外（TS1108 で後続のフロー解析が壊れ、偽の未使用変数警告が出る）
export const meta = {
  name: 'dandori-review',
  description: 'dandori review 工程の決定的ループ — 独立レビュー → 台帳追記 → 反映 → check-docs ledger 収束判定。レビューアには spec/design のパスだけを渡す',
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
//
// 戻り値 status:
//   passed             — blocker と major が両方ゼロのラウンドが出た
//   escalated          — 再燃 / 停滞 / maxRounds 到達。ユーザー裁定へ
//   needs_adjudication — spec の意図（ゴール定義・スコープ）に関わる指摘。ユーザー裁定へ
//   blocked            — spec.md / design.md が見つからない
// ============================================================================

// Claude Code の Workflow ツールは環境によって args を JSON 文字列で渡す — オブジェクトに正規化する
const A = typeof args === 'string' ? JSON.parse(args) : args

if (!A || !A.specDir || !A.checkDocs) {
  throw new Error('args に specDir / checkDocs が必要。任意: reviewDocs（パス配列） / maxRounds')
}

const SPEC_DIR = A.specDir.replace(/\/+$/, '')
const SPEC = `${SPEC_DIR}/spec.md`
const DESIGN = `${SPEC_DIR}/design.md`
const LEDGER = `${SPEC_DIR}/review-ledger.md`
const REVIEW_DOCS = Array.isArray(A.reviewDocs) ? A.reviewDocs : []
const CHECK = A.checkDocs
const SM_CHECK = A.checkStateModel || null
const MAX_ROUNDS = A.maxRounds || 8

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
          disposition: { type: 'string', enum: ['new', 'rekindle'] },
          id: { type: ['string', 'null'], description: '追記した行の R-n ID' },
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

const JUDGE_SCHEMA = {
  type: 'object',
  required: ['verdict', 'exit_code'],
  properties: {
    verdict: { type: 'string', enum: ['passed', 'escalated', 'continue'] },
    exit_code: { type: 'integer', description: 'コマンドの exit code（0 = 形式指摘なし）' },
    notes: { type: 'string', description: '再燃・停滞・形式指摘があればその内容' },
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

コードベースへの読み取りアクセスがあります。修正は行わず、指摘の列挙だけを返すこと。
各指摘に根拠となるファイル:行を付けること。`

const scribePrompt = (findings, round) => `あなたは指摘台帳の記録係です。台帳: ${LEDGER}（存在しなければヘッダ行から新規作成する）。
正準形式: | ID | Rd | 深刻度 | 論点（一行） | 処置 | 根拠・理由 |

以下の指摘を**全件**台帳に追記してください。今ラウンドは Rd=${round}、ID は R-n 系列の連番
（既存の最大 R 番号の続き。C-n 系列とは独立）。

指摘（JSON）:
${JSON.stringify(findings.map((f, index) => ({ index, severity: f.severity, title: f.title, detail: f.detail, evidence: f.evidence })), null, 2)}

手順（各指摘ごと）:
1. 既存行と同一論点かを照合する
   - 同一論点の既存行がある → 新規論点としてではなく再燃として追記: 処置セルを「再燃→<既存ID>」、
     根拠・理由セルを「escalate 判定の材料」とする。disposition=rekindle、matched に既存 ID
   - 一致なし → 新規行を追記。disposition=new。処置セルは minor なら「保留」、
     blocker / major なら空のまま（反映フェーズで記録される）
2. 論点セルは title を一行で、根拠・理由セルは（上記以外は）evidence を書く

台帳は追記のみ。既存行の書き換え・削除は禁止。`

const reflectPrompt = (items, smCheck) => `あなたは dandori-review の反映エージェントです。独立レビューの以下の指摘（blocker / major）を
spec.md / design.md に反映してください。

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

const judgePrompt = `次のコマンドを実行し、出力とコマンドの exit code を報告してください:
${CHECK} ledger ${LEDGER}

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
  minors.push(...findings.filter(f => f.severity === 'minor'))
  const majors = findings.filter(f => f.severity !== 'minor')
  log(`ラウンド ${round}: 指摘 ${findings.length} 件（blocker/major ${majors.length} / minor 累計 ${minors.length}）`)

  // 収束: blocker と major が両方ゼロのラウンド
  if (majors.length === 0) {
    if (findings.length > 0) {
      // minor だけでも台帳には全件記録する（記録失敗を握り潰すと指摘が消えたまま
      // passed になる — 台帳の完全性は完了条件なので escalate に倒す）
      const minorScribe = await agent(scribePrompt(findings, round), { label: '台帳追記', phase: `Rd${round} 台帳`, model: 'sonnet', effort: 'low', schema: SCRIBE_SCHEMA })
      if (!minorScribe) {
        return { status: 'escalated', reason: '台帳記録係が結果を返さなかった（minor 記録） — 台帳の状態をメインで確認すること', minors, lastRound: round, ledger: LEDGER }
      }
      rRowsExist = true
    }
    let judge = null
    if (rRowsExist) {
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
  const idByIndex = new Map(scribe.entries.map(e => [e.index, e]))

  // 再燃が記録されたら反映せず即 judge へ。codereview と違い review には反証フェーズが
  // ないため、再燃 = escalate が確定的（反証破棄に落ちて免れる経路が存在しない）。
  // 反映エージェントの起動が無駄になるので、確定した時点でユーザー裁定に返す
  const rekindled = scribe.entries.filter(e => e.disposition === 'rekindle')
  if (rekindled.length > 0) {
    log(`再燃検出: ${rekindled.map(e => e.matched).filter(Boolean).join(', ')} — 反映をスキップして収束判定へ`)
    const judge = await agent(judgePrompt, { label: '収束判定', phase: `Rd${round} 判定`, model: 'sonnet', effort: 'low', schema: JUDGE_SCHEMA })
    return {
      status: 'escalated',
      reason: '既存論点が再指摘された（再燃）— レビューアと処置の間で解釈が振動している',
      rekindled: rekindled.map(e => e.matched).filter(Boolean),
      judgeNotes: judge ? judge.notes || '' : '',
      minors,
      lastRound: round,
      rounds: round - startRound + 1,
      ledger: LEDGER,
    }
  }

  // 3. blocker / major を反映（狭ブリーフのエージェント1枚 — 会話にだけ存在する修正を作らない）
  const toReflect = []
  findings.forEach((f, i) => {
    if (f.severity === 'minor') return
    const e = idByIndex.get(i)
    if (!e) {
      log(`台帳記録係の報告に index ${i} がない — 仮 ID で反映を続行（台帳の処置更新は不能）`)
      toReflect.push({ ...f, id: `R-?(${i})` })
      return
    }
    toReflect.push({ ...f, id: e.id || `R-?(${i})` })
  })

  const reflect = await agent(reflectPrompt(toReflect, setup.has_state_model ? SM_CHECK : null), { label: `反映 Rd${round}`, phase: `Rd${round} 反映`, schema: REFLECT_SCHEMA })
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
  const unhandled = toReflect.filter(f => !handled.has(f.id))
  if (unhandled.length > 0) {
    log(`反映エージェントの報告から漏れた指摘: ${unhandled.map(f => f.id).join(', ')} — 台帳の未処置行として収束判定が検出する`)
  }

  // 4. 収束判定（形式検査込み）
  const judge = await agent(judgePrompt, { label: '収束判定', phase: `Rd${round} 判定`, model: 'sonnet', effort: 'low', schema: JUDGE_SCHEMA })
  if (judge && judge.verdict === 'escalated') {
    return { status: 'escalated', judgeNotes: judge.notes || '', minors, lastRound: round, rounds: round - startRound + 1, ledger: LEDGER }
  }

  if (round - startRound + 1 >= MAX_ROUNDS) {
    return { status: 'escalated', reason: `maxRounds（${MAX_ROUNDS}）到達 — バックストップ`, minors, lastRound: round, rounds: MAX_ROUNDS, ledger: LEDGER }
  }

  // 5. 次ラウンド — 新しいレビューアで再レビュー
  round += 1
}
