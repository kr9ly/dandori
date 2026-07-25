/**
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
 */

import { join, readFileSync } from '../env.ts'
import { findings, finishReport, readLines } from '../report.ts'
import { expandRange, parseGateExpr, parseSpec } from '../spec-parse.ts'
import { B_TOKEN_RE, normalizeBIdToken, walkFiles } from '../scan.ts'
import { USAGE } from '../usage.ts'

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }


export function run(argvRest: string[]): void {
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
