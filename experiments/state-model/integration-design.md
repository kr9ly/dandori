# 統合設計案: 状態モデルの dandori プロセスへの組み込み

status: fixed（2026-07-06 壁打ち確定 — 論点3件をユーザー裁定済み。導入ステップ1へ）

## 何を足すか

spec.md に機械可読な「状態モデル」ブロックと、各 B 行の `Covers:` フィールドを追加し、
決定的チェッカーを spec fix と gate の 2 箇所に接続する。実験1〜2 の結果
（findings.md）が根拠: 23 ラウンドレビュー済み spec から新規指摘 6 件、
R4 blocker-2 型のバックテスト完全ヒット、グループ宣言でノイズ 30→3 件に収束。

## spec.md 上の表現

### 状態モデルブロック

`## 状態モデル` セクションに info string 付き fenced block で置く（機械抽出用）:

````markdown
## 状態モデル

```dandori-state-model
axes:
  payment:
    label: "軸1: 決済メソッド"
    base: S1
    values: [S1, S2, S3, S4, S5, S6]
  stock:
    label: "軸3: 在庫割り当て"
    base: S11
    per_item: true        # 商品単位 — 混在の裁定が必要になる
    values: [S11, S12]
observations: { S14: { of: [stock] } }
modifiers: { S22: { affects: [ERP, 購入通知] } }
orthogonal:
  - { axes: [wms, payment], reason: 出庫結果は WMS レスポンスのみで決まる }
  - { axes: [similar_return, "*"], reason: 過去注文データのみに依存 }
orthogonal_groups:
  - { group: [route, order_no, pickup], reason: 付帯状態は相互に独立 }
dependent:
  - { cells: { payment: S5, coupon: S7 }, note: pending は ERP スキップ }
only:
  - { axis: order_no, value: preassigned, requires: { payment: [S4, S5] }, note: WalletPay 限定 }
chains:
  - { from: S16, to: S18, note: 422 再送失敗は仮宛先チェーンへ続落 }
```
````

設計判断:

- **spec.md 内に置く**（別ファイルにしない）— B 行との乖離防止、「spec.md が単一の正」の維持
- **値 ID は S 番号を正とする** — cart-payment で自然発生した語彙をそのまま採用。
  S 番号の定義（散文）は従来どおり §2 の軸説明に書く。モデルブロックは索引であり、
  人間向けの正文を置き換えない
- **語彙は 7 種で固定**: axes（base / per_item / values）、observations、modifiers、
  orthogonal（`"*"` = 全軸）、orthogonal_groups、dependent、only、chains。
  実験でこれ以外が必要になる場面はなかった

### B 行の Covers フィールド

```markdown
### B-4: wallet_pay 与信 pending（S5）
- Covers: base + payment=S5
- Given: ...（散文はこれまでどおり — 人間向けの正文）
```

- デルタ構文（`base + 軸=値`）。未言及の軸は基準値に展開される
- パラメタライズは `payment=S1|S2`
- 観測・修飾・連鎖のカバーは `Covers: base + obs:S14` / `chain:S16`

## チェッカー

実験版 checker.ts の 7 検査を製品化する。置き場所は dandori リポジトリの
`skills/dandori-spec/scripts/check-state-model.ts`（spec.md のパスを引数に取り、
fenced block と Covers 行を直接パースする — 中間ファイルなし）。

| # | 検査 | 出力の意味 |
|---|------|-----------|
| 1 | 値カバレッジ | 軸の値にカバーする B 行がない = テストパスの抜け |
| 2 | 依存交点カバレッジ | 宣言した交点を単一の B 行が覆っていない = 主張が空虚に真になるリスク |
| 3 | ペア分類の全数性 | 未分類の軸ペア = 未裁定の組み合わせ（直交宣言か交点列挙を強制） |
| 4 | only 制約違反 | B 行の Given が到達不能な状態を含む |
| 5 | 連鎖カバレッジ | 宣言した続落・連鎖に B 行がない |
| 6 | 観測・修飾カバレッジ | observation / modifier を検証する B 行がない |
| 7 | per-item 混在 | 商品単位軸の混在が未裁定 |

## プロセスへの接続

### dandori-spec（主戦場）

- §2/§3 の壁打ちで軸分けが発動したら（既存の目安: バリエーション/交点 10 超）、
  §4 の仕様化と同時に状態モデルブロックと Covers を書く
- **§5 fix の前提条件にチェッカーグリーンを追加**。ただし「グリーン」には
  裁定つき容認を含む — 未分類ペアを「直交（理由）」と宣言する行為自体が裁定。
  チェッカーは裁定の存在を強制する装置であり、正しさは壁打ちで担保する
- 検査 3 の指摘は壁打ちの議題リストとしてそのままユーザーに出す
  （実験2 の実績: 30 件中 27 件は spec 本文から即裁定可能、残 3 件が ground 送りの真の論点）

### dandori-ground

- spec で裁定できず残った未分類ペア・per-item 混在は ground の確認項目に載せる
  （コードを読んで直交か依存かを確定 → モデルに書き戻す）

### dandori-gate

- 既存の B 行トレース表にチェッカー再実行を追加。impl 中に B 行が増減した場合の
  カバレッジ再検証が自動化される（改番禁止・末尾追加の既存ルールとそのまま整合）

### dandori-review との分担

- モデルが担保する領域（組み合わせ網羅・交点カバー）はレビュー観点から外せる。
  レビューは実験で「検出不能」と確定した型に集中する:
  値内部セマンティクス、未発見の状態変数、分類述語の値域（→ formal レーン）、軸内連鎖の発見

## 検出できないもの（スキル文書に明記する — 過信防止）

1. **軸内の逐次連鎖の発見**（R1 major-2 型）— 宣言されていない chains は要求できない
2. **分類述語の値域の穴**（R12 major-1 型）— formal レーン（全列挙/Z3、appendix-formal「被覆の穴」）の守備範囲
3. **未発見の状態変数**（R14/R15 optout 型）— 変数の発見は ground / review の仕事
4. **値内部のセマンティクス**（R1/R19/R20 blocker 型）— コード読解でしか出ない
5. **エラー優先順位の導出**（cancel-order-product B-39 型）— 異常系の形式化を
   横断関心事に限定した裁定の帰結。同時発生ペアの期待コードは従来どおり
   散文の評価順序宣言（「記載順に評価、最初のエラーで打ち切り」）とレビューで扱う

## 導入ステップ

1. 次の新規 spec 1 本で人力運用（モデルブロック手書き + 実験版チェッカー流用）— 摩擦を実測
2. チェッカーを spec.md 直接パース版に書き直し、scripts/ へ配置
3. dandori-spec / dandori-ground / dandori-gate の SKILL.md に工程を追記
4. 既存 spec（cart-payment 等）への遡及適用は任意 — 実験で出た新規指摘 6 件の裁定が先

## 裁定済み論点（2026-07-06 壁打ち確定）

1. **異常系の形式化範囲: 横断関心事のみ**。ロールバック・補償処理など
   「フェーズ×リソース」型の横断だけを軸化する。E 行↔B 行の突合は既存の
   gate トレースに任せ、エラーマトリクス全行の形式化はしない。
   帰結として**エラー優先順位の導出（B-39 型「2条件同時はどちらが勝つか」）は
   守備範囲外に残る** — 「検出できないもの」の 5 つ目として明記する
2. **チェッカーは TS + node のまま製品化**。Claude Code 実行環境には node が
   ほぼ確実にあり、スクリプトのデフォルト言語規約とも一致。Go バイナリ化
   （skeleton/sak と同じ配布形）は運用が安定した後の任意の移植とする
3. **fix ゲートはグリーン必須**。未分類ペア・未カバー交点が残ったままの fix は
   不可。ただし「ground 送り」を宣言（直交/依存の裁定を ground の確認項目として
   モデルに書く）すれば通る — チェッカーが強制するのは裁定の存在であり、
   正しさは壁打ちと ground で担保する
