/**
 * spec.md §2（正常系バリエーション）の状態モデル語彙。
 *
 * 設計方針:
 * - 軸（axis）はテスト対象の Given 空間を張る変数。値は排他的
 * - per_item: true は「注文内の商品ごとに独立に値を取る」軸 — 混在（mixed）が
 *   成立するため、混在自体を直交宣言するか交点として列挙する必要がある
 * - observation / modifier は軸のふりをした非・軸。カバレッジ直積から除外し、
 *   別枠（observations は「観測するB行があるか」だけ検査）で扱う
 * - addedBy: レビューラウンドで後から追加された要素のマーク。
 *   --as-of=fix でこれらを除外し「spec fix 時点のモデル」を復元する（バックテスト用）
 */

export interface Axis {
  id: string
  /** spec.md 上の呼称（軸1 など） */
  label: string
  values: AxisValue[]
  /** 基準シナリオでの値。デルタ形式の Covers 展開に使う */
  base: string
  /** 商品単位で値を取る軸（注文レベルでは混在があり得る） */
  perItem?: boolean
}

export interface AxisValue {
  id: string
  /** spec.md の S 番号など */
  ref?: string
  note?: string
  addedBy?: string
}

/** 軸でないもの: 他シナリオの結果の観測（例: 在庫アラート） */
export interface Observation {
  id: string
  ref: string
  /** どの軸の帰結の観測か */
  of: string[]
  note?: string
}

/** 軸でないもの: 他シナリオの出力を修飾する状態（例: セット商品） */
export interface Modifier {
  id: string
  ref: string
  /** 何の出力を修飾するか */
  affects: string[]
  note?: string
}

export interface OrthogonalDecl {
  /** 2軸ペア。第2要素 '*' は「他の全軸と直交」 */
  axes: [string, string]
  reason: string
  addedBy?: string
}

/** グループ直交宣言: グループ内の全ペアを直交と裁定する（実験2で追加） */
export interface OrthogonalGroup {
  group: string[]
  reason: string
  addedBy?: string
}

/** 依存交点: この組み合わせで挙動が変わる — 明示的にカバーされるべき */
export interface DependentDecl {
  cells: Record<string, string | string[]>
  note: string
  addedBy?: string
}

/** 値の制約: value が成立するのは other 軸が allowed のときだけ */
export interface OnlyConstraint {
  axis: string
  value: string
  requires: Record<string, string[]>
  note: string
}

/** 値の連鎖: 組み合わせでなく逐次遷移（フォールバック続落など） */
export interface Chain {
  from: string
  to: string
  note: string
  addedBy?: string
}

/** B 行のカバー宣言。cells は基準シナリオからのデルタ */
export interface Cover {
  b: string
  title: string
  /** 値に配列を書いたらパラメタライズ（全値をこの1行でカバー） */
  cells: Record<string, string | string[]>
  /** 観測・修飾・連鎖のカバー */
  extras?: string[]
  addedBy?: string
}

export interface Model {
  axes: Axis[]
  observations: Observation[]
  modifiers: Modifier[]
  orthogonal: OrthogonalDecl[]
  orthogonalGroups?: OrthogonalGroup[]
  dependent: DependentDecl[]
  only: OnlyConstraint[]
  chains: Chain[]
  covers: Cover[]
}
