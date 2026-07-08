# シナリオ単位フローチャートのたたき台サンプル — cart-payment

壁打ち中、議題になっている B 行（またはレビュー指摘・依存交点）1件ごとに
エージェントが提示する想定のたたき台。1シナリオ = 1本のパス。

視覚語彙（案）:
- 実線枠 = 基準シナリオと同じ挙動のステップ（読み飛ばしてよい）
- 紫太枠 = このシナリオで挙動が変わるステップ（ここだけ読めばよい）
- 菱形 = このシナリオに絡む依存交点の条件分岐
- 赤破線 ❓ = spec 未裁定（壁打ちの議題）

## サンプル1 — B-4: wallet_pay 与信 pending（Covers: base + payment=S5）

```mermaid
flowchart TB
  s2["割引適用・金額計算"]
  s3["決済: WalletPay 与信 → pending 応答"]
  s4["在庫引当（基準どおり）"]
  s6["注文確定 — ステータス: 請求確定待ち"]
  c1{"クーポンあり？<br/>（S7 との交点）"}
  s7a["ERP 連携スキップ<br/>与信確定後に送る"]
  s7b["ERP 連携なし（基準どおり）"]
  s8["WMS 出庫依頼（基準どおり）"]
  c2{"ピックアップあり？<br/>（S21 との交点）"}
  s9a["案内メール送信なし"]
  s9b["購入通知のみ（基準どおり）"]
  q1["❓ pending が最終的に否認されたら？<br/>出庫は走っている — 取り消しフローは spec に無い"]

  s2 --> s3 --> s4 --> s6 --> c1
  c1 -->|あり| s7a --> s8
  c1 -->|なし| s7b --> s8
  s8 --> c2
  c2 -->|あり| s9a
  c2 -->|なし| s9b
  s3 -.-> q1

  classDef changed stroke:#85f,stroke-width:3px
  classDef question stroke:#d43,stroke-width:2px,stroke-dasharray:5 4
  class s3,s6,s7a,s9a changed
  class q1 question
```

壁打ちの問い方（想定）:
- 「太枠4つがこのシナリオの差分の全部 — B-4 の Then はこの4つを全部言っている？」
- 「❓: 与信否認の続落は chains に無い。B 行を足すか、スコープ外を明言するか」

## サンプル2 — B-15→B-17: WMS 422 再送 → 仮宛先続落（chain: S16 → S18）

```mermaid
flowchart TB
  s8["WMS 出庫依頼"]
  r422["422: 時間帯指定不可（キャリアX/Y 文言一致）"]
  reset["delivery_time リセット<br/>（fixed_carrier_id 有無で対象が変わる — 軸3交点）"]
  retry["再送"]
  ok2["出庫成立<br/>（時間帯指定なし）"]
  temp["仮宛先チェーンへ続落"]
  tok["仮宛先で出庫成立"]
  tfail["仮宛先も失敗 → 出庫保留"]
  mail["お詫びメール送信<br/>（リセット実行済みのまま複合）"]
  q1["❓ 文言不一致の 422（nomatch）は再送せず仮宛先直行 —<br/>お詫びメールは送る？（R12 で値は足したが Then の文言が曖昧）"]

  s8 --> r422 --> reset --> retry
  retry -->|成功| ok2
  retry -->|再失敗| temp
  temp --> tok
  temp --> tfail
  temp --> mail
  r422 -.-> q1

  classDef changed stroke:#85f,stroke-width:3px
  classDef question stroke:#d43,stroke-width:2px,stroke-dasharray:5 4
  class r422,reset,retry,temp,mail changed
  class q1 question
```

壁打ちの問い方（想定）:
- 「続落後の状態は『リセット実行済み + お詫びメール送信済み + 仮宛先』の複合 — gate の manual 確認でこの複合状態を再現できる？」
- 「tfail（仮宛先も失敗）の後続は？ — 図の末端が裸で終わっている = spec の末端も裸」
