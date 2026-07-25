# sample-feature 仕様

## ゴール
サンプル機能の仕様。以下が満たされればゴール。
- 注文が確定できる
- 在庫不足は拒否される

## スコープ外
- 返品フロー

## 状態モデル

```dandori-state-model
axes:
  stock:
    label: "軸1: 在庫"
    base: in_stock
    values: [in_stock, out_of_stock]
  channel:
    label: "軸2: 導線"
    base: web
    values: [web, app]
orthogonal:
  - { axes: [stock, channel], reason: "導線は在庫判定に影響しない（在庫は商品側の状態のみで決まる）" }
```

## 振る舞い仕様

### B-1: 在庫のある商品を注文できる
- Given: 在庫 1 の商品
- When: 数量 1 で注文する
- Then: 注文が確定し在庫が 0 になる
- Gate: unit

### B-2: 在庫ゼロは拒否される
- Given: 在庫 0 の商品
- When: 数量 1 で注文する
- Then: 409 を返し在庫は変わらない
- Gate: unit

### B-3: 注文一覧の表示
- Given: 確定済み注文が 1 件
- When: 一覧を開く
- Then: 注文が 1 件表示される
- Gate: e2e

### ~~B-4: 旧仕様の割引表示~~
- 削除理由: 割引機能そのものがスコープ外になった（ユーザー裁定）

## 未解決事項
- なし
