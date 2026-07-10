---
name: dandori-gate
description: dandori プロセスの最終品質ゲート工程。spec.md の全 B 行を検証状況とともにトレースし、未検証を列挙した上でコミット可否をユーザーと裁定する。dandori ルーターから遷移するか「最終チェックしよう」で使う。
---

# dandori-gate — 最終品質ゲート

spec.md の全振る舞い仕様を機械的にトレースし、「仕様のどの行が未検証か」を
明示する工程。ゴールは「全部やった気がする」ではなく「B-n ごとの検証状況の表」。
**サイレントに通過する行があってはならない**。

## 手順

### 1. トレース表の作成

spec.md の全 B 行について、以下の表を **`.dandori/specs/<feature>/trace.md` に書き出す**
（会話出力だけで済ませない — manual 確認待ちの中断や再実行をまたいで状態を保持するため）。
既存の trace.md があれば前回のゲート実行の残骸なので、全行を再検証して上書きする:

```markdown
| B 行 | ゲート | 状態 | 根拠 |
|------|--------|------|------|
| B-1 | unit | ✅ passed | test/xxx.test.ts の "..." （実行して確認） |
| B-2 | e2e | ✅ passed | `npm run e2e` 出力（本ゲートで再実行） |
| B-3 | manual | ⏳ ユーザー確認待ち | 確認手順: ... |
| B-4 | unit | ❌ failed | <失敗出力> |
| B-5 | unit | ⚠️ 未検証 | 対応テストが存在しない |
```

- `unit`/`e2e` は**このゲートで再実行する**。impl / codereview / refine 中の通過報告を根拠に流用しない。
  実行コマンドは plan.md の割り当てを使い、`.dandori/resources.md`（リソースマップ）に
  正準コマンドの定義があればそちらを優先する
- 再実行の出力で **skipped / todo が 0 件**であることをランナーのサマリ行で機械確認する。
  skip されたテストはスイートが緑でも実行されていない — B-ID を含むテストの skip は
  偽 ✅ を生む。skipped > 0 なら該当テストを列挙し、B 行に対応するものは ⚠️ 未検証相当として
  trace.md に反映し §3 の裁定対象に含める。`check-docs.ts trace` も同一行の
  `.skip` / `.todo` / `xit` を T4 として検出するが、外側の `describe.skip` は行 grep では
  見えない — サマリの skipped=0 確認が正
- **改訂サイクル**（state.yaml に `revision: n`）のうち、cleanup 前のループ（`feedback.trace_scope`
  なし）は通常どおり全行トレースする — B-ID がテスト名に現役で残っているため機械突合がそのまま効く。
  **cleanup 済み（done）からの再開**（`feedback.trace_scope` あり — B-ID 剥がし済み）では
  trace_scope に従う:
  - `delta`（既定）: 初期トレース表の生成に `--revision <n>` を付ける — 今回の revision の
    B 行（`Rev: <n>`）だけをフルトレースし、旧 B 行は「✅ 回帰」行（スイート緑 +
    skipped/todo 0 で担保 — 対応の正は前サイクルの gate コミットの git 履歴）として出力される。
    旧 manual / visual 行は「回帰確認の要否を裁定」行になる — 改訂の影響が及ぶ行だけ
    再確認する（裁定の記録は必須）
  - `full`: 通常どおり全行トレース。旧 B 行↔テストの対応は前サイクルの gate コミット時点の
    trace.md と cleanup コミットの rename 差分から再構築する（根拠明記の手動対応付け）
- B 行↔テストの対応付けは、初期トレース表の生成で機械化されている:
  `node <dandori-repo>/skills/dandori/scripts/check-docs.ts trace <spec.md> <テストディレクトリ...>`
  が B-ID をテストコードから grep（impl の規約でテスト名に B-ID が入っている）して
  表の叩き台を出力する。対応テストが見つからない `unit`/`e2e`/`formal` 行は ⚠️ 候補、
  テスト側の幽霊 B-ID・削除済み B 行への参照も同時に検出される。
  「たぶんこのテストが該当」という推測での対応付けは、根拠欄にテスト名と B 行の
  対応理由を明記した場合のみ許す（黙って埋めない）
- `formal` はプロパティベーステスト（+ ソルバー検証があればそれも）を再実行し、
  **broken-variant（わざと壊した実装）が赤になることの確認記録**を根拠欄に残す。
  緑の結果だけでは根拠にならない（詳細: `docs/appendix-formal.md`）
- `visual` は可能ならレイアウト検証ツール等で確認し、根拠を記録する
- `manual` はユーザー向けの確認手順（操作列と期待結果）を B 行から生成して提示する
- sketch.md があるフィーチャーでは、**不可侵領域ごとの「非変化確認」行を trace.md に
  足す**（B 行とは別枠）。sketch.md の「不可侵領域の検証手段」に機械検証の宣言が
  あれば実行して根拠を記録し、目視宣言なら確認手順を §2 のユーザー確認に回す。
  ⚠ 付き（変更領域に隣接）の領域は目視でも省略不可
- **plan カバレッジ検査を再実行する**
  （`node <dandori-repo>/skills/dandori/scripts/check-docs.ts plan <spec.md> <plan.md>`）。
  impl 中に B 行が増減していると plan 策定時の検査結果は古い — 未カバーの B 行
  （どのマイルストーンにも割り当てがない = ゲート漏れの温床）は ⚠️ 相当、
  幽霊参照は ❌ 相当として trace.md に行を足し、§3 の裁定対象に含める
- spec.md に状態モデル（`dandori-state-model` ブロック）があれば、**チェッカーを再実行する**
  （`node <dandori-repo>/skills/dandori-spec/scripts/check-state-model.ts <spec.md>`）。
  impl 中の B 行増減後のカバレッジを再検証するため。指摘（exit 1/2）は ❌ 相当、
  **ground 送り項目の残存は ⚠️ 相当**として trace.md に行を足し、§3 の裁定対象に含める
- 状態マップ（`.dandori/map/states.md` に `dandori-state-map` ブロック）があるプロジェクトは
  さらに（無ければこの項はスキップ）:
  - **マップ単体の検査**を実行する（`node .../check-state-model.ts .dandori/map/states.md` —
    M1/M2/M4）。指摘は ❌ 相当として trace.md に行を足す
  - design.md の「共有状態への影響」節の**影響 spec 一覧を提示し、回帰確認の要否を
    ユーザーと裁定する**（影響 spec の B 行を全数再検証するかはコスト次第 — 裁定の記録が
    必須で、全数再検証は必須ではない）

### 2. manual 項目のユーザー確認

`manual` タグの行をまとめて提示し、ユーザーの確認結果を trace.md に反映する。

### 3. 裁定

**全行 ✅ の場合**: サマリー（トレース表 + 発見ログの要約）を提示し、コミットを提案する。
コミット前に design.md の発見ログを見直し、**長寿命の spec.md に還流すべき知見**
（実装で判明した仕様の precision 向上）があれば反映を提案する。

**❌ / ⚠️ が残る場合**: 分類して対応を裁定する:

- **実装バグ** → 該当マイルストーンの修正ループへ（dandori-impl の §2〜3 を単発で回す）。
  修正後、このゲートを最初から再実行する
- **前提の欠落**（spec/design が現実と合っていなかった） → ユーザーと相談し、
  spec.md を修正して差し戻すか、方針転換するかを意思決定する。
  該当フェーズへ逆行し、state.yaml と発見ログに記録する
- **検証手段の不在**（⚠️ 未検証） → テストを追加するか、ユーザー承認の上で
  ゲートタグを manual に降格するか。**黙認は不可**

### 4. feedback への遷移

コミット完了後、state.yaml を `phase: feedback` にして **dandori-feedback へ遷移する**。
gate 直後に cleanup はしない — cleanup（B-ID 除去・使い捨てドキュメントの処分）は
不可逆な「店じまい」であり、**改訂がもう来ないと確定してから**行う。その裁定点が
feedback: フィードバックを取り込んで改訂サイクルを回すか、「実装は完全に fix」として
cleanup → done でクローズするかは feedback 工程でユーザーが決める。

**trace.md はこの工程では処分しない** — 改訂サイクル中は最新の検証状況の記録として生き、
最終的に cleanup が B 行↔テスト対応の作業リストとして使う。

## 完了条件

- トレース表の全行が ✅（またはユーザー裁定による明示的な受容）
- コミット済み、state.yaml が `phase: feedback`（cleanup のタイミング裁定は dandori-feedback が担う）
