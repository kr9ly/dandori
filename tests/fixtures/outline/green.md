# sample-feature プログラム設計

## ファイル配置
```diff
  src/order/
+   stock-guard.ts          # 在庫の減算と拒否判定
~   order-service.ts        # placeOrder が guard を呼ぶ
```

## 型とシグネチャ
```ts
type StockCheck = { itemId: ItemId; quantity: number }
function guardStock(check: StockCheck): void   // 不足なら InsufficientStock
```

## コールスタック
```
placeOrder                        （既存 — src/order/order-service.ts）
  └─ guardStock                   ← 新規
       └─ decrementStock          （既存 — src/stock/service.ts）
```

## 擬似コード
### guardStock
```
current = 在庫を読む(check.itemId)
if current < check.quantity → throw InsufficientStock
decrementStock(check.itemId, check.quantity)
```

## 論点と裁定
| # | 論点 | 出所 | 裁定 |
|---|------|------|------|
| O-1 | guardStock は既存 StockValidator と責務が重複（src/stock/validator.ts:20） | 探索レーン | 重複を許す — Validator は入力検証のみで在庫を触らない |
| O-2 | 一覧ハンドラの置き場を order/ 直下にするか | ユーザー | order/ 直下 — 今後増えない |
