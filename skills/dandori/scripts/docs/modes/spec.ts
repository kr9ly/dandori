/**
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
 */

import { findings, finishReport, readLines } from '../report.ts'
import { GATE_VOCAB, expandRange, parseGateExpr, parseSpec } from '../spec-parse.ts'
import { USAGE } from '../usage.ts'

// @ts-ignore -- 依存なし実行のため @types/node を入れていない
declare const process: { argv: string[]; exit(code: number): never }


export function run(argvRest: string[]): void {
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
