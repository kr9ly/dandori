# 付録: 状態マップ — 共有状態の台帳と変更影響の機械導出

states.md（survey 成果物）に置く機械可読ブロックの正準定義。
spec ローカルの状態モデル（appendix-state-model.md）が**1 フィーチャーの Given 空間**を
宣言するのに対し、状態マップは**機能境界をまたぐ共有状態のプロジェクト全域の台帳** —
どの状態が、どこに保存され、誰が書き、誰が読むか — を宣言する。目的は 2 つ:

1. **変更影響の機械導出** — 「この diff が書く状態 → その状態を Given に持つ spec」を
   引き、回帰させるべき仕様の一覧を得る
2. **SSOT 検査** — 同一状態の保存場所が複数あるとき、どれが正でどう同期するかの
   裁定を機械的に強制する

前例: CRUD マトリクス（機能×エンティティの読み書き表）、frame condition / modifies 節
（JML `assignable`, Dafny `modifies`）、separation logic の frame rule。

## 設計原則

- **過大近似で運用する**。目的は「影響するかもしれない範囲を漏らさない」ことで、
  偽陽性（実際には影響しない）は許容する。プロジェクトの精密な表現はコードの仕事 —
  マップは影響分析に足る粗さでよい
- **行に載せるのは機能境界をまたぐ共有状態だけ**:
  - 2 つ以上の機能（フロー）が読む/書く状態
  - 外部システムに保存される、または外部から更新される状態
  - フィーチャーローカルな状態は載せない — 構造的に閉じており、spec ローカルの
    状態モデルで足りる。この線引きが表サイズを状態モデル数十行に保つ
- **区分・writers/readers は解釈**（survey の原則どおり）。DB が専有か共有かは
  コードから読めないインフラ・組織知識 — ユーザー裁定で埋め、証拠アンカーを付ける

## 区分: owned / shared / borrowed

保存場所（storage）単位に付与する。**状態単位ではない** — 同じ状態が owned な
DB カラムと borrowed な外部 API レスポンスの両方に写しを持つケースがあるため。

| 区分 | 意味 | 帰結 |
|------|------|------|
| `owned` | アプリ内に閉じる。書き手はアプリのコードだけ | 遷移・到達可能性の検査がコード内で完結する |
| `shared` | アプリの操作で更新しうる外部状態（決済プロバイダ、レガシー共有 DB 等） | 書き手がアプリ外にもいる → `external_writers` の宣言必須。Given の到達可能性はアプリ内 writers で閉じない。失敗時の補償/rollback の裁定を spec に要求できる |
| `borrowed` | 完全な外部依存。アプリは読むだけ | **writers の紐づけ禁止（機械検査 M1）**。アプリ内の写しはすべてキャッシュ扱い → 鮮度・失効の裁定（`staleness`）必須 |

## states.md への書き方

`## 状態マップ` セクションに info string 付き fenced block で置く。
散文の状態一覧（従来の states.md 本文）を置き換えない — マップは索引であり、
遷移やライフサイクルの説明は従来どおり散文に書く。

````markdown
## 状態マップ

```dandori-state-map
states:
  order_status:
    label: "注文ステータス"
    values: [pending, paid, shipped, cancelled]
    storages:
      - at: "orders.status"
        kind: db
        class: owned
        ssot: true
        anchor: "src/db/schema.ts:42"
      - at: "ERP 注文ステータス"
        kind: external-api
        class: shared
        sync: "checkout フローが ERP へ push（結果整合）"
        anchor: "src/erp/client.ts:88"
    writers:
      - { via: checkout, anchor: "src/api/checkout.ts:120" }
      - { via: admin-order-update, anchor: "src/api/admin/orders.ts:60" }
    external_writers:
      - { who: "ERP 側バッチ", note: "shipped への遷移はアプリ外から来る" }
    readers:
      - { via: order-list, anchor: "src/api/orders.ts:33" }
      - { via: shipping-batch, anchor: "src/batch/shipping.ts:15" }
  tax_rate:
    label: "消費税率"
    storages:
      - at: "税率マスタ API"
        kind: external-api
        class: borrowed
        ssot: true
        anchor: "src/tax/client.ts:20"
      - at: "アプリ内キャッシュ"
        kind: cache
        class: owned
        staleness: "TTL 24h — 期限内の旧税率適用を許容（裁定 spec-cart §3）"
        anchor: "src/tax/cache.ts:10"
    readers:
      - { via: checkout, anchor: "src/api/checkout.ts:200" }
```
````

### フィールド定義

| フィールド | 必須 | 意味 |
|-----------|------|------|
| `states.<id>` | — | canonical な状態 ID。spec からの参照名（snake_case） |
| `label` | ✅ | 人間向けの名前 |
| `values` | 任意 | canonical な値 ID の列挙。spec の `ref:` 付き軸はこの部分集合を使う。列挙型でない状態（数値・任意文字列）は省略可 |
| `storages[].at` | ✅ | 保存場所の識別（テーブル.カラム、外部 API 名、キャッシュ名など） |
| `storages[].kind` | ✅ | `db` / `external-api` / `cache` / `file` / `memory` / `browser`（拡張可） |
| `storages[].class` | ✅ | `owned` / `shared` / `borrowed` |
| `storages[].ssot` | 条件付き | storage が 2 つ以上ならちょうど 1 つに `true`（検査 M2） |
| `storages[].sync` | 条件付き | 非 SSOT の storage の同期手段と整合性水準（結果整合 / 同期 / 手動） |
| `storages[].staleness` | 条件付き | 非 SSOT のキャッシュ系 storage の鮮度裁定（sync と択一でどちらか必須） |
| `storages[].anchor` | ✅ | 証拠アンカー（survey の原則どおり） |
| `writers[]` | — | アプリ内の書き手。`via` は flows.md のフロー名を正とする（無ければ短い機能名）+ `anchor` |
| `external_writers[]` | 条件付き | shared な storage を持つ状態に必須（検査 M4）。`who` + `note` |
| `readers[]` | — | アプリ内の読み手。形式は writers と同じ |

## spec からの参照 — Given 紐づけ

spec ローカルの状態モデル（`dandori-state-model` ブロック）の軸に `ref:` を付ける:

```yaml
axes:
  order:
    label: "軸2: 注文ステータス"
    ref: order_status          # states.md の状態 ID
    base: pending
    values: [pending, paid]    # canonical 値 ID の部分集合（検査 M3）
```

- **紐づけ必須なのはマップに行がある状態（= 共有状態）に触れる軸だけ**。
  フィーチャーローカルな軸は従来どおり S 番号で書く — 全軸への ID 要求は
  書かせるコスト（実験 4 の摩擦）を再生産するのでしない
- `ref:` 付き軸の値は canonical 値 ID を使う（S 番号ではなく）。§2 の散文には
  従来どおり S 番号を書いてよく、対応は軸説明の散文に残す
- spec で新しい共有状態に触れたがマップに行がない → **行の追加を提案する**
  （マップの成長点。サイレントに追加せずユーザー裁定を経る）

この参照により逆引きが機械化される:
**状態 X を書く変更 → X を `ref:` する全 spec の該当 B 行 = 回帰候補**。

## 検査

check-state-model.ts が対応する（入力ファイルの fenced block で自動判別）:

```bash
# 状態マップ単体の検査（M1 / M2 / M4）
node <dandori-repo>/skills/dandori-spec/scripts/check-state-model.ts <states.md>

# spec 検査 — ref: 使用時は M3 が追加で走る。マップは --map 指定 >
# spec の上位ディレクトリの .dandori/map/states.md の順で解決
node .../check-state-model.ts <spec.md> [--map <states.md>]

# 影響導出クエリ（Q1）
node .../check-state-model.ts --impact <状態ID> <spec.md...>
```

**状態マップはオプショナル** — `ref:` を使わない spec の検査は状態マップの有無に
かかわらず従来動作と完全に同一。`ref:` を使ったのにマップが見つからない場合のみ
exit 2 で止まる（サイレントに検査をスキップしない）。

回帰フィクスチャ: `experiments/state-model/format-sample.states.md`（M1/M4 の見本）、
`format-sample-ref.spec.md`（ref 構文と M3 の見本）。

| # | 検査 | 指摘の意味と対応 |
|---|------|-----------------|
| M1 | borrowed 書き込み違反 | borrowed な storage しか持たない状態に `writers` がいる → 区分の誤りか、SSOT 侵犯コードの発見 |
| M2 | SSOT 一意性 | storage 複数で `ssot: true` がちょうど 1 つでない / 非 SSOT に `sync`/`staleness` がない → 同期責務の裁定漏れ |
| M3 | ref 整合 | spec の `ref:` が未知の状態 ID / `values` が canonical の部分集合でない → typo かマップの陳腐化 |
| M4 | shared の外部遷移 | shared な storage があるのに `external_writers` が空 → 外部起因の遷移の考慮漏れ |
| Q1 | 影響導出（検査でなくクエリ） | 状態 ID → その状態を `ref:` する spec / B 行の一覧を出力 — ground の影響範囲列挙と gate の回帰トレースに使う |

M1 は「解釈として宣言し、事実として検査できる」珍しい行 — 将来はコード走査
（該当 storage への書き込みコードパスの検出）まで自動化しうるが、まず宣言レベルの
整合検査から始める。

## 工程への組み込み

| 工程 | 役割 |
|------|------|
| survey generate | 状態観点の解析から初期版を作る。**区分（owned/shared/borrowed）と SSOT はユーザー裁定で埋める** — コードから読めないインフラ知識のため |
| spec | 共有状態に触れる軸に `ref:` を付ける。マップに行がなければ追加を提案 |
| ground | 今回の変更が書く（W）マップ行を design.md に宣言 → Q1 でその行を `ref:` する既存 spec を影響範囲として列挙 |
| gate | M1〜M4 を再検査。writers/readers の増減（今回のフィーチャーが新しい書き手/読み手になった）をマップに反映し、コミットに同梱 |
| survey verify / promote | states.md 内にあるため既存の鮮度検査・昇格の対象に自動的に含まれる。verify はアンカー先の変更で writers/readers の腐りを検出する |

## 守備範囲外 — 過信防止

- **データ結合のみ**を扱う。呼び出し関係の結合（シグネチャ変更の波及）は拾わない —
  そちらはツール（skeleton / LSP）で都度再生成できる事実であり、原則どおり
  ドキュメント化しない
- **状態間をまたぐ不変条件**（「A が active のとき B は空」型）は行単位の表に
  乗らない。spec の依存宣言（`dependent:`）か散文の不変条件として扱う
- **タイミング・順序・トランザクション境界**の完全な表現はしない。必要な粗さは
  「同一遷移で一緒に動く状態の組」程度 — それ以上は ground / formal レーンの仕事

## 経緯

2026-07-06 の設計会話より。変更影響マップとしての位置づけ（過大近似・共有状態限定で
表サイズを抑える）、保存場所単位の owned/shared/borrowed 区分、`ref:` による
Given 紐づけ → SSOT 検査と回帰 spec 導出、の 3 点を裁定。
