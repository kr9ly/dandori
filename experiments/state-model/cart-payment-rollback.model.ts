/**
 * 実験1: cart-payment 異常系の横断関心事「ロールバック」のモデル化。
 *
 * 出典: spec.md §3「横断: ロールバック（payment_decorator 相当 —
 * 失敗タイミング × 確保済みリソースで分岐）」+ B-25 / B-46〜B-48
 *
 * バックテスト対象: R4 blocker-2
 *   (1) 旧 B-46 は「フェーズ0〜5」でフェーズ6（E22/E23 — Shipping 作成前）を取り落とした
 *   (2) 旧 B-47 は shipment_id あり（WMS 200 経由）のみで、
 *       shipment_id=None（503 maintenance / 仮宛先失敗 failed 経由）の 2 態目を欠いた
 *
 * モデリング判断:
 * - failure_phase の値域は §3 の異常系マトリクスのフェーズ構造から機械的に写せる
 *   （E3 のみ「ロールバック対象外」の裁定が付くため独立値にする）
 * - shipping_state の値域 {none, with_id, without_id} は fix 時点の §2 から導出可能 —
 *   S17（hold_payed / shipment_id null）と S18 失敗（failed Shipping）は
 *   §2 に fix 時点から書かれていた。よって値そのものに addedBy は付けず、
 *   「カバーの追加」だけを addedBy でマークする（= fix 時点でもモデルは書けたが
 *   B 行が欠けていた、という反実仮想を正確に表す）
 */
import type { Model } from './model-types.ts'

export const model: Model = {
  axes: [
    {
      id: 'failure_phase',
      label: '失敗タイミング（異常系マトリクスのフェーズ）',
      base: 'p0_input',
      values: [
        { id: 'p0_input', note: 'E1, E2' },
        { id: 'p0_lock_3003', note: 'E3 — payment_decorator が code 3003 を明示除外（二重注文対策）' },
        { id: 'p1_discount', note: 'E4, E5, E6' },
        { id: 'p2_userinfo', note: 'E7, E8' },
        { id: 'p3_method', note: 'E9〜E12' },
        { id: 'p4_goods_delivery', note: 'E13〜E17' },
        { id: 'p5_payment_verify', note: 'E18〜E21' },
        { id: 'p6_stock_shipparam', note: 'E22, E23 — Shipping 作成前の最終フェーズ' },
        { id: 'p7_capture', note: 'E24〜E26 — Shipping 作成後（金流リスク帯）' },
      ],
    },
    {
      id: 'shipping_state',
      label: '確保済みリソース: Shipping 行の状態',
      base: 'none',
      values: [
        { id: 'none', note: 'Shipping 行未作成' },
        { id: 'with_id', note: 'shipment_id あり（WMS 200 / 仮宛先成功経由）' },
        { id: 'without_id', note: 'shipment_id=None（503 maintenance / 仮宛先失敗 failed 経由 — §2 S17/S18 から fix 時点で導出可能）' },
      ],
    },
    {
      id: 'cart_recreated',
      label: '失敗時点で同一ユーザーの shopping カートが別途存在するか',
      base: 'no',
      values: [{ id: 'no' }, { id: 'yes', note: 'B-48 — status 復帰をスキップ' }],
    },
  ],

  observations: [],
  modifiers: [],

  orthogonal: [
    {
      axes: ['failure_phase', 'cart_recreated'],
      reason: 'status 復帰スキップはロールバック共通の最終ステップ — どのフェーズの失敗でも同じ判定',
    },
    {
      axes: ['shipping_state', 'cart_recreated'],
      reason: 'Shipping 削除と status 復帰は独立したロールバックステップ',
    },
  ],

  dependent: [
    {
      cells: { failure_phase: 'p7_capture', shipping_state: ['with_id', 'without_id'] },
      note: '§3 横断の宣言そのもの: 失敗タイミング × 確保済みリソースで分岐（with_id は WMS キャンセル + 行削除、without_id は行削除のみ）',
    },
  ],

  only: [
    {
      axis: 'shipping_state',
      value: 'with_id',
      requires: { failure_phase: ['p7_capture'] },
      note: 'Shipping 行は create_shipping（フェーズ6 の後）で作られる — それ以前の失敗では存在しない',
    },
    {
      axis: 'shipping_state',
      value: 'without_id',
      requires: { failure_phase: ['p7_capture'] },
      note: '同上',
    },
  ],

  chains: [],

  covers: [
    {
      b: 'B-25',
      title: '並行リクエスト（E3）— ロールバック対象外',
      cells: { failure_phase: 'p0_lock_3003' },
    },
    {
      b: 'B-46',
      title: '出庫依頼作成前の失敗（E27a）— fix 時点の射程「フェーズ0〜5」',
      cells: {
        failure_phase: ['p0_input', 'p1_discount', 'p2_userinfo', 'p3_method', 'p4_goods_delivery', 'p5_payment_verify'],
      },
    },
    {
      b: 'B-46(R4)',
      title: 'フェーズ6 も Shipping 作成前 — R4 blocker-2 で射程訂正',
      cells: { failure_phase: 'p6_stock_shipparam' },
      addedBy: 'R4 blocker-2',
    },
    {
      b: 'B-47',
      title: '出庫依頼作成後の失敗（E27b）— fix 時点は shipment_id ありのみ',
      cells: { failure_phase: 'p7_capture', shipping_state: 'with_id' },
    },
    {
      b: 'B-47(R4)',
      title: 'shipment_id=None の 2 態目 — R4 blocker-2 でパラメタライズ追加',
      cells: { failure_phase: 'p7_capture', shipping_state: 'without_id' },
      addedBy: 'R4 blocker-2',
    },
    {
      b: 'B-48',
      title: 'shopping カート再作成済みの status 非復帰（E27c）',
      cells: { cart_recreated: 'yes' },
    },
  ],
}
