---
name: dandori-cleanup
description: dandori プロセスのクローズ工程。feedback で「実装は完全に fix — 改訂はもう来ない」の裁定が出たフィーチャーを、map への知見昇格とフィーチャードキュメント一式の処分（墓碑コミット）で店じまいする。dandori-feedback の完全 fix 裁定から遷移するか「クローズしよう」「店じまいしよう」で使う。
---

# dandori-cleanup — 店じまい（墓碑コミットによるクローズ）

プロセス言及の除去（B-ID・dandori 参照コメント）は gate 直後の strip 工程で済んでいる。
この工程が担うのは**不可逆な処分**だけ — spec.md を含むフィーチャードキュメント一式の
墓碑コミットによる処分と、その前段の知見昇格。不可逆だから、feedback 工程で
「実装は完全に fix — 改訂はもう来ない」の裁定が出たときにのみ実行する。
処分後の再 gate は git 履歴経由の差分トレースに落ちる（dandori-feedback の
done からの再開経路）。

## 入口条件

- state.yaml: `phase: cleanup`（gate 通過・コミット済み + annotate・strip 完了 —
  `phases_done` に strip + feedback で完全 fix の裁定済み）
- trace.md が存在する — B 行↔テストの対応の正。処分はこの工程の最後（§3）まで行わない。
  改訂サイクルを回したフィーチャーでは最後の gate の trace.md が全生存 B 行をカバーしている

## 手順

### 1. residue の最終確認

strip 完了から時間が経っている（feedback で待機した・改訂サイクルを回した）場合に備え、
対象ファイル（strip §1 と同じ機械生成手順）への residue 検査を再実行して **exit 0** を
確認する。指摘が出たら strip の手順（言及の除去 → 検証 → 専用コミット）を単発で
適用してから進む。

### 2. 処分前の確認

- push 型項目（未解決リスク・分離タスク）が annotate でタスク置き場へ転送済みであること —
  未転送が残っていたら処分せず annotate に差し戻す
- `.dandori/records.md` の必須宣言（タスク置き場・マージ方式）が揃っていること —
  欠けていれば補完を壁打ちし、タスク置き場を宣言できないプロジェクトは
  `方式: retain`（spec.md 残置）に倒す

### 3. クローズ

**この順序で**行う（昇格元の処分が先行すると知見が失われる）:

処分は**墓碑コミット**として行う（正準定義: `docs/appendix-records.md`）: spec.md を
含むフィーチャードキュメント一式を削除し、annotate が「## Why 保全」節（design.md 末尾、
短縮コースでは trace.md 末尾）に下書きしたコミット記録（`Decision:` / `Dropped:` /
`Test-Strategy:` 等の固定キー行 + `Spec-Tombstone:` trailer）を処分コミットのメッセージに
転写する。strip の B-ID 除去コミットとは分ける — 削除コミットを `git log --diff-filter=D`
で特定すれば蒸留メモと全文書の最終版（親コミット）に同時に届く。

1. `.dandori/map/` が存在すれば、dandori-survey の **update + promote** の実行を
   提案する — update は今回のコード変更の map への反映、promote は design.md /
   trace.md に蓄積されたフロー知見（実行検証済の既存コード挙動、不変条件、
   既存理解の訂正）の map への昇格。昇格元は次のステップで処分されるため、
   **必ず処分より前に**実行する。状態マップがあれば、design.md の「共有状態への影響」で
   宣言した writers/readers の増減を states.md に反映するのも update の一部
2. sketch.md・plan.md・trace.md・review-ledger.md は役目を終える（削除 or アーカイブ。リポジトリ方針に従う）
3. design.md は発見ログの spec 還流（dandori-gate §3）を済ませた上で同様に処分してよい
4. spec.md も墓碑コミットで処分する（既定 — 正はソースコード + テスト、過去の判断は
   コミット履歴と ADR。改訂が来たら feedback が墓碑の親から復元する）。
   `方式: retain` を宣言したプロジェクトのみ長寿命ドキュメントとして残す
5. state.yaml: `phase: done`、`cleanup.status: done`、`phases_done` に cleanup 追加

## スキップ

この工程にスキップはない — **クローズは省略不可**。B-ID をコード上に残す裁定は
strip 側のスキップ（`strip.status: skipped`）であり、その場合もこの工程のクローズは
通常どおり実施する。

## 完了条件

- residue exit 0（§1 の最終確認）
- クローズ手順完了 — 墓碑コミットでフィーチャードキュメント一式を処分
  （retain 宣言時は spec.md のみ残置）
- state.yaml: `phase: done`
