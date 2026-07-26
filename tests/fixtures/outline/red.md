# sample-feature プログラム設計

## ファイル配置
```diff
  src/order/
+   audit-trail.ts          # 監査ログ（design に対応記述がない）
+   stock-guard.ts          # 在庫の減算と拒否判定
```

## 型とシグネチャ
```ts
function guardStock(check: StockCheck): void   // B-9 の実装
```

## コールスタック
```
placeOrder
  └─ guardStock
```

## 論点と裁定
| # | 論点 | 出所 | 裁定 |
|---|------|------|------|
| O-1 | guardStock は既存 StockValidator と責務が重複 | 探索レーン | |
| O-2 | audit-trail をここで足すか | 探索レーン | 未 |
| O-3 | 一覧ハンドラの置き場 | ユーザー | order/ 直下 |
| O-4 | 削除済み仕様への言及 | 探索レーン | B-4 は追わない |
