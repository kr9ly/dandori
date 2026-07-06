# state-model — Given 空間の宣言と テストパス抜けの静的検査（実験）

Given/When/Then 仕様（spec.md）の §2/§3 が散文でやっている「軸分け・直交宣言・
交点列挙」を宣言的な状態モデルに格上げし、テストパス（B 行）の抜けを機械検査する
アプローチの検証実験。前例: category-partition method / TSL（Ostrand & Balcer 1988）、
PICT、NIST ACTS/CCM。

## ファイル

- `model-types.ts` — モデル語彙の型定義（軸 / observation / modifier / 直交（グループ含む） / 依存交点 / only 制約 / 連鎖 / Covers）
- `cart-payment.model.ts` — ec-replace の cart-payment spec §2 の全訳 + 実験2 の裁定案
- `cart-payment-rollback.model.ts` — 異常系ロールバック横断のモデル（実験1: R4 blocker-2 バックテスト）
- `checker.ts` — 7 検査の決定的チェッカー（`--model=` でモデル差し替え）
- `findings.md` — 実験結果と考察（新規指摘 6 件 / バックテスト照合表 / 実験1〜3 の結果）
- `integration-design.md` — dandori-spec / ground / gate への統合設計案（実験3）

## 実行

```bash
node checker.ts              # 現行モデル
node checker.ts --as-of=fix  # spec fix 時点を復元（レビュー追加分を除外）してバックテスト
```

依存なし（node 22.18+ の type stripping で直接実行）。
