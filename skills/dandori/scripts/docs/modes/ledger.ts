/**
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
 *   --mark-zero-round <R|C> <rd|auto> で行う（決定的・冪等 — 検査・収束判定と同一コマンドで済む。
 *   エージェントによるマーカーの自由編集は監査改竄と誤検知されブロックされた実戦観測があり、
 *   このオプションが恒久対策 2026-07-21）。`auto` は台帳の実ラウンド番号から導出する —
 *   行の最大 Rd + 1、ただし既存マーカーが行より先の Rd を主張しているならその Rd を再利用する
 *   （ゼロラウンドは記録済み — 常に +1 する実装だと auto の再実行でラウンドが際限なく進む）。
 *   呼び出し側のローカルなラウンド数え上げを渡すと既存 Rd 系列と食い違うマーカーが打たれ、
 *   収束済みなのに escalated になる（2026-07-25 実戦観測）。
 */

import { appendFileSync, join } from '../env.ts'
import { fail, findings, finishReport, readLines, splitCells } from '../report.ts'
import { USAGE } from '../usage.ts'

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }


export function run(argvRest: string[]): void {
  let markPrefix: string | null = null
  let markRd: number | null = null
  const paths: string[] = []
  for (let i = 1; i < argvRest.length; i++) {
    const a = argvRest[i]
    if (a === '--mark-zero-round') {
      const p = argvRest[++i]
      const v = argvRest[++i]
      if ((p !== 'R' && p !== 'C') || v === undefined || !(v === 'auto' || /^[1-9]\d*$/.test(v))) {
        console.error(`--mark-zero-round には接頭辞（R | C）とラウンド番号（正の整数 | auto）を渡す\n${USAGE}`)
        process.exit(2)
      }
      markPrefix = p
      // auto は「台帳の実ラウンド番号 + 1」を後段で導出する（-1 は導出待ちの標識）。
      // 呼び出し側のローカルなラウンド数え上げを台帳に持ち込むと、既存行の Rd 系列と
      // 食い違うマーカーが打たれ、収束済みなのに L5 矛盾・停滞判定で escalated になる
      // （2026-07-25 実戦観測: C 系列に workflow ローカルの 1〜5 が打たれてマーカー衝突）
      markRd = v === 'auto' ? -1 : Number(v)
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
    const text = readLines(ledgerPath, '台帳').join('\n')
    if (markRd === -1) {
      // 「指摘なし」ラウンド = 行がある最新ラウンドの次。行由来とマーカー由来の最大 Rd を
      // 分けて数え、マーカーが行より先を主張しているなら既にゼロラウンドが記録済み —
      // その Rd を再利用して既存マーカーの冪等スキップに合流させる（auto の再実行で
      // ラウンドが際限なく進むのを防ぐ）
      let rowMaxRd = 0
      let markerMaxRd = 0
      let inFenceRd = false
      for (const line of text.split('\n')) {
        if (/^```/.test(line.trim())) { inFenceRd = !inFenceRd; continue }
        if (inFenceRd) continue
        const zm = line.match(new RegExp(`<!--\\s*round:\\s*${markPrefix}\\s+Rd=(\\d+)\\s+指摘なし\\s*-->`))
        if (zm) { markerMaxRd = Math.max(markerMaxRd, Number(zm[1])); continue }
        const tm = line.trim().match(/^\|(.+)\|$/)
        if (!tm) continue
        const cells = splitCells(tm[1])
        if ((cells[0] ?? '').match(/^([RCF])-(\d+)$/)?.[1] !== markPrefix) continue
        const n = Number(cells[1])
        if (Number.isInteger(n)) rowMaxRd = Math.max(rowMaxRd, n)
      }
      markRd = markerMaxRd > rowMaxRd ? markerMaxRd : rowMaxRd + 1
      console.log(`マーカーのラウンド番号を台帳から導出: ${markPrefix} Rd=${markRd}（行の最大 Rd=${rowMaxRd} / マーカーの最大 Rd=${markerMaxRd}）`)
    }
    const marker = `<!-- round: ${markPrefix} Rd=${markRd} 指摘なし -->`
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
    // 機械可読行 — workflow の収束判定はこの行の逐語転記をスクリプト側で正規表現マッピングする。
    // 判定エージェントに意味的マッピングをさせると「継続」を escalated に誤対応づける
    // 自由裁量事故が起きる（2026-07-22 実戦観測）— 転記のみに縮退させるための固定トークン
    console.log(`[verdict] ${prefix}=${verdict === '継続' ? 'continue' : verdict}`)
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
