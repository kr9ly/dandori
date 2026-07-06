# 記法サンプル兼回帰フィクスチャ — 状態モデルの全構文

チェッカーの期待出力: 指摘 = 検査 0（B-6 の Covers 欠落）の 1 件（exit 1）、
ground 送り = 3 件（ペア裁定 route×payment / per-item 混在裁定 stock / base 推定 stock）。

## 状態モデル

```dandori-state-model
axes:
  payment:
    label: "軸1: 決済"
    base: S1
    values: [S1, S2, { id: other, note: "text_2 を強制上書き — 値は入力に存在するが出力に反映されない" }]
  stock:
    label: "軸2: 在庫（商品単位）"
    base: S11?    # 推定 — 基準シナリオが在庫状態を明言していない
    per_item: true
    values: [S11, S12]
  route:
    label: "軸3: 導線"
    base: web
    values: [web, app]
observations:
  S14: { of: [stock] }
orthogonal:
  - { axes: [route, stock], reason: "導線は在庫割り当てに影響しない（在庫はカート内容のみで決まる）" }
dependent:
  - { cells: { payment: S2, stock: S11+S12 }, note: "S2 かつ混在で合算挙動が変わる" }
ground:
  - { axes: [route, payment], note: "導線が決済 API の呼び分けに影響するか spec からは裁定不能 — コードで確定" }
  - { axes: [stock, stock], note: "混在時の在庫引当順序が spec に記述なし — コードで確定（自己ペア = per-item 混在の裁定送り）" }
chains:
  - { from: S12, to: S11, note: "予約在庫は入荷で通常在庫に続落" }
```

## 振る舞い仕様

### B-1: 基準シナリオ
- Covers: base

### B-2: 決済バリエーション（パラメタライズ）
- Covers: base + payment=S1|S2

### B-3: 在庫混在 + S2 の合算
- Covers: base + payment=S2 + stock=S11+S12

### B-4: 予約在庫と入荷続落・アラート観測
- Covers: base + stock=S12 + chain:S12 + obs:S14

### B-5: 過去バグ再現（単発）
- Covers: one-off — 2024-08 の在庫二重減算バグの再現固定

### B-6: Covers を書き忘れた行
- Given: なにか
- Then: なにか

### B-7: 強制上書き
- Covers: base + payment=other + route=app
