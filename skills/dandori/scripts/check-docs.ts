/**
 * dandori 正準ドキュメントの横断チェッカー。
 *
 * spec.md / plan.md の正準フォーマット（各 SKILL.md の「正準定義」）間の
 * ID 突合と形式検査を機械化する。状態モデル・状態マップの検査は
 * check-state-model.ts の管轄（このチェッカーは重複しない）。
 *
 * spec モード — spec.md の正準フォーマット lint:
 *   S1. 必須セクション欠落 — ゴール / スコープ外 / 振る舞い仕様 / 未解決事項
 *   S2. セクション重複 — 同名の ## セクションが複数（逐次追記の事故検出）
 *   S3. B 行フィールド欠落 — Given / When / Then / Gate が揃っているか
 *   S4. Gate タグ語彙 — unit / e2e / visual / manual / formal 以外の混入。
 *       末尾の（）注記は文法の一部として無視する（固定単位・固定方法の宣言 — dandori-spec §4）。
 *       乖離マーク `<現状>→<希望>`（例: e2e→unit）は両辺を語彙検査し、注記（阻害要因）を必須と
 *       する。乖離行は指摘とは別枠で列挙する（ground の seam 議題リスト — exit code に影響しない）
 *   S5. B-ID 重複
 *   S6. B 行の位置 — 「## 振る舞い仕様」セクション外の B 行見出し
 *   S7. 欠番 — 純数値 ID（B-1 形式）の連番の穴（削除は取り消し線で残す規約のため、
 *       穴は無断削除の兆候）
 *   S8. 改番検知（--baseline 指定時のみ）— fix 済み spec との比較:
 *       同一 ID のタイトル変更（すり替え疑い）/ 取り消し線なしの削除 /
 *       末尾以外への挿入（追加は末尾の規約違反）
 *
 * plan モード — spec.md ↔ plan.md の B 行カバレッジ突合:
 *   B-ID 参照は trace と同じ帰属規則で解決する — 注記括弧つき（B-36(計算) 等。空白・
 *   全角文字で途切れたトークンを含む）は基底 ID が spec にあればそちらに帰属、
 *   数値開始でないトークン（B-ORDER 等）は参照として扱わない。design モードも同様。
 *   P1. 未カバー B 行 — spec の B 行がどのマイルストーンにも割り当てられていない
 *       （= 実装されない仕様）
 *   P2. 幽霊参照 — plan が参照する B-ID が spec に存在しない（typo か spec の陳腐化）
 *   P3. 削除済み参照 — 取り消し線つき B 行への参照
 *   P4. 空マイルストーン — 対応 B 行がゼロのマイルストーン（スコープ外の作業）
 *
 * design モード — design.md の形式検査と spec.md との B 行対応突合:
 *   D1. 必須セクション欠落 — 土台 / 改変箇所 / 新規実装 / 不変条件 /
 *       リスクランキング / 発見ログ（見出しの（）補足は無視して前方一致）
 *   D2. 検証マーク — 土台の各エントリに [実行検証済] / [読解のみ] が付いているか。
 *       [実行検証済] は再実行可能な証拠形式（バッククォートのコマンド併記）を要求。
 *       エントリはインデントされた継続行を含めて 1 エントリとして読む。### サブ見出しに
 *       マークを付けたグループ（配下のエントリ群にまとめて適用）も認める
 *   D3. B 行参照整合 — 土台/改変箇所/新規実装が参照する B-ID の幽霊・削除済み検出
 *   D4. 未対応 B 行 — spec の B 行が土台/改変/新規のどこにも対応しない
 *       （spec か調査のどちらかに穴 — ground の完了条件）
 *   D5. 軸対応 — spec に状態モデルがあるとき、## 軸対応 節が全軸を判定語彙
 *       （[1箇所] / [散在: 理由] / ⚠）つきでカバーしているか。軸キーの typo・
 *       1 軸複数エントリ・理由なし [散在] も検出（モデル自体の検査は
 *       check-state-model.ts の管轄 — ここでは axes のキーだけ読む）
 *
 * ledger モード — review-ledger.md の形式検査と収束判定:
 *   台帳（dandori-review / dandori-codereview / dandori-feedback 共用）をパースし、接頭辞ごと
 *   （R-n = review / C-n = codereview — ラウンド系列が別）に収束状態を機械判定する。
 *   F-n = feedback（外部の結論の受け入れ台帳。Rd は改訂サイクル番号）は収束判定の
 *   対象外 — 完了条件は全項目の処置済み（L2）。
 *   L1. 行形式 — ID 形式（R-n/C-n/F-n）/ Rd 数値 / 深刻度語彙（blocker/major/minor）/
 *       処置語彙（反映済・却下・保留・反証破棄・再燃→<ID>・空 = 未処置）
 *   L2. 処置の完全性 — 未処置の行 / 理由なしの却下・反証破棄 /
 *       blocker・major への保留（保留は minor のみ）
 *   L3. 再燃参照 — 再燃→<ID> の参照先が台帳にない
 *   L4. ID 重複・欠番（台帳は追記のみ — 欠番は行の削除の疑い）
 *   L5. ラウンド記録矛盾 — 「指摘なし」マーカーのラウンドに blocker/major の生存行がある
 *   L6. 保留の滞留 — 理由セルが空の保留（採否待ち）が 2 ラウンド以上放置されている
 *       （放置された保留論点は後続ラウンドで major として再指摘され escalate を招く — 実戦観測。
 *       ユーザー裁定済みの保留は理由セルに裁定を書くことで検査対象外になる）
 *   指摘ゼロのラウンドは台帳に行が残らず観測できない（過去の停滞パターンから escalated を
 *   返し続ける）ため、`<!-- round: C Rd=7 指摘なし -->` 形式のマーカー行で記録する
 *   （blocker/major の行を追記したラウンドでは不要）。マーカーの追記は
 *   --mark-zero-round <R|C> <rd> で行う（決定的・冪等 — 検査・収束判定と同一コマンドで済む。
 *   エージェントによるマーカーの自由編集は監査改竄と誤検知されブロックされた実戦観測があり、
 *   このオプションが恒久対策 2026-07-21）。
 *   収束判定（指摘とは別枠 — exit code に影響しない）:
 *     passed = 最新ラウンド（マーカーのみのラウンド含む）の blocker+major がゼロ
 *              （反証破棄は R/C 共通で生存数から除外）
 *     escalated = 再燃→ がある（終端の再生産が反証破棄の連鎖は除く — 反証済みの再生産。
 *                 参照が連鎖する場合は終端まで辿る 2026-07-21 改定）、
 *                 または 3 ラウンド以上連続で blocker+major 件数が減っておらず、かつ
 *                 最新ラウンドに未解消の再燃が含まれる（2026-07-10 改定）
 *     継続 = どちらでもない
 *
 * state モード — state.yaml の整合検査（ルーターの再開判定の足場）:
 *   Y1. 語彙・形式 — course / phase / 各工程 status の語彙、数値フィールド、
 *       updated の日付形式、revision（2 以上の整数 — 継続改善サイクル）、未知のキー
 *   Y2. feature 一致 — feature がフィーチャーディレクトリ名と一致するか
 *   Y3. フェーズ整合 — phase が phases_done と矛盾しない / 短縮コースに存在しない
 *       工程が記録されていない / 完了済み工程の status・カウンタが完了状態か
 *       （例: phases_done に impl があるのに milestones_done < total）/
 *       annotate は gate 通過後のみ / strip は annotate 完了後のみ /
 *       feedback / cleanup は strip 完了後のみ / done は cleanup 完了後のみ
 *   Y4. 成果物整合 — フェーズが前提とするドキュメント（spec.md / design.md / plan.md /
 *       review-ledger.md）の存在。phase: done では逆に使い捨てドキュメントの処分漏れを
 *       検出する（アーカイブ方針で意図的に残す場合は無視してよい）。
 *       phase: feedback は strip 後（成果物現役）と done 後の再開（処分済み）の
 *       両文脈があるため spec.md の存在だけを要求する
 *
 * map モード — survey 成果物（.dandori/map/*.md）の証拠アンカー死活検査:
 *   dandori-survey verify の手順 1〜2（hash 比較 → 変更ファイル取得 → アンカー走査）を
 *   機械化する。腐った主張の裁定・修正は verify 工程（ユーザー裁定）に残る。
 *   アンカーの解決基準は既定で map ファイルが属する git リポジトリルート。worktree 並列
 *   レーン等でソースルートが .dandori の所在と一致しない場合は --root <ソースルート> で
 *   明示する（アンカー解決と git 照会（V1/V3）がそのルートのリポジトリに対して行われる —
 *   skill 群の workRoot と同じ「明示指定」の方針。cwd からの自動推測はしない）。
 *   検査対象アンカー: 散文の「根拠: `パス`」と、dandori-state-map ブロックの anchor: 値
 *   V1. generated-at — ヘッダ欠落 / hash が git に存在しない（rebase 等で消失）
 *   V2. アンカー先消滅 — ファイル/ディレクトリなし、:行 / :開始-終了（行範囲）が EOF 超え、
 *       :シンボル がファイル内に見つからない（確実に腐っている）
 *   V3. アンカー先変更 — generated-at hash..HEAD の変更ファイルに載っている
 *       （要再検証候補 — 主張がまだ真かはコードを読んで裁定する）
 *   V4. アンカーなし主張 — 根拠のない主張は verify で検査できない（「未確認」明記は除く）
 *   V5. 検証等級なし主張 — [実行検証済] / [読解のみ] マークがない
 *
 * trace モード — gate の初期トレース表生成（B-ID ↔ テストコードの機械突合）:
 *   spec の B-ID をテストファイルから grep し、トレース表の叩き台（Markdown）を出力する。
 *   impl の規約（テスト名に B-ID を含める）が前提。表の「状態」は実行前の初期値 —
 *   ゲート工程がテストを再実行して ✅/❌ に更新する。
 *   T1. 対応テストなし — unit / e2e / formal の B 行に B-ID の grep ヒットがない（⚠️ 候補）
 *   T2. 幽霊 B-ID — テストコード中の B-ID が spec に存在しない
 *   T3. 削除済み参照 — 削除済み B 行の B-ID を参照するテスト
 *   T4. skip されたテスト — B-ID を含むテスト行が .skip / .todo / xit 等で無効化されている
 *       （緑のスイートでも実行されない偽 ✅。同一行の検出のみ — 外側の describe.skip は
 *       行 grep では見えないため、gate のランナーサマリ skipped=0 確認が正）
 *   --revision <n> で差分トレース（継続改善サイクルの gate）: Rev が n 未満（無印 = 初回）の
 *   B 行は前サイクル検証済みの回帰扱い — B-ID の grep ヒットがなくても T1 を出さず、
 *   スイート緑 + skipped/todo 0 での担保を表に明記する。対応の正は前サイクルの gate コミット
 *   --scope <ディレクトリ> で引用の優先スコープを指定できる（複数可）: 引用の収集は無制限、
 *   表示は 5 件 + 残数注記で、スコープ配下の引用を先頭に並べる（他フィーチャー同番 B-ID の
 *   ノイズが本命引用を押し出す実測への対処 — 対象フィーチャーのディレクトリを渡す）
 *   grep 候補は B-数字 開始のトークンに限定する（フィクスチャ文字列の B-ORDER 等を
 *   幽霊と誤検出しない）。括弧はバランスを保って正規化し（B-15(b) を壊さない）、括弧内は
 *   ハイフンを許す（テストコメントの B-1(C-25) 注記形式 — 幽霊と誤検出しない）。
 *   spec にない括弧サフィックス付き ID はパラメタライズ表記として基底 B-ID に帰属させる
 *
 * residue モード — dandori-strip のプロセス言及残存検査:
 *   gate 通過後のストリップで、フィーチャーのファイルからプロセス由来の言及が
 *   除去しきれたかを機械確認する。`dandori-ok:` を含む行は裁定済みの機能的依存として
 *   除外する（その行自身と**直後の 1 行** — コメント行にマーカーを置き、次行のパス参照等を
 *   守る形を許す。2 行以上に及ぶ参照は各行にマーカーが必要）。
 *   RS1. B-ID トークン残存 — テスト名・コメント中の B-数字 トークン
 *   RS2. dandori 言及残存 — dandori の文字列（.dandori/ パス参照を含む）
 *   RS3. プロセス語彙残存 — レビュー指摘 ID（R-n / C-n / F-n）・工程ドキュメント参照
 *        （design.md / spec.md / plan.md / trace.md / sketch.md / review-ledger）・
 *        地雷リスト参照・軸対応・spec §n（get-cart 初回クローズで手動掃除 21 件が
 *        検出網の外だった実績からの拡充）。V1 等の状態変数 ID はハイフンなしの
 *        英数字列で誤検出（V8 エンジン・バージョン表記）が多いため対象外 — 目視で拾う
 *   対象は今回のフィーチャーが触れたファイルに限ること（並行フィーチャーの B-ID は現役）
 *
 * 実行:
 *   node check-docs.ts spec <spec.md>
 *   node check-docs.ts spec <spec.md> --baseline <旧spec.md>
 *     （fix 済み spec を再編集したとき: git show HEAD:<path> > /tmp/base.md で取り出す）
 *   node check-docs.ts plan <spec.md> <plan.md>
 *   node check-docs.ts design <spec.md> <design.md>
 *   node check-docs.ts trace <spec.md> <テストのディレクトリ|ファイル...> [--revision <n>] [--scope <優先ディレクトリ>...]
 *   node check-docs.ts ledger <review-ledger.md> [--mark-zero-round <R|C> <rd>]
 *   node check-docs.ts map <mapファイル.md...> [--root <ソースルート>]
 *     （アンカーはソースルートの git リポジトリルート相対。--root 省略時は map の所在から導出）
 *   node check-docs.ts state <state.yaml>
 *   node check-docs.ts residue <ファイル|ディレクトリ...>
 *
 * 終了コード: 0 = 全検査グリーン / 1 = 指摘あり / 2 = パース・形式エラー
 */

// 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
const { readFileSync, readdirSync, statSync, appendFileSync } = await import('node:fs') as {
  readFileSync(path: string, enc: string): string
  readdirSync(path: string): string[]
  statSync(path: string): { isDirectory(): boolean; size: number }
  appendFileSync(path: string, data: string): void
}
// @ts-ignore -- 同上
const { join, dirname, resolve } = await import('node:path') as {
  join(...p: string[]): string
  dirname(p: string): string
  resolve(...p: string[]): string
}
// @ts-ignore -- 同上
const { execFileSync } = await import('node:child_process') as {
  execFileSync(cmd: string, args: string[], opts: { cwd: string; encoding: string; stdio: unknown[] }): string
}

// ---- 共通 ----------------------------------------------------------------------

let hardErrors = 0
function fail(msg: string): void {
  console.error(`[doc-error] ${msg}`)
  hardErrors++
}

function readLines(path: string, what: string): string[] {
  try {
    return readFileSync(path, 'utf-8').split('\n')
  } catch {
    console.error(`${what}を読めない: ${path}`)
    process.exit(2)
  }
}

/**
 * Markdown テーブル行の内側をセルに分割する。セル内の `\|`（エスケープ済みパイプ —
 * 型のユニオン表記 `'a' \| 'b'` 等）は区切りとして扱わず、`|` に復元して返す
 */
function splitCells(inner: string): string[] {
  return inner.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
}

interface Finding { check: string; detail: string }
const findings: Finding[] = []

function printGroupedFindings(list: Finding[]): void {
  const byCheck = new Map<string, Finding[]>()
  for (const f of list) {
    if (!byCheck.has(f.check)) byCheck.set(f.check, [])
    byCheck.get(f.check)!.push(f)
  }
  for (const [check, group] of [...byCheck.entries()].sort()) {
    console.log(`## ${check}（${group.length} 件）`)
    for (const f of group) console.log(`- ${f.detail}`)
    console.log('')
  }
}

function finishReport(): never {
  if (hardErrors > 0) {
    console.error(`形式エラー ${hardErrors} 件 — 検査結果は不完全`)
    process.exit(2)
  }
  if (findings.length === 0) {
    console.log('指摘なし — 全検査グリーン')
    process.exit(0)
  }
  printGroupedFindings(findings)
  console.log(`計 ${findings.length} 件`)
  process.exit(1)
}

// ---- spec.md パース -------------------------------------------------------------

interface SpecB {
  id: string
  title: string
  line: number
  /** 取り消し線つき（削除済み B 行） */
  struck: boolean
  /** B 行ブロック内に存在するフィールド名（Given/When/Then/Gate/Covers/Rev） */
  fields: Set<string>
  gateRaw: string | null
  /** 改訂サイクル番号（`- Rev: n` — dandori-feedback が改訂で追加した行に付与）。無印 = 初回サイクル */
  rev: number | null
  revRaw: string | null
  /** この B 行が属する ## セクション名 */
  section: string | null
}

interface Section { name: string; line: number }

interface ParsedSpec { sections: Section[]; bs: SpecB[] }

/**
 * `B-1〜B-4` 形式の範囲見出しを個別 ID に展開する（純数値のみ）。非範囲はそのまま。
 * 右辺の B- 接頭辞は省略可（`B-20〜23` — 実データで頻出する省略形を受理する）
 */
function expandRange(idToken: string): string[] {
  const m = idToken.match(/^B-(\d+)〜(?:B-)?(\d+)$/)
  if (!m) return [idToken]
  const from = Number(m[1]), to = Number(m[2])
  if (from >= to) { fail(`範囲 ID の順序が不正: ${idToken}`); return [idToken] }
  return Array.from({ length: to - from + 1 }, (_, i) => `B-${from + i}`)
}

/**
 * plan/design の参照トークンを spec の B-ID 群に解決する。注記括弧つき参照
 * （B-36(計算) / B-43〜B-45(client) や、空白・全角文字でトークンが途切れた
 * B-36( / B-13(EAW）は、範囲を展開した上で基底 ID が spec にあればそちらに
 * 帰属させる（trace の帰属規則と同じ方針）。B-ID 候補でないもの
 * （B-ORDER 等のフィクスチャ文字列）は空配列
 */
/**
 * B-ID 参照の走査パターン。範囲の右辺は B- 接頭辞省略可（B-20〜23）だが、
 * 数値開始に限定する（「B-1〜次節」のような散文の 〜 を範囲と誤認しない）
 */
const B_REF_RE = /B-[\w.()]+(?:〜(?:B-[\w.()]+|\d[\w.()]*))?/g

/**
 * 取り消し線スパン（~~...~~）を除去する。取り消し線内の B-ID は削除の記録であって
 * 参照ではない — 生文字列マッチの前に必ず通す
 */
function stripStruck(text: string): string {
  return text.replace(/~~.*?~~/g, '')
}

function resolveBIdRefs(raw: string, specIds: Set<string>): string[] {
  const norm = normalizeBIdToken(raw)
  if (norm === null) return []
  // 純数値範囲の直後の注記括弧は範囲判定の前に落とす（B-43〜B-45(client)）
  const tok = norm.replace(/^(B-\d+〜(?:B-)?\d+)\(.*$/, '$1')
  return expandRange(tok).map(part => {
    if (specIds.has(part)) return part
    const base = part.split('(')[0]
    return specIds.has(base) ? base : part
  })
}

function parseSpec(lines: string[], path: string): ParsedSpec {
  const sections: Section[] = []
  const bs: SpecB[] = []
  let curSection: string | null = null
  let curB: SpecB | null = null
  let inFence = false
  lines.forEach((line, idx) => {
    if (/^```/.test(line.trim())) { inFence = !inFence; return }
    if (inFence) return
    const sec = line.match(/^##\s+(.+?)\s*$/)
    if (sec) {
      curSection = sec[1].trim()
      sections.push({ name: curSection, line: idx + 1 })
      curB = null
      return
    }
    const heading = line.match(/^#{3,6}\s+(~~\s*)?(B-[\w.()]+(?:〜(?:B-[\w.()]+|\d[\w.()]*))?)\s*[:：]\s*(.*)$/)
    if (heading) {
      const title = heading[3].trim()
      curB = {
        id: heading[2],
        title: title.replace(/~~/g, '').trim(),
        line: idx + 1,
        struck: heading[1] !== undefined || title.includes('~~'),
        fields: new Set(),
        gateRaw: null,
        rev: null,
        revRaw: null,
        section: curSection,
      }
      bs.push(curB)
      return
    }
    if (/^#{1,6}\s/.test(line)) {
      curB = null
      if (/^#{3,6}\s+(~~\s*)?B-/.test(line)) fail(`${path} L${idx + 1}: B 行見出しとして解釈できない: ${line.trim()}`)
      return
    }
    if (curB) {
      const m = line.match(/^\s*-\s*(Given|When|Then|Gate|Covers|Rev)\s*[:：]\s*(.*)$/)
      if (m) {
        curB.fields.add(m[1])
        if (m[1] === 'Gate') curB.gateRaw = m[2].trim()
        if (m[1] === 'Rev') {
          curB.revRaw = m[2].trim()
          curB.rev = /^[1-9]\d*$/.test(curB.revRaw) ? Number(curB.revRaw) : null
        }
      }
    }
  })
  if (inFence) fail(`${path}: fenced block が閉じていない`)
  return { sections, bs }
}

// Gate タグ式のパース: 末尾の注記（…）を切り離し、タグ列と乖離マーク（<現状>→<希望>）を分解する。
// current は現状の固定方法（乖離マークは左辺）— gate のトレースはこちらで扱う
const GATE_VOCAB = new Set(['unit', 'e2e', 'visual', 'manual', 'formal'])
function parseGateExpr(raw: string): { tokens: string[]; current: string[]; note: string | null } {
  const cut = raw.search(/[（(]/)
  const expr = (cut >= 0 ? raw.slice(0, cut) : raw).trim()
  const note = cut >= 0 ? raw.slice(cut).trim() : null
  const tokens = expr.split(/[,、/\s]+/).filter(t => t !== '')
  const current = tokens.map(t => t.split(/→|->/)[0]).filter(t => t !== '')
  return { tokens, current, note }
}

// ---- 引数 ------------------------------------------------------------------------

const argvRest = process.argv.slice(2)
const mode = argvRest[0]
const USAGE =
  'usage: node check-docs.ts spec <spec.md> [--baseline <旧spec.md>]\n' +
  '       node check-docs.ts plan <spec.md> <plan.md>\n' +
  '       node check-docs.ts design <spec.md> <design.md>\n' +
  '       node check-docs.ts trace <spec.md> <テストのディレクトリ|ファイル...> [--revision <n>] [--scope <優先ディレクトリ>...]\n' +
  '       node check-docs.ts ledger <review-ledger.md> [--mark-zero-round <R|C> <rd>]\n' +
  '       node check-docs.ts map <mapファイル.md...> [--root <ソースルート>]\n' +
  '       node check-docs.ts state <state.yaml>\n' +
  '       node check-docs.ts residue <ファイル|ディレクトリ...>'

const MODES = ['spec', 'plan', 'design', 'trace', 'ledger', 'map', 'state', 'residue']
if (!MODES.includes(mode)) {
  console.error(USAGE)
  process.exit(2)
}

// ---- spec モード ------------------------------------------------------------------

if (mode === 'spec') {
  let baselinePath: string | null = null
  const paths: string[] = []
  for (let i = 1; i < argvRest.length; i++) {
    const a = argvRest[i]
    if (a === '--baseline') { baselinePath = argvRest[++i] ?? null; continue }
    if (a.startsWith('--')) { console.error(`未知のオプション: ${a}\n${USAGE}`); process.exit(2) }
    paths.push(a)
  }
  if (paths.length !== 1) { console.error(USAGE); process.exit(2) }
  const specPath = paths[0]
  const spec = parseSpec(readLines(specPath, 'spec'), specPath)

  // S1: 必須セクション欠落
  const REQUIRED = ['ゴール', 'スコープ外', '振る舞い仕様', '未解決事項']
  const sectionNames = spec.sections.map(s => s.name)
  for (const name of REQUIRED) {
    if (!sectionNames.includes(name)) {
      findings.push({ check: 'S1:必須セクション欠落', detail: `## ${name} がない（空でも見出しは置く — 正準定義）` })
    }
  }

  // S2: セクション重複
  {
    const seen = new Map<string, number>()
    for (const s of spec.sections) {
      if (seen.has(s.name)) {
        findings.push({
          check: 'S2:セクション重複',
          detail: `## ${s.name} が複数ある（L${seen.get(s.name)} と L${s.line}）— 逐次追記は既存セクションの中身を更新する`,
        })
      } else {
        seen.set(s.name, s.line)
      }
    }
  }

  // S3 / S4: B 行フィールドと Gate タグ語彙（削除済み行は対象外）
  const gateDesires: { id: string; line: number; token: string; note: string }[] = []
  for (const b of spec.bs.filter(b => !b.struck)) {
    for (const field of ['Given', 'When', 'Then', 'Gate']) {
      if (!b.fields.has(field)) {
        findings.push({ check: 'S3:B行フィールド欠落', detail: `${b.id} (L${b.line}) に ${field} がない` })
      }
    }
    if (b.revRaw !== null && b.rev === null) {
      findings.push({
        check: 'S8:Rev形式',
        detail: `${b.id} (L${b.line}) の Rev「${b.revRaw}」が正の整数でない — 改訂サイクル番号（dandori-feedback が改訂で追加した行に付与する）`,
      })
    }
    if (b.gateRaw !== null) {
      const { tokens, note } = parseGateExpr(b.gateRaw)
      if (tokens.length === 0) {
        findings.push({ check: 'S4:Gateタグ語彙', detail: `${b.id} (L${b.line}) の Gate が空` })
      }
      for (const t of tokens) {
        const parts = t.split(/→|->/)
        if (parts.length > 2 || parts.some(p => p === '')) {
          findings.push({
            check: 'S4:Gateタグ語彙',
            detail: `${b.id} (L${b.line}) の Gate タグ「${t}」の形式が不正 — <タグ> または <現状>→<希望>`,
          })
          continue
        }
        for (const p of parts) {
          if (!GATE_VOCAB.has(p)) {
            findings.push({
              check: 'S4:Gateタグ語彙',
              detail: `${b.id} (L${b.line}) の Gate タグ「${p}」は語彙外 — unit / e2e / visual / manual / formal のいずれか`,
            })
          }
        }
        if (parts.length === 2 && parts[0] === parts[1]) {
          findings.push({
            check: 'S4:Gateタグ語彙',
            detail: `${b.id} (L${b.line}) の乖離マーク「${t}」の両辺が同一 — 乖離がないなら素のタグにする`,
          })
        }
        if (parts.length === 2 && note === null) {
          findings.push({
            check: 'S4:Gateタグ語彙',
            detail: `${b.id} (L${b.line}) の乖離マーク「${t}」に注記がない — 何が ${parts[1]} での固定を阻むかを（）で書く`,
          })
        }
        if (parts.length === 2) {
          gateDesires.push({ id: b.id, line: b.line, token: t, note: note ?? '（注記なし）' })
        }
      }
    }
  }

  // S5: B-ID 重複（範囲見出しは展開して衝突も見る）
  {
    const seen = new Map<string, number>()
    for (const b of spec.bs) {
      for (const id of expandRange(b.id)) {
        if (seen.has(id)) {
          findings.push({ check: 'S5:B-ID重複', detail: `${id} が重複（L${seen.get(id)} と L${b.line}）` })
        } else {
          seen.set(id, b.line)
        }
      }
    }
  }

  // S6: B 行の位置
  for (const b of spec.bs) {
    if (b.section !== '振る舞い仕様') {
      findings.push({
        check: 'S6:B行の位置',
        detail: `${b.id} (L${b.line}) が「## 振る舞い仕様」の外（${b.section ? `## ${b.section}` : 'セクション外'}）にある`,
      })
    }
  }

  // S7: 欠番（純数値 ID のみ。削除済み行も見出しが残る規約なので存在としてカウント）
  {
    const nums = spec.bs
      .flatMap(b => expandRange(b.id))
      .map(id => id.match(/^B-(\d+)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map(m => Number(m[1]))
    if (nums.length > 0) {
      const present = new Set(nums)
      for (let n = Math.min(...nums); n <= Math.max(...nums); n++) {
        if (!present.has(n)) {
          findings.push({
            check: 'S7:欠番',
            detail: `B-${n} がない — 削除なら見出しを取り消し線 + 理由で残す（無断削除の疑い）`,
          })
        }
      }
    }
  }

  // S8: 改番検知（--baseline 指定時のみ）
  if (baselinePath !== null) {
    const base = parseSpec(readLines(baselinePath, 'baseline spec'), baselinePath)
    const curById = new Map(spec.bs.map(b => [b.id, b]))
    const baseIds = new Set(base.bs.map(b => b.id))

    for (const bb of base.bs) {
      const cur = curById.get(bb.id)
      if (!cur) {
        if (!bb.struck) {
          findings.push({
            check: 'S8:改番検知',
            detail: `${bb.id}（旧: ${bb.title}）が消えている — 削除は取り消し線 + 理由で見出しを残す`,
          })
        }
        continue
      }
      if (!bb.struck && !cur.struck && bb.title !== cur.title) {
        findings.push({
          check: 'S8:改番検知',
          detail: `${bb.id} のタイトルが変わっている（旧「${bb.title}」→ 新「${cur.title}」）— ` +
            `内容のすり替えなら改番禁止違反。表現の修正だけならユーザー承認の記録を残す`,
        })
      }
    }
    // 追加は末尾: 新規 ID が既存（baseline 由来）ID より前に現れたら挿入違反
    const lastBasePos = Math.max(-1, ...spec.bs.map((b, i) => baseIds.has(b.id) ? i : -1))
    spec.bs.forEach((b, i) => {
      if (!baseIds.has(b.id) && i < lastBasePos) {
        findings.push({
          check: 'S8:改番検知',
          detail: `${b.id} (L${b.line}) が既存 B 行より前に挿入されている — 追加は末尾（改番禁止の規約）`,
        })
      }
    })
  }

  console.log(`# spec フォーマット検査レポート — ${specPath}`)
  console.log(`セクション ${spec.sections.length} / B 行 ${spec.bs.length}` +
    `（削除済み ${spec.bs.filter(b => b.struck).length}）` +
    (baselinePath !== null ? ` / baseline: ${baselinePath}` : ''))
  console.log('')
  if (gateDesires.length > 0) {
    // 指摘とは別枠（exit code に影響しない）— ground の seam 検討の議題リスト
    console.log(`## 固定単位の乖離（${gateDesires.length} 件 — 指摘ではない。ground の seam 議題）`)
    for (const d of gateDesires) {
      console.log(`- ${d.id} (L${d.line}) ${d.token} ${d.note}`)
    }
    console.log('')
  }
  finishReport()
}

// ---- plan モード ------------------------------------------------------------------

if (mode === 'plan') {
  const paths = argvRest.slice(1)
  if (paths.length !== 2 || paths.some(p => p.startsWith('--'))) { console.error(USAGE); process.exit(2) }
  const [specPath, planPath] = paths
  const spec = parseSpec(readLines(specPath, 'spec'), specPath)
  const planLines = readLines(planPath, 'plan')

  const specIds = new Set(spec.bs.flatMap(b => expandRange(b.id)))
  const struckIds = new Set(spec.bs.filter(b => b.struck).flatMap(b => expandRange(b.id)))

  // マイルストーンごとの B 行参照を収集する。参照源は正準形式の2箇所:
  //   - マイルストーン一覧テーブルの行（先頭セルが M-ID）
  //   - `## M<n>:` セクション内の `- 対応:` 行
  interface Milestone { id: string; line: number; refs: Map<string, number> }
  const milestones = new Map<string, Milestone>()
  function milestone(id: string, line: number): Milestone {
    if (!milestones.has(id)) milestones.set(id, { id, line, refs: new Map() })
    return milestones.get(id)!
  }
  function collectRefs(m: Milestone, text: string, line: number): void {
    for (const tok of stripStruck(text).match(B_REF_RE) ?? []) {
      for (const id of resolveBIdRefs(tok, specIds)) {
        if (!m.refs.has(id)) m.refs.set(id, line)
      }
    }
  }

  let curM: Milestone | null = null
  let inTaioCont = false // 「- 対応:」行の直後 — インデントされた継続行（折り返し・ネスト）も参照源にする
  let inFence = false
  planLines.forEach((line, idx) => {
    if (/^```/.test(line.trim())) { inFence = !inFence; return }
    if (inFence) return
    const sec = line.match(/^##\s+(M[\w.]+)\s*[:：]/)
    if (sec) { curM = milestone(sec[1], idx + 1); inTaioCont = false; return }
    if (/^#{1,6}\s/.test(line)) { curM = null; inTaioCont = false; return }
    const cells = line.trim().match(/^\|(.+)\|$/)
    if (cells) {
      inTaioCont = false
      const parts = splitCells(cells[1])
      if (/^M[\w.]+$/.test(parts[0])) {
        collectRefs(milestone(parts[0], idx + 1), parts.slice(1).join(' '), idx + 1)
      }
      return
    }
    if (curM && /^\s*-\s*対応\s*[:：]/.test(line)) { collectRefs(curM, line, idx + 1); inTaioCont = true; return }
    if (inTaioCont && curM && /^\s+\S/.test(line)) { collectRefs(curM, line, idx + 1); return }
    inTaioCont = false
  })
  if (inFence) fail(`${planPath}: fenced block が閉じていない`)

  if (milestones.size === 0) {
    console.error(`${planPath}: マイルストーンを抽出できない — 正準形式（一覧テーブルの M-ID 行、` +
      `## M<n>: セクションの「- 対応:」行）か確認`)
    process.exit(2)
  }

  const coveredBy = new Map<string, string[]>()
  for (const m of milestones.values()) {
    for (const id of m.refs.keys()) {
      if (!coveredBy.has(id)) coveredBy.set(id, [])
      coveredBy.get(id)!.push(m.id)
    }
  }

  // P1: 未カバー B 行
  for (const b of spec.bs.filter(b => !b.struck)) {
    for (const id of expandRange(b.id)) {
      if (!coveredBy.has(id)) {
        findings.push({
          check: 'P1:未カバーB行',
          detail: `${id}（${b.title}）がどのマイルストーンにも割り当てられていない — 実装されない仕様`,
        })
      }
    }
  }

  // P2 / P3: 幽霊参照・削除済み参照
  for (const m of milestones.values()) {
    for (const [id, line] of m.refs) {
      if (!specIds.has(id)) {
        findings.push({
          check: 'P2:幽霊参照',
          detail: `${m.id} (L${line}) が参照する ${id} が spec にない — typo か spec の陳腐化`,
        })
      } else if (struckIds.has(id)) {
        findings.push({
          check: 'P3:削除済み参照',
          detail: `${m.id} (L${line}) が削除済み（取り消し線）の ${id} を参照している`,
        })
      }
    }
  }

  // P4: 空マイルストーン
  for (const m of milestones.values()) {
    if (m.refs.size === 0) {
      findings.push({
        check: 'P4:空マイルストーン',
        detail: `${m.id} (L${m.line}) に対応 B 行がない — スコープ外の作業（対応する B 行がないマイルストーンは存在してはならない）`,
      })
    }
  }

  const liveCount = spec.bs.filter(b => !b.struck).flatMap(b => expandRange(b.id)).length
  const coveredCount = spec.bs.filter(b => !b.struck).flatMap(b => expandRange(b.id))
    .filter(id => coveredBy.has(id)).length
  console.log(`# plan カバレッジ検査レポート — ${specPath} ↔ ${planPath}`)
  console.log(`B 行 ${liveCount}（削除済み除く） / カバー済み ${coveredCount} / マイルストーン ${milestones.size}` +
    `（${[...milestones.keys()].join(', ')}）`)
  console.log('')
  finishReport()
}

// ---- design モード ----------------------------------------------------------------

if (mode === 'design') {
  const paths = argvRest.slice(1)
  if (paths.length !== 2 || paths.some(p => p.startsWith('--'))) { console.error(USAGE); process.exit(2) }
  const [specPath, designPath] = paths
  const specLines = readLines(specPath, 'spec')
  const spec = parseSpec(specLines, specPath)
  const designLines = readLines(designPath, 'design')

  const specIds = new Set(spec.bs.flatMap(b => expandRange(b.id)))
  const struckIds = new Set(spec.bs.filter(b => b.struck).flatMap(b => expandRange(b.id)))

  // design.md のセクション走査。見出しの（）補足（例: 土台（利用する既存実装））は無視して
  // 前方一致で正準セクション名に正規化する
  function normalizeSection(name: string): string {
    return name.split(/[（(]/)[0].trim()
  }
  interface DesignEntry { text: string; line: number; groupMarked: boolean }
  const sections = new Map<string, DesignEntry[]>()
  const sectionLines = new Map<string, number>()
  const MARK_RE = /\[(実行検証済|読解のみ)([:：]?)\s*([^\]]*)\]/
  let curSec: string | null = null
  // ### サブ見出しに検証マークを付けて配下のエントリ群にまとめて適用するイディオム
  // （例: ### DB leaf（[実行検証済: `npx vp test run src/db/` 472 PASS]））
  let curGroupMarked = false
  let lastEntry: DesignEntry | null = null
  let inFence = false
  designLines.forEach((line, idx) => {
    if (/^```/.test(line.trim())) { inFence = !inFence; return }
    if (inFence) return
    const sec = line.match(/^##\s+(.+?)\s*$/)
    if (sec) {
      curSec = normalizeSection(sec[1])
      curGroupMarked = false
      lastEntry = null
      if (sections.has(curSec)) {
        findings.push({
          check: 'D1:必須セクション',
          detail: `## ${curSec} が複数ある（L${sectionLines.get(curSec)} と L${idx + 1}）`,
        })
      } else {
        sections.set(curSec, [])
        sectionLines.set(curSec, idx + 1)
      }
      return
    }
    const sub = line.match(/^###+\s+(.+?)\s*$/)
    if (sub) {
      lastEntry = null
      const gm = sub[1].match(MARK_RE)
      curGroupMarked = gm !== null
      if (gm && gm[1] === '実行検証済' && (gm[3].trim() === '' || !gm[3].includes('`'))) {
        findings.push({
          check: 'D2:検証マーク',
          detail: `グループ見出し (L${idx + 1}) の [実行検証済] に再実行可能な証拠がない — ` +
            `実行コマンドをバッククォートで併記する`,
        })
      }
      return
    }
    // エントリはトップレベルの箇条書き（`- ` / `1. ` 番号付きも可）。
    // インデントされた継続行（ネスト含む）は本体に連結する
    if (curSec && /^(?:- |\d+\. )/.test(line)) {
      lastEntry = { text: line, line: idx + 1, groupMarked: curGroupMarked }
      sections.get(curSec)!.push(lastEntry)
      return
    }
    if (lastEntry && /^\s+\S/.test(line)) lastEntry.text += ' ' + line.trim()
  })
  if (inFence) fail(`${designPath}: fenced block が閉じていない`)

  // D1: 必須セクション欠落
  const REQUIRED = ['土台', '改変箇所', '新規実装', '不変条件', 'リスクランキング', '発見ログ']
  for (const name of REQUIRED) {
    if (!sections.has(name)) {
      findings.push({ check: 'D1:必須セクション', detail: `## ${name} がない（正準定義 — 空でも見出しは置く）` })
    }
  }

  // D2: 土台エントリの検証マーク（グループ見出しのマークを継承しているエントリは免除）
  for (const e of sections.get('土台') ?? []) {
    const mark = e.text.match(MARK_RE)
    if (!mark) {
      if (!e.groupMarked) {
        findings.push({
          check: 'D2:検証マーク',
          detail: `土台エントリ (L${e.line}) に [実行検証済] / [読解のみ] マークがない: ${e.text.slice(0, 60)}`,
        })
      }
      continue
    }
    if (mark[1] === '実行検証済') {
      const payload = mark[3].trim()
      if (payload === '' || !payload.includes('`')) {
        findings.push({
          check: 'D2:検証マーク',
          detail: `土台エントリ (L${e.line}) の [実行検証済] に再実行可能な証拠がない — ` +
            `実行コマンドをバッククォートで併記する（例: [実行検証済: \`npm test -- xx\` 12 passed — 観測要点]）`,
        })
      }
    }
  }

  // D3 / D4: B 行参照の突合（土台・改変箇所・新規実装が参照源）
  const refSections = ['土台', '改変箇所', '新規実装']
  const referenced = new Set<string>()
  for (const secName of refSections) {
    for (const e of sections.get(secName) ?? []) {
      for (const tok of stripStruck(e.text).match(B_REF_RE) ?? []) {
        for (const id of resolveBIdRefs(tok, specIds)) {
          referenced.add(id)
          if (!specIds.has(id)) {
            findings.push({
              check: 'D3:B行参照整合',
              detail: `${secName} (L${e.line}) が参照する ${id} が spec にない — typo か spec の陳腐化`,
            })
          } else if (struckIds.has(id)) {
            findings.push({
              check: 'D3:B行参照整合',
              detail: `${secName} (L${e.line}) が削除済み（取り消し線）の ${id} を参照している`,
            })
          }
        }
      }
    }
  }
  for (const b of spec.bs.filter(b => !b.struck)) {
    for (const id of expandRange(b.id)) {
      if (!referenced.has(id)) {
        findings.push({
          check: 'D4:未対応B行',
          detail: `${id}（${b.title}）が土台/改変箇所/新規実装のどこにも対応していない — spec か調査のどちらかに穴`,
        })
      }
    }
  }

  // D5: 軸対応 — spec に状態モデルがあるとき、全軸がコード構造に対応付いているか
  const axisKeys: string[] = []
  {
    let inModel = false
    let inAxes = false
    for (const line of specLines) {
      if (!inModel) {
        if (/^```dandori-state-model\s*$/.test(line.trim())) inModel = true
        continue
      }
      if (/^```\s*$/.test(line.trim())) break
      if (/^axes:\s*$/.test(line)) { inAxes = true; continue }
      if (/^\S/.test(line)) { inAxes = false; continue } // 次のトップレベルキー
      if (inAxes) {
        const m = line.match(/^  ([A-Za-z_]\w*):\s*(\{.*\})?\s*$/)
        if (m) axisKeys.push(m[1])
      }
    }
  }
  const axisEntries = sections.get('軸対応')
  if (axisKeys.length > 0) {
    if (!axisEntries) {
      findings.push({
        check: 'D5:軸対応',
        detail: 'spec に状態モデルがあるのに ## 軸対応 がない（正準定義 — 全軸をコード構造に接地する）',
      })
    } else {
      const covered = new Map<string, number>() // 軸キー → エントリ行
      for (const e of axisEntries) {
        const head = e.text.match(/^- ([^:：[]+)[:：]/)
        if (!head) {
          findings.push({
            check: 'D5:軸対応',
            detail: `軸対応エントリ (L${e.line}) が「- <軸キー>: ...」形式でない: ${e.text.slice(0, 60)}`,
          })
          continue
        }
        const keys = head[1].split(/[,、]/).map(s => s.trim()).filter(Boolean)
        for (const k of keys) {
          if (!axisKeys.includes(k)) {
            findings.push({
              check: 'D5:軸対応',
              detail: `軸対応 (L${e.line}) の軸キー「${k}」が状態モデルにない — typo かモデルの陳腐化`,
            })
          } else if (covered.has(k)) {
            findings.push({
              check: 'D5:軸対応',
              detail: `軸「${k}」の対応が複数エントリにある（L${covered.get(k)} と L${e.line}）— 1 軸 1 エントリ`,
            })
          } else {
            covered.set(k, e.line)
          }
        }
        const verdict = e.text.match(/\[1箇所\]|\[散在[:：]([^\]]*)\]|\[散在\]|⚠/)
        if (!verdict) {
          findings.push({
            check: 'D5:軸対応',
            detail: `軸対応 (L${e.line}) に判定（[1箇所] / [散在: 理由] / ⚠）がない`,
          })
        } else if (verdict[0].startsWith('[散在') && !(verdict[1] ?? '').trim()) {
          findings.push({
            check: 'D5:軸対応',
            detail: `軸対応 (L${e.line}) の [散在] に理由がない — dependent 宣言等の相互作用根拠を書く（書けないなら ⚠ + 行き先）`,
          })
        }
      }
      for (const k of axisKeys) {
        if (!covered.has(k)) {
          findings.push({
            check: 'D5:軸対応',
            detail: `軸「${k}」が軸対応節にない — 全軸の対応をコード構造に接地する（散在なら理由つきで）`,
          })
        }
      }
    }
  }

  console.log(`# design 検査レポート — ${specPath} ↔ ${designPath}`)
  console.log(`セクション ${sections.size} / 土台エントリ ${(sections.get('土台') ?? []).length}` +
    ` / B 行参照 ${referenced.size}` +
    (axisKeys.length > 0 ? ` / 状態モデル軸 ${axisKeys.length}（軸対応エントリ ${(axisEntries ?? []).length}）` : ''))
  console.log('')
  finishReport()
}

// ---- ledger モード ----------------------------------------------------------------

if (mode === 'ledger') {
  let markPrefix: string | null = null
  let markRd: number | null = null
  const paths: string[] = []
  for (let i = 1; i < argvRest.length; i++) {
    const a = argvRest[i]
    if (a === '--mark-zero-round') {
      const p = argvRest[++i]
      const v = argvRest[++i]
      if ((p !== 'R' && p !== 'C') || v === undefined || !/^[1-9]\d*$/.test(v)) {
        console.error(`--mark-zero-round には接頭辞（R | C）とラウンド番号（正の整数）を渡す\n${USAGE}`)
        process.exit(2)
      }
      markPrefix = p
      markRd = Number(v)
      continue
    }
    if (a.startsWith('--')) { console.error(`未知のオプション: ${a}\n${USAGE}`); process.exit(2) }
    paths.push(a)
  }
  if (paths.length !== 1) { console.error(USAGE); process.exit(2) }
  const ledgerPath = paths[0]

  // 「指摘なし」マーカーの決定的追記 — マーカー文言はここで固定され、追記に
  // サブエージェントの自由編集を挟まない（エージェントによるマーカー追記が
  // 監査改竄と誤検知されブロックされた実戦観測 2026-07-21 への恒久対策）。
  // 冪等 — 同一マーカーが既にあれば何もしない。追記後は通常の検査・収束判定に続く
  if (markPrefix !== null && markRd !== null) {
    const marker = `<!-- round: ${markPrefix} Rd=${markRd} 指摘なし -->`
    const text = readLines(ledgerPath, '台帳').join('\n')
    const already = new RegExp(`<!--\\s*round:\\s*${markPrefix}\\s+Rd=${markRd}\\s+指摘なし\\s*-->`).test(text)
    if (already) {
      console.log(`マーカー既存 — 追記なし: ${marker}`)
    } else {
      appendFileSync(ledgerPath, `${text.endsWith('\n') ? '' : '\n'}${marker}\n`)
      console.log(`マーカー追記: ${marker}`)
    }
    console.log('')
  }

  const lines = readLines(ledgerPath, '台帳')

  interface LedgerRow {
    id: string
    prefix: string
    num: number
    rd: number
    severity: string
    topic: string
    action: string // 処置セルの生値（空 = 未処置）
    reason: string
    line: number
  }
  const rows: LedgerRow[] = []
  // 「指摘なし」ラウンドのマーカー（<!-- round: C Rd=7 指摘なし -->）— 行が残らない
  // ラウンドを収束判定に見せるための記録
  const zeroRounds = new Map<string, Set<number>>()
  let inFence = false
  lines.forEach((line, idx) => {
    if (/^```/.test(line.trim())) { inFence = !inFence; return }
    if (inFence) return
    const zm = line.match(/<!--\s*round:\s*([RC])\s+Rd=(\d+)\s+指摘なし\s*-->/)
    if (zm) {
      if (!zeroRounds.has(zm[1])) zeroRounds.set(zm[1], new Set())
      zeroRounds.get(zm[1])!.add(Number(zm[2]))
      return
    }
    const m = line.trim().match(/^\|(.+)\|$/)
    if (!m) return
    const cells = splitCells(m[1])
    if (cells.every(c => /^:?-+:?$/.test(c))) return // セパレータ行
    if (cells[0] === 'ID') return // ヘッダ行
    const idm = cells[0].match(/^([RCF])-(\d+)$/)
    if (!idm) {
      findings.push({ check: 'L1:行形式', detail: `L${idx + 1}: ID「${cells[0]}」が R-n / C-n / F-n 形式でない` })
      return
    }
    if (cells.length !== 6) {
      findings.push({ check: 'L1:行形式', detail: `L${idx + 1}: ${cells[0]} の列数が ${cells.length}（正準は 6: ID/Rd/深刻度/論点/処置/根拠・理由）— セル内に \`|\` を書くときは \`\\|\` でエスケープする` })
      return
    }
    const rd = Number(cells[1])
    if (!Number.isInteger(rd) || rd < 1) {
      findings.push({ check: 'L1:行形式', detail: `L${idx + 1}: ${cells[0]} の Rd「${cells[1]}」が正の整数でない` })
      return
    }
    rows.push({
      id: cells[0], prefix: idm[1], num: Number(idm[2]), rd,
      severity: cells[2], topic: cells[3], action: cells[4], reason: cells[5], line: idx + 1,
    })
  })
  if (inFence) fail(`${ledgerPath}: fenced block が閉じていない`)
  if (rows.length === 0 && zeroRounds.size === 0) {
    console.error(`${ledgerPath}: 台帳の行を抽出できない — 正準形式（| ID | Rd | 深刻度 | 論点 | 処置 | 根拠・理由 |）か確認`)
    process.exit(2)
  }

  const rowById = new Map(rows.map(r => [r.id, r]))

  // L1（続き）: 深刻度・処置の語彙
  const SEVERITY = new Set(['blocker', 'major', 'minor'])
  const ACTIONS = new Set(['反映済', '却下', '保留', '反証破棄'])
  for (const r of rows) {
    if (!SEVERITY.has(r.severity)) {
      findings.push({ check: 'L1:行形式', detail: `${r.id} (L${r.line}): 深刻度「${r.severity}」は語彙外 — blocker / major / minor` })
    }
    if (r.action !== '' && !ACTIONS.has(r.action) && !/^再燃→/.test(r.action)) {
      findings.push({ check: 'L1:行形式', detail: `${r.id} (L${r.line}): 処置「${r.action}」は語彙外 — 反映済 / 却下 / 保留 / 反証破棄 / 再燃→<ID>` })
    }
  }

  // L2: 処置の完全性
  const EMPTY_REASON = /^[—－\-]?$/
  for (const r of rows) {
    if (r.action === '') {
      findings.push({ check: 'L2:処置の完全性', detail: `${r.id} (L${r.line}) が未処置 — 処置列を埋めてからラウンドを閉じる` })
      continue
    }
    if ((r.action === '却下' || r.action === '反証破棄') && EMPTY_REASON.test(r.reason)) {
      findings.push({ check: 'L2:処置の完全性', detail: `${r.id} (L${r.line}) の ${r.action} に理由がない（${r.action === '却下' ? '却下は理由必須' : '反証破棄は反証根拠必須'}）` })
    }
    if (r.action === '保留' && r.severity !== 'minor') {
      findings.push({ check: 'L2:処置の完全性', detail: `${r.id} (L${r.line}): ${r.severity} に保留は使えない — 保留は minor の採否待ちのみ` })
    }
  }

  // L3: 再燃参照
  for (const r of rows) {
    const rem = r.action.match(/^再燃→\s*(\S+)$/)
    if (rem && !rowById.has(rem[1])) {
      findings.push({ check: 'L3:再燃参照', detail: `${r.id} (L${r.line}) の 再燃→${rem[1]} の参照先が台帳にない` })
    }
  }

  // L4: ID 重複・欠番（接頭辞ごと）
  for (const prefix of ['R', 'C', 'F']) {
    const nums = rows.filter(r => r.prefix === prefix).map(r => r.num)
    if (nums.length === 0) continue
    const seen = new Set<number>()
    for (const r of rows.filter(r => r.prefix === prefix)) {
      if (seen.has(r.num)) findings.push({ check: 'L4:ID重複・欠番', detail: `${r.id} (L${r.line}) が重複` })
      seen.add(r.num)
    }
    for (let n = Math.min(...nums); n <= Math.max(...nums); n++) {
      if (!seen.has(n)) findings.push({ check: 'L4:ID重複・欠番', detail: `${prefix}-${n} がない — 台帳は追記のみ（行の削除の疑い）` })
    }
  }

  // 収束判定（接頭辞ごと — R と C はラウンド系列が別）
  console.log(`# 台帳収束判定 — ${ledgerPath}`)
  const zrTotal = [...zeroRounds.values()].reduce((n, s) => n + s.size, 0)
  console.log(`行 ${rows.length}（R: ${rows.filter(r => r.prefix === 'R').length} / C: ${rows.filter(r => r.prefix === 'C').length} / F: ${rows.filter(r => r.prefix === 'F').length}）` +
    (zrTotal > 0 ? ` / 指摘なしマーカー ${zrTotal}` : ''))
  console.log('')
  for (const [prefix, label] of [['R', 'dandori-review'], ['C', 'dandori-codereview']] as const) {
    const prows = rows.filter(r => r.prefix === prefix)
    const zr = zeroRounds.get(prefix) ?? new Set<number>()
    if (prows.length === 0 && zr.size === 0) continue

    // 生存数 = blocker/major のうち処置で無効化されていないもの。
    // 反証破棄（誤検出と確定）は R/C 共通で除外する（2026-07-09: review にも
    // finder/verifier 分離を導入 — 反証フェーズは両工程の標準装備）。再燃行は生存として数える
    const survives = (r: LedgerRow): boolean =>
      (r.severity === 'blocker' || r.severity === 'major') && r.action !== '反証破棄'
    // 「指摘なし」マーカーのラウンドも系列に含める（行がなければ生存数 0 として観測される）
    const rounds = [...new Set([...prows.map(r => r.rd), ...zr])].sort((a, b) => a - b)
    const counts = rounds.map(rd => prows.filter(r => r.rd === rd && survives(r)).length)

    // L5: マーカーと生存行の矛盾（マーカーは「このラウンドは blocker/major ゼロ」の主張）
    for (const rd of [...zr].sort((a, b) => a - b)) {
      const alive = prows.filter(r => r.rd === rd && survives(r))
      if (alive.length > 0) {
        findings.push({
          check: 'L5:ラウンド記録矛盾',
          detail: `${prefix} Rd${rd} に「指摘なし」マーカーがあるが blocker/major の生存行がある（${alive.map(r => r.id).join(', ')}）`,
        })
      }
    }

    // escalate 条件 1: 再燃（終端の再生産が反証破棄なら「反証済みの再生産」— 対象外）。
    // 参照は連鎖し得る（Rd2 却下 → 再燃→C-a → C-a も 再燃→C-b → C-b 反証破棄）ため
    // 終端まで辿る — 直接参照先だけ見ると、裁定済み論点の再生産が反証フェーズで
    // 正しく破棄され続けていても古いマーカーが escalate を返し続ける（2026-07-21 実戦観測）
    const terminalAction = (r: LedgerRow): string => {
      const seen = new Set<string>()
      let cur: LedgerRow | undefined = r
      while (cur) {
        const m = cur.action.match(/^再燃→\s*(\S+)$/)
        if (!m) return cur.action
        if (seen.has(cur.id)) return cur.action // 循環参照 — 安全側で生存扱い
        seen.add(cur.id)
        cur = rowById.get(m[1]) // 参照先欠落は L3 が報告する — ここでは生存扱いになる
      }
      return ''
    }
    const rekindled = prows.filter(r => /^再燃→/.test(r.action) && terminalAction(r) !== '反証破棄')
    // escalate 条件 2: 直近 3 ラウンドで blocker+major が減っておらず、かつ最新ラウンドに
    // 未解消の再燃が含まれる（2026-07-10 改定: 件数の非減少だけでは「毎ラウンド異なる新規の
    // 事実発見が続く健全な収束過程」と「解釈の振動」を区別できない — modelh-cart-core Rd1〜3 の
    // 実戦観測。振動の実体は再燃検出が担う。未解消再燃は条件 1 が単体で escalate するため
    // 本条件は現状その部分集合だが、条件 1 を将来緩めた場合の保険として明示的に残す。
    // 履歴上の過去の停滞窓は数えない — 回復したなら現在の停滞ではない）
    const n = counts.length
    const latestRd = rounds[n - 1]

    // L6: 保留の滞留 — 理由セルが空の保留（採否待ち）が 2 ラウンド以上放置されている。
    // 放置された保留論点は後続ラウンドで major として再指摘され escalate を招く（実戦観測）。
    // ユーザー裁定済みの保留は理由セルに裁定を書く — 理由付き保留は採否確定済みとして対象外
    for (const r of prows) {
      if (r.action === '保留' && EMPTY_REASON.test(r.reason) && latestRd - r.rd >= 2) {
        findings.push({
          check: 'L6:保留の滞留',
          detail: `${r.id} (L${r.line}): 保留が ${latestRd - r.rd} ラウンド滞留 — 採否を確定する` +
            `（放置は同一論点の major 再燃昇格の温床。裁定済みで残すなら理由セルに裁定を書く）`,
        })
      }
    }
    const stalled = n >= 3
      && counts[n - 1] >= counts[n - 2] && counts[n - 2] >= counts[n - 3] && counts[n - 1] > 0
      && rekindled.some(r => r.rd === latestRd)

    // 通過条件（blocker+major ゼロのラウンド）が最優先 — SKILL.md の正準。
    // 停滞・再燃はゼロラウンドが出ていない場合の脱出弁
    const latest = counts[counts.length - 1]
    const verdict = latest === 0 ? 'passed'
      : (rekindled.length > 0 || stalled) ? 'escalated'
      : '継続'

    console.log(`## ${prefix}（${label}）`)
    console.log(`ラウンド推移（blocker+major 生存数）: ${rounds.map((rd, i) => `Rd${rd}=${counts[i]}`).join(' → ')}`)
    if (rekindled.length > 0) {
      console.log(`再燃: ${rekindled.map(r => `${r.id}（${r.action}）`).join(', ')} — 反映と指摘の間で解釈が振動している`)
    }
    if (stalled) console.log('停滞: 3 ラウンド以上連続で blocker+major が減っておらず、最新ラウンドに未解消の再燃がある')
    console.log(`判定: ${verdict}`)
    console.log('')
  }

  // F（feedback）はラウンド収束の対象外 — 外部の結論の受け入れ台帳であり、
  // 完了条件は全項目の処置済み（L2 の未処置検査が正）。Rd は改訂サイクル番号
  {
    const frows = rows.filter(r => r.prefix === 'F')
    if (frows.length > 0) {
      const count = (a: string) => frows.filter(r => r.action === a).length
      console.log('## F（dandori-feedback）')
      console.log(`項目 ${frows.length} / 反映済 ${count('反映済')} / 却下 ${count('却下')} / 保留 ${count('保留')} / 未処置 ${count('')}`)
      console.log('収束判定の対象外 — 完了条件は未処置ゼロ（L2）')
      console.log('')
    }
  }

  finishReport()
}

// ---- state モード -----------------------------------------------------------------

if (mode === 'state') {
  const paths = argvRest.slice(1)
  if (paths.length !== 1 || paths[0].startsWith('--')) { console.error(USAGE); process.exit(2) }
  const statePath = paths[0]
  const lines = readLines(statePath, 'state.yaml')

  // state.yaml 用ミニパーサ（トップレベル + 1 段ネストのみ — 正準形式が要求する範囲）
  function stripComment(line: string): string {
    const i = line.search(/(^|\s)#/)
    return i === -1 ? line : line.slice(0, i)
  }
  const top: Record<string, string | Record<string, string>> = {}
  let curKey: string | null = null
  lines.forEach((raw, idx) => {
    const line = stripComment(raw)
    if (line.trim() === '') return
    const indent = line.length - line.trimStart().length
    const m = line.trim().match(/^([\w-]+):\s*(.*)$/)
    if (!m) { fail(`${statePath} L${idx + 1}: 解釈できない行: ${raw.trim()}`); return }
    const [, key, value] = m
    if (indent === 0) {
      if (value === '') { top[key] = {}; curKey = key }
      else { top[key] = value.trim(); curKey = null }
    } else if (curKey !== null && typeof top[curKey] === 'object') {
      ;(top[curKey] as Record<string, string>)[key] = value.trim()
    } else {
      fail(`${statePath} L${idx + 1}: ネストの親キーがない: ${raw.trim()}`)
    }
  })

  const FULL_ORDER = ['spec', 'sketch', 'ground', 'review', 'spike', 'plan', 'impl', 'codereview', 'refine', 'gate', 'annotate', 'strip', 'cleanup']
  const SHORT_PHASES = new Set(['spec', 'sketch', 'impl', 'codereview', 'refine', 'gate', 'annotate', 'strip', 'cleanup', 'feedback']) // sketch/codereview/refine は短縮でも任意実施可。annotate/strip/feedback は両コース共通
  // feedback は線形順序の外（done からの継続改善入口）— phases_done には入らない
  const PHASE_VOCAB = new Set([...FULL_ORDER, 'done', 'feedback'])

  const str = (v: unknown): string | null => typeof v === 'string' ? v : null
  const section = (k: string): Record<string, string> =>
    typeof top[k] === 'object' ? top[k] as Record<string, string> : {}

  // Y1: 語彙・形式
  const KNOWN_TOP = new Set(['feature', 'course', 'phase', 'phases_done', 'revision', 'sketch', 'review', 'spike', 'impl', 'codereview', 'refine', 'annotate', 'strip', 'cleanup', 'feedback', 'progress', 'updated'])
  for (const k of Object.keys(top)) {
    if (!KNOWN_TOP.has(k)) findings.push({ check: 'Y1:語彙・形式', detail: `未知のトップレベルキー: ${k}（正準定義は dandori ルーターの SKILL.md）` })
  }
  const course = str(top.course)
  if (course !== null && course !== 'full' && course !== 'short') {
    findings.push({ check: 'Y1:語彙・形式', detail: `course「${course}」は語彙外 — full / short` })
  }
  const phase = str(top.phase)
  if (phase === null) findings.push({ check: 'Y1:語彙・形式', detail: 'phase がない' })
  else if (!PHASE_VOCAB.has(phase)) findings.push({ check: 'Y1:語彙・形式', detail: `phase「${phase}」は語彙外` })
  // revision は改訂サイクルの記録 — どのフェーズでも許容（cleanup 前のループ中・done 後の再開後を通じて残る）
  const revisionRaw = str(top.revision)
  if (revisionRaw !== null && (!/^\d+$/.test(revisionRaw) || Number(revisionRaw) < 2)) {
    findings.push({ check: 'Y1:語彙・形式', detail: `revision「${revisionRaw}」が 2 以上の整数でない — 初回サイクルは書かない（dandori-feedback が 2 から採番）` })
  }
  const doneRaw = str(top.phases_done) ?? ''
  const phasesDone = doneRaw.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(s => s !== '')
  for (const p of phasesDone) {
    if (!FULL_ORDER.includes(p)) findings.push({ check: 'Y1:語彙・形式', detail: `phases_done の「${p}」は語彙外` })
  }
  const STATUS_VOCAB: Record<string, Set<string>> = {
    sketch: new Set(['pending', 'done', 'skipped']),
    review: new Set(['in_progress', 'passed', 'escalated']),
    spike: new Set(['pending', 'done', 'skipped']),
    codereview: new Set(['in_progress', 'passed', 'escalated', 'skipped']),
    refine: new Set(['pending', 'done', 'skipped']),
    annotate: new Set(['pending', 'done', 'skipped']),
    strip: new Set(['pending', 'done', 'skipped']),
    cleanup: new Set(['pending', 'done']), // クローズは省略不可 — B-ID 残置の裁定は strip.skipped 側
  }
  for (const [sec, vocab] of Object.entries(STATUS_VOCAB)) {
    const s = section(sec).status
    if (s !== undefined && !vocab.has(s)) {
      findings.push({ check: 'Y1:語彙・形式', detail: `${sec}.status「${s}」は語彙外 — ${[...vocab].join(' / ')}` })
    }
  }
  const numeric = (sec: string, key: string): number | null => {
    const v = section(sec)[key]
    if (v === undefined) return null
    if (!/^\d+$/.test(v)) {
      findings.push({ check: 'Y1:語彙・形式', detail: `${sec}.${key}「${v}」が非負整数でない` })
      return null
    }
    return Number(v)
  }
  const rounds = numeric('review', 'rounds')
  numeric('codereview', 'rounds')
  numeric('feedback', 'items')
  {
    const ts = section('feedback')['trace_scope']
    if (ts !== undefined && ts !== 'delta' && ts !== 'full') {
      findings.push({ check: 'Y1:語彙・形式', detail: `feedback.trace_scope「${ts}」は語彙外 — delta / full` })
    }
  }
  // milestones_done は整数カウンタ（逐次実装）と ID リスト（並列実装 — 完了順が
  // マイルストーン番号順と一致しない場合に必要。dandori-impl workflow.js はこちらで記録）の両形式を受理する
  const milestonesDone = (): number | null => {
    const v = section('impl')['milestones_done']
    if (v === undefined) return null
    if (/^\d+$/.test(v)) return Number(v)
    if (/^\[.*\]$/.test(v)) {
      const ids = v.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(s => s !== '')
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
      if (dup.length > 0) {
        findings.push({ check: 'Y1:語彙・形式', detail: `impl.milestones_done に重複 ID（${[...new Set(dup)].join(', ')}）` })
      }
      return new Set(ids).size
    }
    findings.push({ check: 'Y1:語彙・形式', detail: `impl.milestones_done「${v}」が非負整数でも ID リスト（[M1, M2] 形式）でもない` })
    return null
  }
  const mDone = milestonesDone()
  const mTotal = numeric('impl', 'milestones_total')
  numeric('refine', 'applied')
  numeric('refine', 'rejected')
  numeric('annotate', 'annotated')
  const updated = str(top.updated)
  if (updated !== null && !/^\d{4}-\d{2}-\d{2}$/.test(updated)) {
    findings.push({ check: 'Y1:語彙・形式', detail: `updated「${updated}」が YYYY-MM-DD 形式でない` })
  }

  // Y2: feature ↔ ディレクトリ名
  const feature = str(top.feature)
  const dirName = dirname(resolve(statePath)).split('/').pop() ?? ''
  if (feature !== null && feature !== dirName) {
    findings.push({ check: 'Y2:feature一致', detail: `feature「${feature}」がディレクトリ名「${dirName}」と一致しない` })
  }

  // Y3: フェーズ整合
  if (phase !== null && phase !== 'done' && phasesDone.includes(phase)) {
    findings.push({ check: 'Y3:フェーズ整合', detail: `phase「${phase}」が phases_done に入っている — 完了済みなら phase を次工程へ進める` })
  }
  if (phase === 'done' && !phasesDone.includes('gate')) {
    findings.push({ check: 'Y3:フェーズ整合', detail: 'phase: done なのに phases_done に gate がない — gate を通らずに done にはならない' })
  }
  if (phase === 'feedback' && !phasesDone.includes('gate')) {
    findings.push({ check: 'Y3:フェーズ整合', detail: 'phase: feedback なのに phases_done に gate がない — feedback は gate 通過後の安定点。gate を通らずに feedback にはならない' })
  }
  if (phase === 'feedback' && !phasesDone.includes('strip')) {
    findings.push({ check: 'Y3:フェーズ整合', detail: 'phase: feedback なのに phases_done に strip がない — feedback は annotate → strip を経た安定点（strip を skip した場合も phases_done には入る）' })
  }
  if (phase === 'done' && !phasesDone.includes('cleanup')) {
    findings.push({ check: 'Y3:フェーズ整合', detail: 'phase: done なのに phases_done に cleanup がない — done は cleanup（店じまい）完了後のみ。改訂待ちなら phase: feedback が正' })
  }
  if (phase === 'annotate' && !phasesDone.includes('gate')) {
    findings.push({ check: 'Y3:フェーズ整合', detail: 'phase: annotate なのに phases_done に gate がない — annotate（コメント保全）は gate 通過直後の工程' })
  }
  if (phase === 'strip' && !phasesDone.includes('annotate')) {
    findings.push({ check: 'Y3:フェーズ整合', detail: 'phase: strip なのに phases_done に annotate がない — strip（除去）の前に annotate（消える Why のコメント保全）を通す' })
  }
  if (phase === 'cleanup' && !phasesDone.includes('strip')) {
    findings.push({ check: 'Y3:フェーズ整合', detail: 'phase: cleanup なのに phases_done に strip がない — cleanup（店じまい）は annotate → strip → feedback の完全 fix 裁定後' })
  }
  // phase: feedback の間は phases_done が前サイクル（コース再判定前）の記録 — 短縮コース検査は免除
  if (course === 'short' && phase !== 'feedback') {
    for (const p of [phase, ...phasesDone]) {
      if (p !== null && p !== 'done' && !SHORT_PHASES.has(p)) {
        findings.push({ check: 'Y3:フェーズ整合', detail: `短縮コースに工程「${p}」は存在しない（spec → impl → gate — sketch / codereview / refine は任意実施のみ）` })
      }
    }
  }
  if (phasesDone.includes('impl') && mDone !== null && mTotal !== null && mDone < mTotal) {
    findings.push({ check: 'Y3:フェーズ整合', detail: `phases_done に impl があるのに milestones ${mDone}/${mTotal} — 全マイルストーン完了が impl の完了条件` })
  }
  if (mDone !== null && mTotal !== null && mDone > mTotal) {
    findings.push({ check: 'Y3:フェーズ整合', detail: `milestones_done（${mDone}）が milestones_total（${mTotal}）を超えている` })
  }
  const doneNeedsStatus: [string, string[]][] = [
    ['sketch', ['done', 'skipped']],
    ['review', ['passed', 'escalated']],
    ['spike', ['done', 'skipped']],
    ['codereview', ['passed', 'escalated', 'skipped']],
    ['refine', ['done', 'skipped']],
    ['annotate', ['done', 'skipped']],
    ['strip', ['done', 'skipped']],
    ['cleanup', ['done']],
  ]
  for (const [sec, ok] of doneNeedsStatus) {
    const s = section(sec).status
    if (phasesDone.includes(sec) && s !== undefined && !ok.includes(s)) {
      findings.push({ check: 'Y3:フェーズ整合', detail: `phases_done に ${sec} があるのに ${sec}.status が「${s}」 — 完了状態（${ok.join(' / ')}）でない` })
    }
  }
  if (rounds !== null && rounds >= 1 && phase !== null && FULL_ORDER.indexOf(phase) < FULL_ORDER.indexOf('review') && !phasesDone.includes('review')) {
    // review 実施済みなのに phase が review より前 = 逆行。逆行自体は正当だが phases_done から外した記録が必要
    findings.push({ check: 'Y3:フェーズ整合', detail: `review.rounds が ${rounds} なのに phase「${phase}」が review より前 — 逆行なら理由を design.md の発見ログに記録する（この指摘は記録済みなら無視してよい）` })
  }

  // Y4: 成果物整合
  const featureDir = dirname(resolve(statePath))
  const exists = (name: string): boolean => {
    try { statSync(join(featureDir, name)); return true } catch { return false }
  }
  if (phase === 'feedback') {
    // gate 後の安定点（成果物現役）と done 後の再開（処分済み）の両文脈があるため、
    // 成果物の存在/処分はどちらも正常 — spec.md だけを前提として要求する
    if (!exists('spec.md')) {
      findings.push({ check: 'Y4:成果物整合', detail: 'phase: feedback なのに spec.md がない — 改訂は fix 済み spec への差分として入る' })
    }
  } else if (phase !== 'done') {
    const needs: [string, string, string][] = [
      ['spec', 'spec.md', 'spec 完了の成果物'],
      ['ground', 'design.md', 'ground 完了の成果物'],
      ['plan', 'plan.md', 'plan 完了の成果物'],
      ['review', 'review-ledger.md', 'review 完了なら台帳が残っているはず'],
    ]
    for (const [p, file, why] of needs) {
      if (phasesDone.includes(p) && !exists(file)) {
        findings.push({ check: 'Y4:成果物整合', detail: `phases_done に ${p} があるのに ${file} がない（${why}）` })
      }
    }
    // sketch は skipped でも phases_done に入りうるので、status が skipped でない場合のみ成果物を要求する
    if (phasesDone.includes('sketch') && section('sketch').status !== 'skipped' && !exists('sketch.md')) {
      findings.push({ check: 'Y4:成果物整合', detail: 'phases_done に sketch があるのに sketch.md がない（sketch 完了の成果物 — skipped なら sketch.status に記録する）' })
    }
    // strip は trace.md を B 行↔テスト対応の作業リストとして使い、cleanup が処分する（処分は cleanup の最後）
    if ((phase === 'strip' || phase === 'cleanup') && !exists('trace.md')) {
      findings.push({ check: 'Y4:成果物整合', detail: `phase: ${phase} なのに trace.md がない — strip の作業リスト・cleanup の処分対象（gate は trace.md を処分しない）` })
    }
  } else {
    // 既定運用（docs/appendix-records.md）では spec.md 含む全ドキュメントを
    // 墓碑コミットで処分してクローズする — 残っていたら処分漏れの疑い
    for (const [file, hint] of [
      ['spec.md', '.dandori/records.md の retain 宣言で意図的に残すなら無視してよい'],
      ['sketch.md', 'アーカイブ方針で意図的に残すなら無視してよい'],
      ['plan.md', 'アーカイブ方針で意図的に残すなら無視してよい'],
      ['trace.md', 'アーカイブ方針で意図的に残すなら無視してよい'],
      ['review-ledger.md', 'アーカイブ方針で意図的に残すなら無視してよい'],
    ] as [string, string][]) {
      if (exists(file)) {
        findings.push({ check: 'Y4:成果物整合', detail: `phase: done なのに ${file} が残っている — クローズ手順（墓碑コミット）の処分漏れの疑い（${hint}）` })
      }
    }
  }

  console.log(`# state.yaml 整合検査レポート — ${statePath}`)
  console.log(`feature: ${feature ?? '（なし）'} / course: ${course ?? '（なし）'} / phase: ${phase ?? '（なし）'} / phases_done: [${phasesDone.join(', ')}]`)
  console.log('')
  finishReport()
}

// ---- map モード -------------------------------------------------------------------

if (mode === 'map') {
  let rootArg: string | null = null
  const mapPaths: string[] = []
  for (let i = 1; i < argvRest.length; i++) {
    const a = argvRest[i]
    if (a === '--root') {
      const v = argvRest[++i]
      if (v === undefined) { console.error(`--root にはソースルートのパスを渡す\n${USAGE}`); process.exit(2) }
      rootArg = v
      continue
    }
    if (a.startsWith('--')) { console.error(`未知のオプション: ${a}\n${USAGE}`); process.exit(2) }
    mapPaths.push(a)
  }
  if (mapPaths.length === 0) { console.error(USAGE); process.exit(2) }

  function git(cwd: string, args: string[]): string | null {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return null
    }
  }

  interface Anchor { raw: string; file: string; lineRef: number | null; symbol: string | null; line: number }

  /** バッククォートトークンからパスアンカーを解釈する。パスらしくないもの（コマンド等）は null */
  function parseAnchor(token: string, line: number): Anchor | null {
    if (/\s/.test(token)) return null // コマンド（`npm test -- xx` 等）
    if (!token.includes('/') && !/\.\w+/.test(token)) return null
    const m = token.match(/^(.*?)(?::([^:]+))?$/)
    if (!m) return null
    const suffix = m[2] ?? null
    if (suffix === null) return { raw: token, file: m[1], lineRef: null, symbol: null, line }
    if (/^\d+$/.test(suffix)) return { raw: token, file: m[1], lineRef: Number(suffix), symbol: null, line }
    const rng = suffix.match(/^(\d+)[-〜](\d+)$/)
    if (rng) {
      // 行範囲は終端行の生存だけ見れば十分（終端 ≤ EOF なら開始も範囲内）
      const from = Number(rng[1]), to = Number(rng[2])
      if (from >= to) { fail(`行範囲アンカーの順序が不正: ${token}`); return null }
      return { raw: token, file: m[1], lineRef: to, symbol: null, line }
    }
    if (/^[A-Za-z_$][\w$.]*$/.test(suffix)) return { raw: token, file: m[1], lineRef: null, symbol: suffix, line }
    return { raw: token, file: token, lineRef: null, symbol: null, line } // : を含むファイル名は稀 — 素通し
  }

  let totalClaims = 0, totalAnchors = 0
  for (const mapPath of mapPaths) {
    const lines = readLines(mapPath, 'map ファイル')
    // アンカー解決の基準 — 既定は map の所在から導出。worktree 並列レーン等で
    // ソースルートが .dandori と一致しない場合は --root で明示されたルートを使う
    const rootBase = rootArg !== null ? resolve(rootArg) : resolve(dirname(mapPath))
    const repoRoot = git(rootBase, ['rev-parse', '--show-toplevel'])
    if (repoRoot === null) {
      console.error(rootArg !== null
        ? `--root ${rootArg}: git リポジトリ内にない — アンカーの解決基準（リポジトリルート）を特定できない`
        : `${mapPath}: git リポジトリ内にない — アンカーの解決基準（リポジトリルート）を特定できない（ソースが別の場所にあるなら --root で明示する）`)
      process.exit(2)
    }
    const rel = (p: string) => `${mapPath}: ${p}`

    // V1: generated-at ヘッダと変更ファイル集合
    let changedFiles: Set<string> | null = null
    const gen = lines.map((l, i) => ({ m: l.match(/<!--\s*generated-at:\s*([0-9a-f]{7,40})\b.*?-->/), i }))
      .find(x => x.m !== null)
    if (!gen) {
      findings.push({ check: 'V1:generated-at', detail: rel('generated-at ヘッダがない — 鮮度検査の基準点を記録する（正準定義）') })
    } else {
      const hash = gen.m![1]
      const diff = git(repoRoot, ['diff', '--name-only', `${hash}..HEAD`])
      if (diff === null) {
        findings.push({
          check: 'V1:generated-at',
          detail: rel(`generated-at の hash ${hash} を git で解決できない（rebase / shallow clone で消失？）— 変更ファイル突合（V3）はスキップ`),
        })
      } else {
        changedFiles = new Set(diff.split('\n').filter(l => l !== ''))
      }
    }

    // 主張（トップレベル箇条書き）とアンカーの走査
    interface Claim { text: string; line: number; anchors: Anchor[]; unverifiedNote: boolean; hasGrade: boolean }
    const claims: Claim[] = []
    const blockAnchors: Anchor[] = []
    let inFence = false
    let inStateMapBlock = false
    lines.forEach((line, idx) => {
      const t = line.trim()
      if (/^```/.test(t)) {
        inStateMapBlock = !inFence && /^```dandori-state-map\s*$/.test(t)
        inFence = !inFence
        return
      }
      if (inFence) {
        if (inStateMapBlock) {
          const am = t.match(/^anchor:\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/)
          if (am) {
            const a = parseAnchor(am[1].trim(), idx + 1)
            if (a) blockAnchors.push(a)
          }
        }
        return
      }
      if (!/^- /.test(line)) return
      const anchors: Anchor[] = []
      const evid = line.match(/根拠\s*[:：]\s*(.*)$/)
      if (evid) {
        // 等級マーク（[実行検証済: `コマンド` ...] 等）内のバッククォートはコマンドなので、
        // 根拠: からマーク開始までの区間だけをアンカー源にする
        const seg = evid[1].split('[')[0]
        for (const bt of seg.match(/`([^`]+)`/g) ?? []) {
          const a = parseAnchor(bt.slice(1, -1), idx + 1)
          if (a) anchors.push(a)
        }
      }
      claims.push({
        text: line.replace(/^- /, '').slice(0, 60),
        line: idx + 1,
        anchors,
        unverifiedNote: line.includes('未確認'),
        hasGrade: /\[(実行検証済|読解のみ)/.test(line),
      })
    })
    if (inFence) fail(`${mapPath}: fenced block が閉じていない`)

    // V2 / V3: アンカー死活
    function checkAnchor(a: Anchor, owner: string): void {
      totalAnchors++
      const abs = join(repoRoot!, a.file)
      let st: { isDirectory(): boolean; size: number } | null = null
      try { st = statSync(abs) } catch { /* 消滅 */ }
      if (st === null) {
        findings.push({ check: 'V2:アンカー先消滅', detail: rel(`L${a.line} ${owner} のアンカー \`${a.raw}\` — ${a.file} が存在しない`) })
        return
      }
      if (!st.isDirectory()) {
        if (a.lineRef !== null) {
          const n = readFileSync(abs, 'utf-8').split('\n').length
          if (a.lineRef > n) {
            findings.push({ check: 'V2:アンカー先消滅', detail: rel(`L${a.line} ${owner} のアンカー \`${a.raw}\` — ${a.file} は ${n} 行（:${a.lineRef} が範囲外）`) })
            return
          }
        }
        if (a.symbol !== null && !readFileSync(abs, 'utf-8').includes(a.symbol)) {
          findings.push({ check: 'V2:アンカー先消滅', detail: rel(`L${a.line} ${owner} のアンカー \`${a.raw}\` — ${a.file} にシンボル ${a.symbol} が見つからない`) })
          return
        }
      }
      if (changedFiles !== null && changedFiles.has(a.file)) {
        findings.push({ check: 'V3:アンカー先変更', detail: rel(`L${a.line} ${owner} のアンカー \`${a.raw}\` — generated-at 以降に変更あり（主張の再検証候補）`) })
      }
    }
    for (const c of claims) for (const a of c.anchors) checkAnchor(a, `主張「${c.text}」`)
    for (const a of blockAnchors) checkAnchor(a, '状態マップ')

    // V4 / V5: アンカー・等級のない主張
    for (const c of claims.filter(c => !c.unverifiedNote)) {
      if (c.anchors.length === 0) {
        findings.push({ check: 'V4:アンカーなし主張', detail: rel(`L${c.line}「${c.text}」— 根拠アンカーがなく verify で検査できない（未確認なら明記する）`) })
      }
      if (!c.hasGrade) {
        findings.push({ check: 'V5:検証等級なし主張', detail: rel(`L${c.line}「${c.text}」— [実行検証済] / [読解のみ] の等級がない`) })
      }
    }
    totalClaims += claims.length
  }

  console.log(`# map アンカー死活検査レポート — ${mapPaths.join(', ')}` +
    (rootArg !== null ? `（root: ${resolve(rootArg)}）` : ''))
  console.log(`主張 ${totalClaims} / アンカー ${totalAnchors}`)
  console.log('')
  finishReport()
}

// ---- テストコード走査の共通部品（trace / residue）----------------------------------

const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'vendor', 'target', '.dandori'])
const SCAN_MAX_FILE_SIZE = 1024 * 1024

// B-ID トークンの grep パターン。括弧内は補足注記としてハイフンを許す
// （テストコメントの B-1(C-25): 形式 — 括弧の外にハイフンを許すと B-3-B-4 等の
// 連結表記を丸ごと 1 トークンに食ってしまうため、括弧内に限定する）
const B_TOKEN_RE = /B-[\w.]+(?:\([\w.-]*\))?/g

/** grep トークンを B-ID に正規化する。B-ID 候補でないもの（B-ORDER 等）は null */
function normalizeBIdToken(raw: string): string | null {
  let id = raw.replace(/\.+$/, '') // 文末ピリオド由来のゴミを除去
  // 閉じ括弧は開き括弧と釣り合わない分だけ末尾から剥がす（B-15(b) は保持、B-15) は B-15 に）
  while (id.endsWith(')') && (id.match(/\(/g) ?? []).length < (id.match(/\)/g) ?? []).length) {
    id = id.slice(0, -1)
  }
  while (id.endsWith('(')) id = id.slice(0, -1) // ID は開き括弧で終わらない
  id = id.replace(/\.+$/, '')
  // B-ID は数値開始が正準 — フィクスチャ文字列（B-ORDER 等）を候補にしない
  if (!/^B-\d/.test(id)) return null
  return id
}

function walkFiles(path: string, onFile: (path: string) => void): void {
  let st: { isDirectory(): boolean; size: number }
  try { st = statSync(path) } catch {
    console.error(`走査対象を読めない: ${path}`)
    process.exit(2)
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (SCAN_SKIP_DIRS.has(name)) continue
      walkFiles(join(path, name), onFile)
    }
  } else if (st.size <= SCAN_MAX_FILE_SIZE) {
    onFile(path)
  }
}

// ---- trace モード -----------------------------------------------------------------

if (mode === 'trace') {
  let traceRevision: number | null = null
  const scopes: string[] = []
  const paths: string[] = []
  for (let i = 1; i < argvRest.length; i++) {
    const a = argvRest[i]
    if (a === '--revision') {
      const v = argvRest[++i]
      if (v === undefined || !/^[1-9]\d*$/.test(v)) { console.error(`--revision には正の整数を渡す\n${USAGE}`); process.exit(2) }
      traceRevision = Number(v)
      continue
    }
    if (a === '--scope') {
      const v = argvRest[++i]
      if (v === undefined || v.startsWith('--')) { console.error(`--scope にはディレクトリプレフィックスを渡す\n${USAGE}`); process.exit(2) }
      scopes.push(v.replace(/\/+$/, '') + '/')
      continue
    }
    if (a.startsWith('--')) { console.error(`未知のオプション: ${a}\n${USAGE}`); process.exit(2) }
    paths.push(a)
  }
  if (paths.length < 2) { console.error(USAGE); process.exit(2) }
  const [specPath, ...scanRoots] = paths
  const spec = parseSpec(readLines(specPath, 'spec'), specPath)

  const specIds = new Set(spec.bs.flatMap(b => expandRange(b.id)))
  const struckIds = new Set(spec.bs.filter(b => b.struck).flatMap(b => expandRange(b.id)))

  // テストファイル走査。B-ID はトークン単位で完全一致（B-1 が B-12 に誤マッチしない）
  const hits = new Map<string, string[]>() // B-ID → "file:line" の一覧
  const skipHits = new Map<string, string[]>() // B-ID → skip/todo 指定されたテスト行の "file:line"
  // 同一行の skip 検出（.skip( / .todo( / xit( / xdescribe( / xtest(）— 外側ブロックの
  // describe.skip は行 grep では見えない（gate のランナーサマリ skipped=0 確認が正）
  const SKIP_TEST = /\.(skip|todo)\s*\(|\b(xit|xdescribe|xtest)\s*\(/
  let scannedFiles = 0

  function scanFile(path: string): void {
    let text: string
    try { text = readFileSync(path, 'utf-8') } catch { return }
    if (text.includes('\u0000')) return // バイナリ
    scannedFiles++
    text.split('\n').forEach((line, idx) => {
      const skipped = SKIP_TEST.test(line)
      for (const raw of line.match(B_TOKEN_RE) ?? []) {
        let id = normalizeBIdToken(raw)
        if (id === null) continue
        if (!specIds.has(id)) {
          // spec にない括弧サフィックス付き ID（B-15(b) のパラメタライズ表記や
          // B-1(C-25) の指摘 ID 注記）は基底 B-ID に帰属
          const base = id.match(/^(B-\d[\w.]*)\([\w.-]*\)$/)
          if (base && specIds.has(base[1])) id = base[1]
        }
        if (!hits.has(id)) hits.set(id, [])
        hits.get(id)!.push(`${path}:${idx + 1}`)
        if (skipped) {
          if (!skipHits.has(id)) skipHits.set(id, [])
          skipHits.get(id)!.push(`${path}:${idx + 1}`)
        }
      }
    })
  }
  for (const root of scanRoots) walkFiles(root, scanFile)

  // 引用の表示整形 — --scope 指定ディレクトリ配下を先頭に並べ、5 件で切って残数を注記する
  // （収集は無制限 — 他フィーチャー同番 B-ID のノイズが本命引用を押し出さないため）
  const inScope = (loc: string) => scopes.some(s => loc.startsWith(s))
  function citeList(locs: string[]): string {
    const ordered = scopes.length > 0 ? [...locs.filter(inScope), ...locs.filter(l => !inScope(l))] : locs
    if (ordered.length <= 5) return ordered.join(', ')
    return `${ordered.slice(0, 5).join(', ')}（他 ${ordered.length - 5} 件）`
  }

  // トレース表の叩き台（unit/e2e/formal はテスト対応が必要。visual/manual は最終ゲートで確認）
  const NEEDS_TEST = new Set(['unit', 'e2e', 'formal'])
  console.log(`# 初期トレース表 — ${specPath}`)
  console.log(`走査: ${scanRoots.join(', ')}（${scannedFiles} ファイル）`)
  if (traceRevision !== null) {
    console.log(`差分トレース（revision ${traceRevision}）— Rev < ${traceRevision} の行は回帰扱い。対応の正は前サイクルの gate コミット（git 履歴）`)
  }
  console.log('状態は実行前の初期値 — ゲート工程がテストを再実行して更新する')
  console.log('')
  console.log('| B 行 | ゲート | 状態 | 根拠 |')
  console.log('|------|--------|------|------|')
  for (const b of spec.bs.filter(b => !b.struck)) {
    // 乖離マーク（e2e→unit）は左辺 = 現状の固定方法で扱う。注記はトレース表では落とす
    const parsed = parseGateExpr(b.gateRaw ?? '')
    const tags = parsed.current
    const gate = parsed.tokens.join(', ') || '（Gate なし）'
    const found = expandRange(b.id).flatMap(id => hits.get(id) ?? [])
    // 差分トレース: 前サイクルで検証済みの行（Rev が現 revision 未満 / 無印 = 初回）は
    // 個別トレースを要求しない。strip で B-ID が剥がされた後でも偽 T1 を出さないため。
    // ただしテストに B-ID が残っている行（strip skip プロジェクト等）は通常フローで再実行対象
    const isOldRow = traceRevision !== null && (b.rev === null || b.rev < traceRevision)
    if (isOldRow && found.length === 0) {
      const prevRev = b.rev ?? 1
      if (tags.some(t => NEEDS_TEST.has(t))) {
        console.log(`| ${b.id} | ${gate} | ✅ 回帰 | Rev ${prevRev} 検証済み — 回帰はスイート緑 + skipped/todo 0 で担保 |`)
      } else {
        console.log(`| ${b.id} | ${gate} | ⏳ 回帰確認の要否を裁定 | Rev ${prevRev} で確認済み — 改訂の影響があれば再確認 |`)
      }
      continue
    }
    if (tags.some(t => NEEDS_TEST.has(t))) {
      if (found.length > 0) {
        console.log(`| ${b.id} | ${gate} | ⏳ 要再実行 | ${citeList(found)} |`)
      } else {
        console.log(`| ${b.id} | ${gate} | ⚠️ 未検証候補 | B-ID の grep ヒットなし |`)
        findings.push({
          check: 'T1:対応テストなし',
          detail: `${b.id}（${b.title} / ${gate}）に対応するテストが grep で見つからない — ` +
            `テスト追加か、推測でない対応理由の明記か、manual への降格裁定`,
        })
      }
    } else if (tags.includes('manual')) {
      console.log(`| ${b.id} | ${gate} | ⏳ ユーザー確認待ち | 確認手順を B 行から生成する |`)
    } else {
      console.log(`| ${b.id} | ${gate} | ⏳ 要確認 | ${found.length > 0 ? citeList(found) : '—'} |`)
    }
  }
  console.log('')

  // T2 / T3: テスト側の幽霊・削除済み B-ID
  for (const [id, locs] of [...hits.entries()].sort()) {
    if (struckIds.has(id)) {
      findings.push({
        check: 'T3:削除済み参照',
        detail: `削除済み（取り消し線）の ${id} を参照するテストがある: ${citeList(locs)}`,
      })
    } else if (!specIds.has(id)) {
      findings.push({
        check: 'T2:幽霊B-ID',
        detail: `テストコード中の ${id} が spec にない（typo か spec の陳腐化）: ${citeList(locs)}`,
      })
    }
  }

  // T4: skip されたテスト（同一行検出のみ。緑のスイートに混ざっても実行されない = 偽 ✅ の温床）
  for (const [id, locs] of [...skipHits.entries()].sort()) {
    if (!specIds.has(id)) continue // 幽霊は T2 で報告済み
    findings.push({
      check: 'T4:skipされたテスト',
      detail: `${id} のテストが skip / todo 指定されている — スイートが緑でも実行されていない: ${citeList(locs)}`,
    })
  }

  finishReport()
}

// ---- residue モード ---------------------------------------------------------------

if (mode === 'residue') {
  const roots = argvRest.slice(1)
  if (roots.length === 0 || roots.some(p => p.startsWith('--'))) { console.error(USAGE); process.exit(2) }

  // RS3: プロセス語彙のパターン集。V1 等のハイフンなし状態変数 ID は誤検出が多く対象外（ヘッダ参照）
  const RS3_PATTERNS: Array<{ re: RegExp; label: string }> = [
    { re: /(?<![\w-])[RCF]-\d+(?![\w-])/, label: 'レビュー指摘 ID（R-n / C-n / F-n）' },
    { re: /(?:design|spec|plan|trace|sketch)\.md|review-ledger/, label: '工程ドキュメント参照' },
    { re: /地雷(?:\s*\d+|リスト)/, label: '地雷リスト参照' },
    { re: /軸対応/, label: '状態モデル軸対応の語彙' },
    { re: /spec\s*§/, label: 'spec セクション参照' },
  ]

  let scannedFiles = 0
  let exemptLines = 0
  for (const root of roots) {
    walkFiles(root, (path) => {
      let text: string
      try { text = readFileSync(path, 'utf-8') } catch { return }
      if (text.includes('\u0000')) return // バイナリ
      scannedFiles++
      let exemptNext = false
      text.split('\n').forEach((line, idx) => {
        // dandori-ok: <理由> の行は裁定済みの機能的依存 — その行と直後の 1 行を除外
        // （マーカー自身も dandori を含む。コメント行にマーカー、次行に守りたい参照、の形を許す）
        if (line.includes('dandori-ok:')) { exemptLines++; exemptNext = true; return }
        if (exemptNext) { exemptLines++; exemptNext = false; return }
        const loc = `${path}:${idx + 1}`
        for (const raw of line.match(B_TOKEN_RE) ?? []) {
          const id = normalizeBIdToken(raw)
          if (id === null) continue
          findings.push({
            check: 'RS1:B-IDトークン残存',
            detail: `${id} が残っている: ${loc} — テスト名・コメントから剥がすか、機能的依存なら dandori-ok: で裁定を記録する`,
          })
        }
        if (/dandori/i.test(line)) {
          findings.push({
            check: 'RS2:dandori言及残存',
            detail: `${loc}: ${line.trim().slice(0, 80)}`,
          })
        }
        for (const { re, label } of RS3_PATTERNS) {
          if (re.test(line)) {
            findings.push({
              check: 'RS3:プロセス語彙残存',
              detail: `${label}: ${loc} — 自然文に書き換えるか、機能的依存なら dandori-ok: で裁定を記録する: ${line.trim().slice(0, 60)}`,
            })
          }
        }
      })
    })
  }

  console.log(`# プロセス言及残存検査 — ${roots.join(', ')}`)
  console.log(`走査 ${scannedFiles} ファイル / dandori-ok 除外 ${exemptLines} 行`)
  console.log('')
  finishReport()
}

export {}
