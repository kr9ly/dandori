# sample 仕様

## ゴール
サンプル。

## スコープ外
- なし

## 振る舞い仕様

### B-1: Then と Gate がない
- Given: 在庫 1 の商品
- When: 注文する

### B-2: ゲートタグが語彙外
- Given: 在庫 0
- When: 注文する
- Then: 409
- Gate: integration

### B-3: 乖離マークの注記がない
- Given: 在庫 1
- When: 注文する
- Then: 確定する
- Gate: e2e→unit

## 未解決事項
- なし
