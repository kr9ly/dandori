# sample-feature 実装設計

## 土台（利用する既存実装）
- 在庫サービス `decrementStock()`: 在庫の減算に使う [実行検証済: `npm test -- stock` 12 passed — 在庫 0 で InsufficientStock を投げる]

## 改変箇所
- 注文サービス `placeOrder()`: 在庫減算を同一トランザクションに入れる → 影響する B 行: B-1, B-2

## 新規実装
- 一覧ハンドラ: 確定済み注文の一覧を返す → 実現する B 行: B-3

## 不変条件（変えてはいけないもの）
- 在庫は負にならない

## 軸対応
- stock: StockState 型 + placeOrder() のディスパッチ [1箇所]
- stcok: typo した軸キー [1箇所]
- channel: 判定が 3 箇所に散っている [散在]

## リスクランキング（読解のみ前提の降順）
1. なし — 全前提が実行検証済み

## 発見ログ
