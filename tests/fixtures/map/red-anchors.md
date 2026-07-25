# 状態

<!-- generated-at: 0000000000000000000000000000000000000000 / 2026-07-25 -->

## 状態一覧
- 注文は draft → confirmed → shipped と遷移する — 根拠: `tests/fixtures/map/src/does-not-exist.ts` [読解のみ]
- 在庫は商品ごとに単一のレコードで持つ — 根拠: `tests/fixtures/map/src/order.ts:99999` [読解のみ]
- 決済ステータスは外部サービスが正 — 根拠: `tests/fixtures/map/src/order.ts:noSuchSymbol` [読解のみ]
- 出荷済み注文は変更できない
- 通知はキュー経由で送られる — 根拠: `tests/fixtures/map/src/order.ts:1`
- 確定の実体は confirmOrder — 根拠: `tests/fixtures/map/src/order.ts:confirmOrder` [読解のみ]
- 調べたが確認できなかったこと — 未確認
