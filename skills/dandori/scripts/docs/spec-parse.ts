/**
 * spec.md のパースと B-ID 参照の解決。spec / plan / design / trace / gate 系の
 * モードが共有する。正準フォーマットの定義は dandori-spec の SKILL.md が正。
 */

import { fail } from './report.ts'
import { normalizeBIdToken } from './scan.ts'

export interface SpecB {
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

export interface Section { name: string; line: number }

export interface ParsedSpec { sections: Section[]; bs: SpecB[] }

/**
 * `B-1〜B-4` 形式の範囲見出しを個別 ID に展開する（純数値のみ）。非範囲はそのまま。
 * 右辺の B- 接頭辞は省略可（`B-20〜23` — 実データで頻出する省略形を受理する）
 */
export function expandRange(idToken: string): string[] {
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
export const B_REF_RE = /B-[\w.()]+(?:〜(?:B-[\w.()]+|\d[\w.()]*))?/g

/**
 * 取り消し線スパン（~~...~~）を除去する。取り消し線内の B-ID は削除の記録であって
 * 参照ではない — 生文字列マッチの前に必ず通す
 */
export function stripStruck(text: string): string {
  return text.replace(/~~.*?~~/g, '')
}

export function resolveBIdRefs(raw: string, specIds: Set<string>): string[] {
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

export function parseSpec(lines: string[], path: string): ParsedSpec {
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
export const GATE_VOCAB = new Set(['unit', 'e2e', 'visual', 'manual', 'formal'])
export function parseGateExpr(raw: string): { tokens: string[]; current: string[]; note: string | null } {
  const cut = raw.search(/[（(]/)
  const expr = (cut >= 0 ? raw.slice(0, cut) : raw).trim()
  const note = cut >= 0 ? raw.slice(cut).trim() : null
  const tokens = expr.split(/[,、/\s]+/).filter(t => t !== '')
  const current = tokens.map(t => t.split(/→|->/)[0]).filter(t => t !== '')
  return { tokens, current, note }
}

