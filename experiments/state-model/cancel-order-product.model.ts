/**
 * cancel-order-product spec.md の状態モデル全訳。
 *
 * 出典: ec-replace/.dandori/specs/cancel-order-product/spec.md（fixed 2026-07-06）
 *
 * この spec は §2/§3 の軸セクションを持たず、認証検証 → 対象商品検証 → WMS 同期チェック →
 * 返金 → WMS 出庫キャンセル → カート更新・後続処理 → レスポンス、という処理フェーズ構造で
 * B-1〜B-42 が並ぶ。軸は B 行の Given から逆算して構築した（作業感は報告の摩擦メモ参照）。
 *
 * 転記時のモデリング判断:
 * 1. 認証・対象商品検証・WMS 同期チェックの早期リターン系（B-1〜B-7, B-10〜B-14, B-39,
 *    B-39注記）は cart-payment-rollback.model.ts の failure_phase 型を踏襲し、単一の
 *    排他軸 gate_error に統合した。B-39/B-39注記は「WMS障害×null混在」「全null」という
 *    複合条件だが、結果はいずれも単一エラーコードの排他状態なので gate_error の値として
 *    追加した（2軸に分解すると存在しない組み合わせ（例: 通常失敗+全null同時）を許してしまう）
 * 2. B-15（WMS/EC 双方 shipped で通過）は gate_error='none' のサブケースだが、B-14 と対を
 *    なす明示的な B 行のため独立軸 wms_status_shipped_pair を切って観測可能にした
 * 3. B-8（存在しない ID の無視）は挙動を変えない静かなフィルタなので modifier とした
 * 4. B-37（空/全無効リスト）は全フェーズを素通りする境界条件。orthogonal '*' 宣言をしたが、
 *    実際には後続フェーズの「実行はされるが対象0件」という弱い意味の直交であり、cart-payment
 *    の各軸間関係ほど厳密ではない（摩擦メモ参照）
 * 5. 決済メソッド軸は返金フェーズ専用（B-17〜B-21）。wallet_pay は pending 全額/一部/非pending
 *    の3値に分解した（cart-payment の payment 軸と同じ粒度）
 * 6. WMS 出庫キャンセルフェーズは商品サイズ（大型/小型）で処理系統が分岐するため product_size
 *    を per-item 軸にし、大型側 dedup（B-38）・小型側 scope（B-24/B-25）・小型側の WMS 状態
 *    （B-26）・cancel_type（B-27）をそれぞれ子軸として分離した
 * 7. B-40/B-42（findRemainingShipmentItems の ProductInfo 検索）は小型・一部キャンセル時
 *    のみ到達するため product_info_lookup に only 制約を付けた
 * 8. B-16（返金は送料込み）・B-29（DB は WMS 失敗の影響を受けない）・B-30（カート再計算）は
 *    特定軸の値でなく「実行されれば常に成り立つ」不変条件のため observations に分類した
 */
import type { Model } from './model-types.ts'

export const model: Model = {
  axes: [
    {
      id: 'gate_error',
      label: '検証ゲート・WMS同期チェックの早期リターン（フェーズ構造から逆算）',
      base: 'none',
      values: [
        { id: 'none' },
        { id: 'token_forbidden', ref: 'B-1' },
        { id: 'token_invalid', ref: 'B-2' },
        { id: 'order_number_missing', ref: 'B-3' },
        { id: 'cart_not_found', ref: 'B-4' },
        { id: 'pk_list_not_array', ref: 'B-5' },
        { id: 'other_cart_product', ref: 'B-6' },
        { id: 'set_accessory_direct', ref: 'B-7' },
        { id: 'already_canceled', ref: 'B-10' },
        { id: 'wms_bulk_fetch_fail', ref: 'B-11' },
        { id: 'wms_not_in_response', ref: 'B-12' },
        { id: 'wms_shipment_id_null', ref: 'B-13' },
        { id: 'wms_status_mismatch', ref: 'B-14' },
        { id: 'wms_fail_mixed_with_null', ref: 'B-39', note: 'WMS障害(404以外の非200)とnull/欠落shipment_idが混在 → 9003優先' },
        { id: 'wms_shipment_id_all_null', ref: 'B-39', note: '対象全件がshipment_id null → WMS API を呼ばず直接4003（裁定済み非互換）' },
      ],
    },
    {
      id: 'wms_status_shipped_pair',
      label: 'WMS/EC 双方 shipped の通過ケース（B-14 の対）',
      base: 'not_applicable',
      values: [{ id: 'not_applicable' }, { id: 'both_shipped', ref: 'B-15' }],
    },
    {
      id: 'target_composition',
      label: '対象商品の構成（gate通過後）',
      base: 'single_normal',
      values: [{ id: 'single_normal' }, { id: 'via_set_parent', ref: 'B-9' }],
    },
    {
      id: 'request_size',
      label: 'product_pk_list のサイズ',
      base: 'normal',
      values: [{ id: 'normal' }, { id: 'empty_or_all_invalid', ref: 'B-37' }],
    },
    {
      id: 'payment_method',
      label: '決済メソッド（返金フェーズ）',
      base: 'card_applepay',
      values: [
        { id: 'card_applepay', ref: 'B-17' },
        { id: 'wallet_pending_full', ref: 'B-18' },
        { id: 'wallet_pending_partial', ref: 'B-19' },
        { id: 'wallet_nonpending', ref: 'B-20' },
        { id: 'smartpay_paidy', ref: 'B-21' },
      ],
    },
    {
      id: 'refund_result',
      label: '返金 API の結果',
      base: 'success',
      values: [{ id: 'success' }, { id: 'fail', ref: 'B-22' }],
    },
    {
      id: 'product_size',
      label: '対象商品のサイズ区分（WMS出庫キャンセル処理系統）',
      perItem: true,
      base: 'small',
      values: [{ id: 'large', ref: 'B-23' }, { id: 'small', ref: 'B-24' }],
    },
    {
      id: 'large_dedup',
      label: '大型商品の同一shipment_id重複',
      base: 'unique',
      values: [{ id: 'unique' }, { id: 'duplicate_shipment_id', ref: 'B-38' }],
    },
    {
      id: 'small_scope',
      label: '小型商品の出庫内キャンセル範囲',
      base: 'full_cancel',
      values: [{ id: 'full_cancel', ref: 'B-24' }, { id: 'partial_remaining', ref: 'B-25' }],
    },
    {
      id: 'small_wms_status',
      label: '一部キャンセル時のWMS出庫ステータス',
      base: 'updatable',
      values: [{ id: 'updatable', note: 'waiting/suspended/backordered' }, { id: 'not_updatable', ref: 'B-26' }],
    },
    {
      id: 'wms_cancel_type',
      label: 'cancel_shipping の取消タイプ',
      base: 'delete',
      values: [{ id: 'delete' }, { id: 'delete_request', ref: 'B-27' }],
    },
    {
      id: 'wms_cancel_outcome',
      label: 'WMS出庫キャンセル/更新の全体結果（部分失敗許容ゾーン）',
      base: 'all_success',
      values: [{ id: 'all_success' }, { id: 'some_fail', ref: 'B-28' }],
    },
    {
      id: 'product_info_lookup',
      label: '残存商品のProductInfo検索結果（findRemainingShipmentItems）',
      base: 'found_single',
      values: [
        { id: 'found_single' },
        { id: 'not_found', ref: 'B-40' },
        { id: 'found_multiple', ref: 'B-42' },
      ],
    },
    {
      id: 'cart_after_state',
      label: 'キャンセル確定後のカート残存状態',
      base: 'partial_remaining',
      values: [{ id: 'partial_remaining' }, { id: 'all_canceled', ref: 'B-31' }],
    },
    {
      id: 'coupon',
      label: 'クーポン状態（ERP連携フェーズ）',
      base: 'none',
      values: [
        { id: 'none' },
        { id: 'present_valid', ref: 'B-34' },
        { id: 'present_pending', ref: 'B-35', note: 'WalletPay与信pending注文' },
        { id: 'present_missing_detail', ref: 'B-41' },
      ],
    },
    {
      id: 'mail',
      label: 'user_info.mail の有無',
      base: 'present',
      values: [{ id: 'present' }, { id: 'null', ref: 'B-33' }],
    },
  ],

  observations: [
    { id: 'refund_shipping_included', ref: 'B-16', of: ['refund_result'], note: '返金額は送料差額込み — refund実行があれば常に成立する不変条件' },
    { id: 'db_commit_despite_wms_fail', ref: 'B-29', of: ['wms_cancel_outcome'], note: 'WMS失敗はDB状態に影響しない — B-28と同一シナリオの別側面' },
    { id: 'cart_recalc', ref: 'B-30', of: ['gate_error'], note: 'キャンセル確定後は常にカート金額が再計算される' },
  ],

  modifiers: [
    { id: 'nonexistent_id_present', ref: 'B-8', affects: ['対象商品フィルタ'], note: 'DB非存在IDはfilter空振りで無視。挙動を変えない静かな修飾' },
  ],

  orthogonal: [
    { axes: ['payment_method', 'product_size'], reason: '返金フェーズと出庫キャンセルフェーズは別の対象データを見る' },
    { axes: ['payment_method', 'coupon'], reason: '決済メソッドとクーポン判定は独立' },
    { axes: ['product_size', 'coupon'], reason: '出庫系統とERP連携は独立フェーズ' },
    { axes: ['mail', '*'], reason: 'メール送信はキャンセル確定後の並列副作用 — 他フェーズの分岐に影響しない（推定 — ユーザー未確認）' },
    { axes: ['wms_status_shipped_pair', 'payment_method'], reason: 'WMS同期チェックは返金フェーズより前に完結する' },
    { axes: ['request_size', '*'], reason: 'B-37: 空/全無効リストは対象0件で全フェーズを素通りする（推定 — ユーザー未確認。弱い直交 — 摩擦メモ参照）' },
  ],

  orthogonalGroups: [],

  dependent: [
    {
      cells: { gate_error: 'set_accessory_direct', target_composition: 'via_set_parent' },
      note: 'B-7注記: セット親と付属品を同時指定しても付属品側検査が無条件優先し27000（B-7 が B-9 に優先）',
    },
    {
      cells: { coupon: 'present_pending', payment_method: ['wallet_pending_full', 'wallet_pending_partial'] },
      note: 'B-35: pending注文はクーポン有無に関わらずERPスキップ — coupon=present_pending は wallet pending 系でのみ意味を持つ',
    },
    {
      cells: { product_size: 'small', small_scope: 'partial_remaining', product_info_lookup: ['not_found', 'found_multiple'] },
      note: 'B-40/B-42: ProductInfo検索の異常系は小型・一部キャンセル時のfindRemainingShipmentItems内でのみ到達する',
    },
  ],

  only: [
    {
      axis: 'wms_status_shipped_pair',
      value: 'both_shipped',
      requires: { gate_error: ['none'] },
      note: 'B-15はgate_error=noneのサブケース（同期チェック通過後の状態）',
    },
    {
      axis: 'target_composition',
      value: 'via_set_parent',
      requires: { gate_error: ['none', 'set_accessory_direct'] },
      note: 'B-9はgate通過が前提。set_accessory_directとの交点はB-7優先の dependent 参照',
    },
    {
      axis: 'payment_method',
      value: '*',
      requires: { gate_error: ['none'] },
      note: '返金フェーズはgate通過後のみ到達する',
    },
    {
      axis: 'refund_result',
      value: '*',
      requires: { gate_error: ['none'] },
      note: '同上',
    },
    {
      axis: 'product_size',
      value: '*',
      requires: { refund_result: ['success'] },
      note: 'B-22: 返金失敗はWMS出庫キャンセルフェーズ到達前に処理を中断する',
    },
    {
      axis: 'large_dedup',
      value: 'duplicate_shipment_id',
      requires: { product_size: ['large'] },
      note: 'B-38は大型商品限定の重複挙動',
    },
    {
      axis: 'small_scope',
      value: '*',
      requires: { product_size: ['small'] },
      note: '出庫内スコープ判定は小型商品限定',
    },
    {
      axis: 'small_wms_status',
      value: 'not_updatable',
      requires: { small_scope: ['partial_remaining'] },
      note: 'B-26は一部キャンセル時のみ意味を持つ判定',
    },
    {
      axis: 'product_info_lookup',
      value: ['not_found', 'found_multiple'],
      requires: { small_scope: ['partial_remaining'] },
      note: '残存商品のProductInfo検索は一部キャンセル時のみ実行される',
    },
    {
      axis: 'coupon',
      value: 'present_valid',
      requires: { gate_error: ['none'] },
      note: 'ERP連携フェーズは後続処理 — gate通過が前提',
    },
  ],

  chains: [],

  covers: [
    { b: 'B-1', title: 'トークン権限エラー', cells: { gate_error: 'token_forbidden' } },
    { b: 'B-2', title: 'トークン不正', cells: { gate_error: 'token_invalid' } },
    { b: 'B-3', title: 'order_number 欠落・空文字', cells: { gate_error: 'order_number_missing' } },
    { b: 'B-4', title: '対象カート不在', cells: { gate_error: 'cart_not_found' } },
    { b: 'B-5', title: 'product_pk_list が非配列', cells: { gate_error: 'pk_list_not_array' } },
    { b: 'B-6', title: '他カートの商品を指定', cells: { gate_error: 'other_cart_product' } },
    { b: 'B-7', title: 'セット付属品を直接指定', cells: { gate_error: 'set_accessory_direct' } },
    { b: 'B-8', title: '存在しない商品IDはサイレント無視', cells: {}, extras: ['mod:nonexistent_id_present'] },
    { b: 'B-9', title: 'セット親指定で付属品も対象化', cells: { target_composition: 'via_set_parent' } },
    { b: 'B-10', title: 'キャンセル済み商品を再指定', cells: { gate_error: 'already_canceled' } },
    { b: 'B-11', title: 'WMS出庫一覧取得失敗', cells: { gate_error: 'wms_bulk_fetch_fail' } },
    { b: 'B-12', title: '対象出庫がWMSレスポンスに存在しない', cells: { gate_error: 'wms_not_in_response' } },
    { b: 'B-13', title: 'shipment_idがnullの対象を含む', cells: { gate_error: 'wms_shipment_id_null' } },
    { b: 'B-14', title: 'WMS/ECステータス不整合', cells: { gate_error: 'wms_status_mismatch' } },
    { b: 'B-15', title: 'WMS=shipped かつ EC=shipped は通過', cells: { wms_status_shipped_pair: 'both_shipped' } },
    { b: 'B-16', title: '返金額は送料込み', cells: {}, extras: ['obs:refund_shipping_included'] },
    { b: 'B-17', title: 'CardPay / ApplePay の返金', cells: { payment_method: 'card_applepay' } },
    { b: 'B-18', title: 'WalletPay与信pending + 全額キャンセル', cells: { payment_method: 'wallet_pending_full' } },
    { b: 'B-19', title: 'WalletPay与信pending + 一部キャンセル', cells: { payment_method: 'wallet_pending_partial' } },
    { b: 'B-20', title: 'WalletPay非pendingの返金', cells: { payment_method: 'wallet_nonpending' } },
    { b: 'B-21', title: 'Smartpay / Paidy の返金', cells: { payment_method: 'smartpay_paidy' } },
    { b: 'B-22', title: '返金失敗で処理中断', cells: { refund_result: 'fail' } },
    { b: 'B-23', title: '大型商品の出庫取消', cells: { product_size: 'large' } },
    { b: 'B-24', title: '小型商品・出庫内全キャンセル', cells: { product_size: 'small', small_scope: 'full_cancel' } },
    { b: 'B-25', title: '小型商品・出庫内一部キャンセル', cells: { product_size: 'small', small_scope: 'partial_remaining' } },
    { b: 'B-26', title: '一部キャンセルはWMS状態がwaiting/suspended/backorderedのみ成功', cells: { small_scope: 'partial_remaining', small_wms_status: 'not_updatable' } },
    { b: 'B-27', title: '取消タイプdelete_requestは未確定キャンセル', cells: { wms_cancel_type: 'delete_request' } },
    { b: 'B-28', title: 'WMSキャンセル失敗のSlack通知', cells: { wms_cancel_outcome: 'some_fail' } },
    { b: 'B-29', title: 'WMS失敗でもDBはcancel確定', cells: { wms_cancel_outcome: 'some_fail' }, extras: ['obs:db_commit_despite_wms_fail'] },
    { b: 'B-30', title: 'カート金額の再計算', cells: {}, extras: ['obs:cart_recalc'] },
    { b: 'B-31', title: '全商品キャンセルでカートもcancel', cells: { cart_after_state: 'all_canceled' } },
    { b: 'B-32', title: 'キャンセルメール送信', cells: { mail: 'present' } },
    { b: 'B-33', title: 'mail nullはメールスキップ', cells: { mail: 'null' } },
    { b: 'B-34', title: 'ERP取引記録（クーポンありのみ）', cells: { coupon: 'present_valid' } },
    { b: 'B-35', title: 'クーポンなし・pending注文はERPスキップ', cells: { coupon: ['none', 'present_pending'] } },
    { b: 'B-36', title: '正常終了レスポンス', cells: {} },
    { b: 'B-37', title: '空product_pk_listは正常終了', cells: { request_size: 'empty_or_all_invalid' } },
    { b: 'B-38', title: '大型商品の同一shipment_id重複呼び出し', cells: { large_dedup: 'duplicate_shipment_id' } },
    { b: 'B-39', title: 'WMS障害とnull/欠落shipment_idの同時発生は9003優先', cells: { gate_error: 'wms_fail_mixed_with_null' } },
    { b: 'B-39(注記)', title: '対象全件shipment_id nullは直接4003', cells: { gate_error: 'wms_shipment_id_all_null' } },
    { b: 'B-40', title: '残存商品のProductInfo未検出はthrow', cells: { product_info_lookup: 'not_found' } },
    { b: 'B-41', title: 'クーポン詳細不在はERPスキップ', cells: { coupon: 'present_missing_detail' } },
    { b: 'B-42', title: 'ProductInfo複数一致はpk昇順first', cells: { product_info_lookup: 'found_multiple' } },
  ],
}
