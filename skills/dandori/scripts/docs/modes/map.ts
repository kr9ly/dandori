/**
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
 */

import { dirname, execFileSync, join, readFileSync, resolve, statSync } from '../env.ts'
import { fail, findings, finishReport, readLines } from '../report.ts'
import { USAGE } from '../usage.ts'

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }


export function run(argvRest: string[]): void {
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
