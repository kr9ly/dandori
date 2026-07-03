---
name: dandori
description: dandori プロセスの入口・ルーター。仕様駆動の高品質実装フローを開始・再開する。「dandori で作りたい」「dandori 再開」「この機能ちゃんと作りたい」で使う。$ARGUMENTS にフィーチャー名または要望が渡される。
---

# dandori — 入口・ルーター

dandori は「段取り八分・仕事二分」— 実装前の仕様策定・検証に工数の8割を投じることで、
エージェント実装の品質を担保するプロセス。このスキルは現在地を判定し、次の工程スキルへ案内する。

## プロセス全体像

```
フルコース:   dandori-spec → dandori-ground → dandori-review → (dandori-spike) → dandori-plan → dandori-impl → dandori-gate
短縮コース:   dandori-spec(短縮) → dandori-impl → dandori-gate
```

状態はすべてフィーチャーディレクトリのドキュメントに永続化される。セッションをまたいで再開できる。

```
<project>/specs/<feature>/
├── state.yaml      # 現在フェーズ・進捗（このスキルが管理）
├── spec.md         # 要件 + 振る舞い仕様 + 品質ゲート【長寿命・実装後も残す】
├── design.md       # 前提・改変箇所・不変条件 + 発見ログ【実装完了まで】
└── plan.md         # マイルストーン + コンテキストマニフェスト【使い捨て】
```

## 手順

### 1. 状態確認

`specs/*/state.yaml` を探す。$ARGUMENTS にフィーチャー名があればそれを優先。

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

判定結果と根拠をユーザーに提示して承認を得る。ユーザーの裁定が常に優先。
承認後、`specs/<feature>/state.yaml` を作成して `dandori-spec` へ進む。

### 3. 再開

state.yaml を読み、以下を報告する:

- フィーチャー名・コース・現在フェーズ
- 直近の完了工程と成果物（該当ドキュメントの見出しレベルの要約）
- 次にやるべき工程スキル

そのまま次工程スキルを起動する（ユーザーが別の指示をしない限り）。

## state.yaml 形式（正準定義）

```yaml
feature: user-notification        # フィーチャー名（ディレクトリ名と一致）
course: full                      # full | short
phase: review                     # spec | ground | review | spike | plan | impl | gate | done
phases_done: [spec, ground]       # 完了済みフェーズ
review:
  rounds: 2                       # 実施済みレビューラウンド数
  status: in_progress             # in_progress | passed | escalated
spike:
  status: skipped                 # pending | done | skipped
  reason: 全前提が実行検証済み
impl:
  milestones_done: 2
  milestones_total: 5
updated: 2026-07-03
```

各工程スキルは自工程の完了時にこのファイルを更新する。フェーズの逆行（例: spike で前提が
崩れて spec に戻る）も正当な遷移 — その場合 `phases_done` から該当フェーズを外し、理由を
design.md の発見ログに記録する。

## 原則（全工程共通）

- **状態はドキュメントが正**。会話の記憶より specs/ 配下のファイルを信頼する
- **ユーザー接点は3つに集約**: spec の壁打ち、レビュー結果の裁定、最終ゲートの裁定。それ以外は自律で進める
- **机上と現実を混同しない**。コードを読んで得た前提は「読解のみ」、実行して確かめた前提だけが「実行検証済」
