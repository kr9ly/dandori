# 記法サンプル兼回帰フィクスチャ — ref:（状態マップ紐づけ）構文

チェッカーの期待出力:

- `node check-state-model.ts format-sample-ref.spec.md --map format-sample.states.md`
  → 指摘 = M3 の 1 件（軸 stock の値 S13 が canonical 値 {S11, S12} にない）。exit 1
- `--map` を省略し、上位に .dandori/map/states.md も無い場合 → exit 2
  （ref を使う spec でマップ不在はサイレントスキップしない）
- ref の無い spec（format-sample.spec.md）はマップ不要で従来動作 — オプショナル性の回帰

## 状態モデル

```dandori-state-model
axes:
  stock:
    label: "軸1: 在庫割り当て（共有状態 — 状態マップに紐づけ）"
    ref: stock_allocation
    base: S11
    values: [S11, S12, S13]   # S13 は canonical {S11, S12} に無い — M3 指摘の見本
  route:
    label: "軸2: 導線（フィーチャーローカル — ref 不要）"
    base: web
    values: [web, app]
orthogonal:
  - { axes: [route, stock], reason: "導線は在庫割り当てに影響しない" }
```

## 振る舞い仕様

### B-1: 基準シナリオ
- Covers: base
- Given: 在庫 S11・web 導線

### B-2: 在庫引き当て失敗（S12）
- Covers: base + stock=S12
- Given: 在庫 S12

### B-3: canonical に無い値（M3 見本）
- Covers: base + stock=S13
- Given: 在庫 S13

### B-4: アプリ導線
- Covers: base + route=app
- Given: app 導線
