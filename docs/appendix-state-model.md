# 付録: 状態モデル — Given 空間の宣言とテストパス抜けの静的検査

dandori-spec の §2（正常系バリエーション）/ §3（異常系マトリクス）が散文でやっている
「軸分け・直交宣言・交点列挙」を宣言的な状態モデルに格上げし、B 行の抜けを機械検査する。
appendix-formal.md と同じく、条件に引っかかったときに開く参照ドキュメント。

前例: category-partition method / TSL（Ostrand & Balcer 1988）、PICT、NIST ACTS/CCM。
実証: `experiments/state-model/findings.md` — R23 通過済み spec から新規指摘 6 件、
レビュー指摘（R4 blocker-2 型）のバックテスト完全ヒット。

## 発動条件

- §2 で**軸分けが発動した**（バリエーション目安 10 超）spec — 軸が 3 つ以上あれば元が取れる
- §3 で**フェーズ×リソース型の横断関心事**（ロールバック・補償処理・通知）が出た spec
- 該当しない小さい spec（B 行 10 本未満・軸なし）ではスキップしてよい。
  ただし状態変数が 2 個以上あるなら「2 変数の同時発生」の交点だけは意識すること
  （cancel-order-product B-38/B-39 はこの型の取り落としだった）

## spec.md への書き方

### 状態モデルブロック

`## 状態モデル` セクションに info string 付き fenced block で置く:

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
    per_item: true        # 商品単位で値を取る — 混在の裁定が必要
    values: [S11, S12]
observations: { S14: { of: [stock] } }          # 他軸の帰結の観測 — 直積から除外
modifiers: { S22: { affects: [ERP, 購入通知] } } # 他シナリオの出力の修飾 — 同上
orthogonal:
  - { axes: [wms, payment], reason: 出庫結果は WMS レスポンスのみで決まる }
  - { axes: [similar_return, "*"], reason: 過去注文データのみに依存 }   # "*" = 全軸と直交
orthogonal_groups:
  - { group: [route, order_no, pickup], reason: 付帯状態は相互に独立 }  # グループ内全ペア直交
dependent:
  - { cells: { payment: S5, coupon: S7 }, note: pending は ERP スキップ }
only:
  - { axis: order_no, value: preassigned, requires: { payment: [S4, S5] }, note: WalletPay 限定 }
chains:
  - { from: S16, to: S18, note: 422 再送失敗は仮宛先チェーンへ続落 }
```
````

- 値 ID は §2 の S 番号を正とする。S 番号の意味（散文）は従来どおり軸説明に書く —
  モデルブロックは索引であり人間向けの正文を置き換えない
- 異常系は**横断関心事のみ**軸化する（裁定 2026-07-06）: 失敗タイミング
  （フェーズ構造をそのまま値域に写す）× 確保済みリソース（Shipping 状態など）+ only 制約。
  エラーマトリクス全行の形式化はしない — E 行↔B 行の突合は gate トレースの仕事

### B 行の Covers フィールド

```markdown
### B-4: wallet_pay 与信 pending（S5）
- Covers: base + payment=S5
- Given: ...（散文はこれまでどおり）
```

- デルタ構文。未言及の軸は基準値（base）に展開される
- パラメタライズは `payment=S1|S2`（1 行で複数値をカバー）
- 観測・修飾・連鎖は `Covers: base + obs:S14` / `mod:S22` / `chain:S16`

## モデリングの実務ノウハウ（実験で判明した罠）

1. **排他値のふりをした独立変数を分解する**。cart-payment の「軸2: 割引（4態）」は
   実際は coupon / promo / fixed_discount の独立 3 軸だった（spec 自身が B 行内で
   組成を認めていた）。「軸5: 付帯状態（6態）」も独立ブールの束。
   分解の判定: 2 つの値が 1 リクエストで同時に成立し得るなら別軸
2. **observation / modifier を軸にしない**。直積に入れると無意味な組み合わせ要求で
   ノイズが爆発する。「Xは Y の結果の観測」「X は他シナリオの出力を変えるだけ」と
   言えるものは種別を分ける
3. **per_item 軸は混在の裁定を忘れない**。商品単位の軸（在庫割り当て等）は
   1 注文内の値混在が成立する — 混在時の挙動を直交と宣言するか交点として列挙する
4. **軸の分解作業自体が仕様バグの発見源**。Then の奥に散文で埋まった相互作用
   （「〜の場合のみ」「〜は除外」）は依存宣言への昇格候補 — 分類時に B 行の Then を
   注意深く読むこと

## チェッカー

人力運用フェーズ（現在）: モデルを `experiments/state-model/` の TS 形式に翻訳して実行する。

```bash
cd <dandori-repo>/experiments/state-model
# cart-payment.model.ts をコピーして書き換え
node checker.ts --model=./my-feature.model.ts
```

| # | 検査 | 指摘の意味と対応 |
|---|------|-----------------|
| 1 | 値カバレッジ | テストパスの抜け → B 行を追加 |
| 2 | 依存交点カバレッジ | 交点主張が空虚に真になるリスク → 組み合わせ Given の B 行を追加 |
| 3 | ペア分類の全数性 | 未裁定の組み合わせ → 直交宣言（理由つき）or 交点列挙 or ground 送り |
| 4 | only 制約違反 | 到達不能な Given → B 行の Given に前提軸の値を明記 |
| 5 | 連鎖カバレッジ | 宣言した続落に B 行がない → パラメタライズで追加 |
| 6 | 観測・修飾カバレッジ | 検証する B 行がない → 追加 |
| 7 | per-item 混在 | 混在が未裁定 → 直交宣言 or 交点列挙 |

## ゲート運用

- **spec fix の前提条件 = チェッカーグリーン**（裁定 2026-07-06）。
  ただし「ground 送り」を宣言すれば通る: 裁定不能なペアは
  `orthogonal` に書かず、ground の確認項目としてモデルにコメントで残す。
  チェッカーが強制するのは**裁定の存在**であり、正しさは壁打ちと ground で担保する
- 検査 3 の指摘はそのまま壁打ちの議題リストとしてユーザーに出す
  （実測: 30 件中 27 件は spec 本文から即裁定、残 3 件が ground 送り）
- gate 工程では B 行の増減後にチェッカーを再実行する（末尾追加・改番禁止の
  既存ルールとそのまま整合）

## 検出できないもの — 過信防止

このモデルは**レビューループの代替ではない**。以下の型は原理的に守備範囲外で、
従来どおり ground / review / formal レーンで扱う:

1. **軸内の逐次連鎖の発見** — 宣言されていない chains は要求できない
2. **分類述語の値域の穴**（「どの文言にも一致しない 422」型）— formal レーン
   （全列挙 / Z3、appendix-formal「被覆の穴」）の守備範囲
3. **未発見の状態変数**（optout 型）— 変数の発見は ground / review の仕事
4. **値内部のセマンティクス**（照合条件の非対称、キー付け替え等）— コード読解でしか出ない
5. **エラー優先順位の導出**（2 条件同時はどちらが勝つか）— 異常系の形式化を
   横断関心事に限定した裁定の帰結。散文の評価順序宣言とレビューで扱う

## 統合ロードマップ

設計の詳細と裁定記録: `experiments/state-model/integration-design.md`。
現在は導入ステップ 1（人力運用で摩擦実測）。spec.md 直接パース版チェッカーと
SKILL.md への工程組み込みは実測後。
