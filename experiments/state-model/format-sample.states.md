# 記法サンプル兼回帰フィクスチャ — 状態マップ（appendix-state-map.md）の全構文

チェッカーの期待出力（`node check-state-model.ts format-sample.states.md`）:
指摘 = M1（feature_flags の borrowed 書き込み違反）+ M4（inventory_level の
external_writers 欠落）の計 2 件（exit 1）。
stock_allocation / tax_rate はグリーンの見本（tax_rate は borrowed SSOT + owned キャッシュ
という「区分は storage 単位」の見本を兼ねる）。

`format-sample-ref.spec.md` の `--map` 先としても使う（stock_allocation を ref される）。

## 状態マップ

```dandori-state-map
states:
  stock_allocation:
    label: "在庫割り当て"
    values: [S11, S12]
    storages:
      - at: "stocks.allocation"
        kind: db
        class: owned
        ssot: true
        anchor: "src/db/schema.ts:42"
    writers:
      - { via: checkout, anchor: "src/api/checkout.ts:120" }
    readers:
      - { via: order-list, anchor: "src/api/orders.ts:33" }
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
        staleness: "TTL 24h — 期限内の旧税率適用を許容"
        anchor: "src/tax/cache.ts:10"
    readers:
      - { via: checkout, anchor: "src/api/checkout.ts:200" }
  inventory_level:
    label: "倉庫在庫数（M4 違反の見本: shared なのに external_writers なし）"
    storages:
      - at: "inventories.quantity"
        kind: db
        class: shared
        ssot: true
        anchor: "src/db/schema.ts:60"
      - at: "ERP 在庫 API"
        kind: external-api
        class: shared
        sync: "出荷確定時に ERP へ push（結果整合）"
        anchor: "src/erp/client.ts:88"
    writers:
      - { via: shipping-batch, anchor: "src/batch/shipping.ts:15" }
  feature_flags:
    label: "機能フラグ（M1 違反の見本: borrowed のみなのに writers がいる）"
    storages:
      - at: "フラグ配信サービス"
        kind: external-api
        class: borrowed
        ssot: true
        anchor: "src/flags/client.ts:5"
    writers:
      - { via: admin-flags, anchor: "src/api/admin/flags.ts:30" }
    readers:
      - { via: checkout, anchor: "src/api/checkout.ts:50" }
```
