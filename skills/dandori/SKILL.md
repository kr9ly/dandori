---
name: dandori
description: dandori プロセスの入口・ルーター。仕様駆動の高品質実装フローを開始・再開する。「dandori で作りたい」「dandori 再開」「この機能ちゃんと作りたい」で使う。$ARGUMENTS にフィーチャー名または要望が渡される。
---

# dandori — 入口・ルーター

dandori は「段取り八分・仕事二分」— 実装前の仕様策定・検証に工数の8割を投じることで、
エージェント実装の品質を担保するプロセス。このスキルは現在地を判定し、次の工程スキルへ案内する。

## プロセス全体像

```
フルコース:   dandori-spec → (dandori-sketch) → dandori-ground → dandori-review → (dandori-spike) → dandori-plan → dandori-impl → dandori-codereview → dandori-refine → dandori-gate → dandori-feedback
短縮コース:   dandori-spec(短縮) → dandori-impl → dandori-gate → dandori-feedback
継続改善:     dandori-feedback が裁定点 — 結論の取込（spec | ground | impl に巻き戻し → 再走 → gate → feedback）/ 結論待ちの待機 / 完全 fix の裁定 → dandori-annotate → dandori-cleanup → done
```

gate 直後に cleanup はしない — cleanup（B-ID 除去・使い捨てドキュメント処分）は不可逆な
店じまいであり、**改訂がもう来ないと確定してから**行う。その裁定点が dandori-feedback:
セッション外のレビュー・運用で決まった**結論**をユーザーが持ち込んだら改訂サイクル
（revision）として巻き戻して再走し、「実装は完全に fix」の裁定が出たら annotate
（design.md 等の処分で消える Why / Why not をコードコメントとして保全）→ cleanup → done で
閉じる。done 後に結論が来た場合も dandori-feedback で再開できる（B-ID 剥がし済みのため
再 gate は差分トレースになる）。

状態はすべてフィーチャーディレクトリのドキュメントに永続化される。セッションをまたいで再開できる。

```
<project>/.dandori/specs/<feature>/
├── state.yaml      # 現在フェーズ・進捗（このスキルが管理）
├── spec.md         # 要件 + 振る舞い仕様 + 品質ゲート【長寿命・実装後も残す】
├── sketch.md       # デザイン指示の読み取り + 変更/不可侵の領域マップ【UIタスクのみ・使い捨て】
├── design.md       # 前提・改変箇所・不変条件 + 発見ログ【実装完了まで】
├── plan.md         # マイルストーン + コンテキストマニフェスト【使い捨て】
├── trace.md        # gate 工程の B 行トレース表【使い捨て — cleanup の作業リストを兼ねるため処分は cleanup 工程で】
└── review-ledger.md # review / codereview / feedback の指摘台帳（却下・反証破棄も記録）【使い捨て】
```

## リソースマップ（.dandori/resources.md）

プロジェクト固有の情報参照先を dandori に教えるための**任意**ファイル。
「何が・どこにあり・どんなときに参照すべきか」を列挙する。存在しなければ
従来どおり各工程がその場で探索する。

```markdown
# dandori リソースマップ

- docs/architecture.md — モジュール構成と依存ルール。土台調査の起点
- docs/coding-guide.md — 命名・エラーハンドリングの規約。実装・レビューの基準
- docs/domain/ — ドメイン仕様。spec 壁打ちの元ドキュメント
- `make test` — unit ゲートの正準コマンド
- REVIEW.md — 過去のバグ頻出パターン。レビュー観点に追加する
```

形式は自由（1行1エントリ = パス + 何か + いつ使うか、を推奨）。運用ルール:

- **各工程スキルは工程開始時にこのファイルを読み**、自工程に関係する参照先だけを
  選んで使う。ルーターを経由しない直接起動（「レビューループ回そう」等）でも読む
- 参照先の中身を無条件に全部読み込まない。マップは「どこにあるか」の索引であり、
  読むかどうかは各工程が必要性で判断する
- 新規開始時にファイルが無く、プロジェクトに規約・設計ドキュメントが存在するようなら、
  作成をユーザーに提案してよい（必須ではない）
- 各工程が前提にする機械検査の基盤（テスト・lint/format・ミューテーションテスト等）が
  揃っているかは `dandori-doctor` でまとめて診断できる。初適用時に実施を提案してよい

## 手順

### 1. 状態確認

`.dandori/resources.md` があれば読み込む。

`.dandori/specs/*/state.yaml` を探す。$ARGUMENTS にフィーチャー名があればそれを優先。

- **該当フィーチャーの state.yaml が存在する** → §3 再開へ
- **存在しない** → §2 新規開始へ

### 2. 新規開始 — トリアージ

まずフィーチャー名（kebab-case）を決め、ユーザーの要望を1〜2文で要約して確認する。

次にコースを判定する。以下のいずれかに該当すれば**フルコース**:

- 新規サブシステム・新規モジュールの導入
- 不可逆な変更（DB スキーマ、公開 API、データ移行、削除を伴う変更）
- 外部システム・外部仕様との接続
- 影響が複数モジュールにまたがる

どれにも該当しなければ**短縮コース**（バグ修正、局所的な機能追加、リファクタリング）。

コースと独立に、**デザイン接地工程（dandori-sketch）の要否**も判定する:
デザイン指示（Figma・デザインスペック・画像・見た目の口頭指示）を伴う、または
画面の見た目が変わるタスクなら `sketch.status: pending`、UI に触れないなら
`skipped`（理由つき）を state.yaml に初期設定する。

判定結果と根拠をユーザーに提示して承認を得る。ユーザーの裁定が常に優先。
承認後、`.dandori/specs/<feature>/state.yaml` を作成して `dandori-spec` へ進む。

### 3. 再開

まず state.yaml の整合検査を実行する:
`node <dandori-repo>/skills/dandori/scripts/check-docs.ts state <state.yaml>`
（語彙・フェーズと phases_done の矛盾・完了済み工程の status・成果物ファイルの
存在/処分漏れを機械検査する）。指摘があれば報告に含め、state の腐りを
実態に合わせて直してから次工程へ進む（ドキュメントが正 — 実態の側を state に合わせない）。

その上で state.yaml を読み、以下を報告する:

- フィーチャー名・コース・現在フェーズ
- 直近の完了工程と成果物（該当ドキュメントの見出しレベルの要約）
- 次にやるべき工程スキル

そのまま次工程スキルを起動する（ユーザーが別の指示をしない限り）。

**`phase: feedback` のフィーチャー**は結論待ちの安定点 — dandori-feedback へ遷移し、
取込 / 待機継続 / 完全 fix（annotate → cleanup へ）の裁定を仰ぐ。
**`phase: done` のフィーチャー**が指定された場合も **dandori-feedback** へ遷移する
（cleanup 済みの再開経路）。取り込むフィードバックがなければそのままクローズ（done 維持）で終わる。

## state.yaml 形式（正準定義）

```yaml
feature: user-notification        # フィーチャー名（ディレクトリ名と一致）
course: full                      # full | short（改訂サイクルでは feedback が再判定する）
phase: review                     # spec | sketch | ground | review | spike | plan | impl | codereview | refine | gate | feedback | annotate | cleanup | done（feedback は gate 後の安定点 — 継続改善の裁定点。annotate へは feedback の完全 fix 裁定で進み、annotate 完了で cleanup へ）
phases_done: [spec, ground]       # 完了済みフェーズ（feedback は改訂のたび再訪する — ここには入らない）
revision: 2                       # 改訂サイクル番号（継続改善時のみ。初回サイクルは書かない — feedback が 2 から採番）
sketch:
  status: skipped                 # pending | done | skipped（トリアージで初期設定）
  reason: UI に触れない
review:
  rounds: 2                       # 実施済みレビューラウンド数
  status: in_progress             # in_progress | passed | escalated
spike:
  status: skipped                 # pending | done | skipped
  reason: 全前提が実行検証済み
impl:
  milestones_done: 2              # 整数カウンタ（逐次実装）または完了 ID リスト [M1, M2]（並列実装 — workflow.js はこちらで記録）
  milestones_total: 5
codereview:
  rounds: 1                       # 実施済みコードレビューラウンド数
  status: in_progress             # in_progress | passed | escalated | skipped（短縮コース）
refine:
  status: done                    # pending | done | skipped（短縮コース）
  applied: 3                      # 適用した提案数
  rejected: 1                     # 棄却した提案数
annotate:
  status: pending                 # pending | done | skipped（処分対象ドキュメントが1つも無い場合のみ）
  annotated: 2                    # 付与したコメント数（done 時。候補ゼロの走査完了は 0）
cleanup:
  status: pending                 # pending | done | skipped（B-ID をコード上に残す裁定 — クローズは省略不可）
feedback:
  items: 5                        # 台帳の F 行数（継続改善時のみ）
  trace_scope: delta              # delta | full — 再 gate での旧 B 行の扱い（done からの再開時のみ — cleanup 前のループでは書かない）
progress: §2 正常系の壁打ち中   # 工程内の現在地（一行）。工程スキルが逐次更新する
updated: 2026-07-03
```

各工程スキルは**工程内でドキュメント（spec.md / design.md / plan.md）を更新するたびに** `progress` と `updated` を書き換え、state.yaml を常に現状と一致させる。工程完了時だけの更新では、中断時に再開点が失われる。形式・整合は `check-docs.ts state` で機械検査できる（再開時は必須、工程完了時の更新後にも推奨）。フェーズの逆行（例: spike で前提が
崩れて spec に戻る）も正当な遷移 — その場合 `phases_done` から該当フェーズを外し、理由を
design.md の発見ログに記録する。

## 原則（全工程共通）

- **状態はドキュメントが正**。会話の記憶より .dandori/specs/ 配下のファイルを信頼する
- **ユーザー接点は3つに集約**: spec の壁打ち、レビュー結果の裁定、最終ゲートの裁定。それ以外は自律で進める
- **机上と現実を混同しない**。コードを読んで得た前提は「読解のみ」、実行して確かめた前提だけが「実行検証済」
