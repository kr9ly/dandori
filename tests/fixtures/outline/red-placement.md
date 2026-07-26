# sample-feature プログラム設計

## ファイル配置
```diff
~ src/order/order-service.ts     # placeOrder に在庫減算を足す
```

## 型とシグネチャ
```ts
function placeOrder(input: OrderInput): Order
```

## コールスタック
```
placeOrder
  └─ decrementStock
```

## 擬似コード
### placeOrder
```
在庫を減らす → 注文を確定する
```

## 論点と裁定
| # | 論点 | 出所 | 裁定 |
|---|------|------|------|
| O-1 | 一覧ハンドラをどこに置くか | ユーザー | order-service に相乗り |
