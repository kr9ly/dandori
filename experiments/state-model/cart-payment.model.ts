/**
 * cart-payment spec.md §2「正常系バリエーション」の状態モデル全訳。
 *
 * 出典: ec-replace/.dandori/specs/cart-payment/spec.md（fix 2026-07-04）
 *
 * 転記時のモデリング判断（実験の考察対象）:
 * 1. 軸2「割引」は排他 4 値でなく coupon / promo / fixed_discount の 3 軸に分解した。
 *    spec 自身が組成を認めている（B-6 の ERP フィルタが「プロモコードのみ・無割引」を
 *    独立ケースとして扱う、B-8 が「クーポンなし」を明記）ため、排他値では表現できない
 * 2. 軸5「付帯状態」は独立ブール 6 個の束であり排他軸ではない。route / order_no /
 *    pickup / similar_return / fraud の独立軸 + set_items（modifier）に分解した
 * 3. S14（在庫アラート）は observation、S22（セット商品）は modifier — spec の
 *    軸間関係の記述（「S14 は S11/S12 の観測」「S22 は修飾」）をそのまま種別語彙に写した
 * 4. wms 軸は B 行のパラメタライズ粒度（キャリアX/キャリアY、仮宛先成功/失敗）まで値を割った
 * 5. レビューラウンドで後から追加された要素は addedBy でマークした（バックテスト用）。
 *    出典: spec.md 内の R 番号注釈
 */
import type { Model } from './model-types.ts'

export const model: Model = {
  axes: [
    {
      id: 'payment',
      label: '軸1: 決済メソッド',
      base: 's1_card_3ds_verified',
      values: [
        { id: 's1_card_3ds_verified', ref: 'S1' },
        { id: 's2_card_3ds_attempted', ref: 'S2', note: 'S1 とパラメタライズ' },
        { id: 's3_applepay', ref: 'S3' },
        { id: 's4_wallet_now', ref: 'S4' },
        { id: 's5_wallet_pending', ref: 'S5' },
        { id: 's6_paidy', ref: 'S6' },
      ],
    },
    {
      id: 'coupon',
      label: '軸2a: クーポン',
      base: 'none',
      values: [
        { id: 'none' },
        { id: 'normal', ref: 'S7' },
        { id: 'employee', ref: 'S8' },
      ],
    },
    {
      id: 'promo',
      label: '軸2b: プロモーションコード',
      base: 'absent',
      values: [{ id: 'absent' }, { id: 'present', ref: 'S9' }],
    },
    {
      id: 'fixed_discount',
      label: '軸2c: 固定額割引',
      base: 'absent',
      values: [{ id: 'absent' }, { id: 'present', ref: 'S10' }],
    },
    {
      id: 'stock',
      label: '軸3: 在庫割り当て',
      base: 'received',
      perItem: true,
      values: [
        { id: 'received', ref: 'S11' },
        { id: 'reservable', ref: 'S12' },
      ],
    },
    {
      id: 'sheets_only',
      label: '軸3修飾: シーツのみ注文',
      base: 'no',
      values: [{ id: 'no' }, { id: 'yes', ref: 'S13' }],
    },
    {
      id: 'wms',
      label: '軸4: WMS 出庫',
      base: 's15_ok',
      values: [
        { id: 's15_ok', ref: 'S15' },
        { id: 's16_retry422_carrier_x', ref: 'S16' },
        { id: 's16_retry422_carrier_y', ref: 'S16' },
        {
          id: 's16_retry422_nomatch',
          ref: 'S16',
          note: '422 だが キャリアX/キャリアY文言に不一致 — 再送なしで仮宛先チェーン直行',
          addedBy: 'R12 major-1',
        },
        { id: 's17_maint503', ref: 'S17' },
        { id: 's18_temp_ok', ref: 'S18' },
        { id: 's18_temp_fail', ref: 'S18' },
      ],
    },
    {
      id: 'route',
      label: '軸5a: route',
      base: 'absent',
      values: [{ id: 'absent' }, { id: 'empty' }, { id: 'present', ref: 'S19' }],
    },
    {
      id: 'order_no',
      label: '軸5b: order_no 事前採番',
      base: 'fresh',
      values: [{ id: 'fresh' }, { id: 'preassigned', ref: 'S20' }],
    },
    {
      id: 'pickup',
      label: '軸5c: ピックアップサービス',
      base: 'no',
      values: [{ id: 'no' }, { id: 'yes', ref: 'S21' }],
    },
    {
      id: 'similar_return',
      label: '軸5d: 類似返品注文',
      base: 'no',
      values: [{ id: 'no' }, { id: 'yes', ref: 'S23' }],
    },
    {
      id: 'fraud',
      label: '軸5e: 不正注文疑い',
      base: 'no',
      values: [{ id: 'no' }, { id: 'yes', ref: 'S24' }],
    },
  ],

  observations: [
    {
      id: 'stock_alert',
      ref: 'S14',
      of: ['stock'],
      note: '在庫アラートは割り当てによる残数遷移の結果（軸間関係の宣言どおり）',
    },
  ],

  modifiers: [
    {
      id: 'set_items',
      ref: 'S22',
      affects: ['ERP 取引記録', '購入通知'],
      note: '単独シナリオでなく ERP・購入通知の商品リスト内容を変える',
    },
  ],

  // spec.md「軸間関係（直交性の宣言）」の完全直交ブロックの転記
  orthogonal: [
    { axes: ['wms', 'payment'], reason: '出庫結果は WMS レスポンスのみで決まる' },
    { axes: ['wms', 'coupon'], reason: '同上（軸4×軸2）' },
    { axes: ['wms', 'promo'], reason: '同上（軸4×軸2）' },
    { axes: ['wms', 'fixed_discount'], reason: '同上（軸4×軸2）' },
    { axes: ['similar_return', '*'], reason: '過去注文データのみに依存' },
    { axes: ['fraud', '*'], reason: '過去注文データのみに依存' },
    { axes: ['stock', 'payment'], reason: '軸3×軸1' },
    { axes: ['stock', 'coupon'], reason: '軸3×軸2' },
    { axes: ['stock', 'promo'], reason: '軸3×軸2' },
    { axes: ['stock', 'fixed_discount'], reason: '軸3×軸2' },

    // ---- 実験2: 未分類 30 ペアへの裁定案（ユーザー未確認 — spec 本文からの推定） ----
    { axes: ['route', '*'], reason: 'route は Cart.route 保存と購入通知表示のみ — 処理分岐に波及しない', addedBy: '実験2裁定案' },
    { axes: ['order_no', '*'], reason: '採番は注文確定書き込みのみ（payment との関係は only 制約で既分類）', addedBy: '実験2裁定案' },
    { axes: ['payment', 'promo'], reason: 'プロモ検証・表示は決済メソッド非依存', addedBy: '実験2裁定案' },
    { axes: ['payment', 'sheets_only'], reason: '倉庫選択は商品構成のみで決まる', addedBy: '実験2裁定案' },
    { axes: ['coupon', 'sheets_only'], reason: '割引は金額計算のみ — 倉庫選択に非関与', addedBy: '実験2裁定案' },
    { axes: ['promo', 'sheets_only'], reason: '同上', addedBy: '実験2裁定案' },
    { axes: ['fixed_discount', 'sheets_only'], reason: '同上', addedBy: '実験2裁定案' },
    { axes: ['pickup', 'stock'], reason: '無料ピックアップ在庫は商品在庫（ProductStock/ReservableStock）と別テーブル', addedBy: '実験2裁定案' },
    { axes: ['pickup', 'sheets_only'], reason: 'PickupItem は倉庫選択の only_has_sheets 判定対象外と推定', addedBy: '実験2裁定案' },
    { axes: ['pickup', 'promo'], reason: 'ERP はクーポン前提 — プロモ単独と PickupItem は交差しない', addedBy: '実験2裁定案' },
  ],

  orthogonalGroups: [
    {
      group: ['route', 'order_no', 'pickup'],
      reason: '付帯状態は互いに別のデータ・後処理を見る（相互干渉なし）',
      addedBy: '実験2裁定案',
    },
  ],

  // 「依存関係あり（交点を明示的にテストする）」ブロックの転記
  dependent: [
    {
      cells: { payment: 's5_wallet_pending', coupon: 'normal' },
      note: 'S5 pending は ERP スキップ（S7 と交差）',
    },
    {
      cells: { payment: 's5_wallet_pending', pickup: 'yes' },
      note: 'S5 pending はピックアップ案内メール送信なし（S21 と交差 — else 分岐内）',
    },
    {
      cells: { coupon: 'none', promo: 'present' },
      note: 'プロモ単独では ERP なし（S7 が ERP の前提）',
    },
    {
      cells: { sheets_only: 'yes', wms: '*' },
      note: 'S13 → 軸4: 倉庫選択が出庫依頼パラメータ（warehouse）に影響',
    },
    {
      cells: { fixed_discount: 'present', payment: '*' },
      note: 'S10 × 軸1: check_apply_fixed_discount は method を入力に取る',
    },
    {
      cells: { wms: ['s16_retry422_carrier_x', 's16_retry422_carrier_y'], stock: '*' },
      note: 'S16 × 軸3: delivery_time リセット対象は fixed_carrier_id 有無で決まる',
    },

    // ---- 実験2: 分類作業の中で発見された真の依存（B-6 の Then に散文で埋没していたもの） ----
    {
      cells: { coupon: 'normal', fixed_discount: 'present' },
      note: 'B-6(3): 固定額割引は ERP ペイロードでクーポン割引対象リストの最初の 1 商品にのみ加算',
      addedBy: '実験2裁定案',
    },
    {
      cells: { coupon: 'normal', promo: 'present' },
      note: 'B-6(2): プロモコードのみ割引の商品は ERP 商品リストから除外',
      addedBy: '実験2裁定案',
    },
    {
      cells: { coupon: 'normal', pickup: 'yes' },
      note: 'B-6: ERP amount = total − carriage − service_amount（service_amount は PickupItem 由来）',
      addedBy: '実験2裁定案',
    },
    {
      cells: { sheets_only: 'yes', stock: '*' },
      note: '倉庫サイド選択（W/E）の中で在庫走査が行われる — B-10 の Then 記述より',
      addedBy: '実験2裁定案',
    },
  ],

  only: [
    {
      axis: 'order_no',
      value: 'preassigned',
      requires: { payment: ['s4_wallet_now', 's5_wallet_pending'] },
      note: 'S20 → S4/S5 限定: order_no 事前採番は Wallet Pay フローでのみ発生',
    },
  ],

  chains: [
    {
      from: 's16_retry422_carrier_x',
      to: 's18_temp_ok/s18_temp_fail',
      note: '422 再送がさらに失敗すると仮宛先チェーンへ続落（お詫びメール + リセット実行済みのまま複合）',
      addedBy: 'R1 major-2',
    },
    {
      from: 's16_retry422_carrier_y',
      to: 's18_temp_ok/s18_temp_fail',
      note: '同上',
      addedBy: 'R1 major-2',
    },
  ],

  // 正常系 B 行（B-1〜B-23）の Covers 宣言。cells は基準シナリオからのデルタ
  covers: [
    { b: 'B-1', title: 'card 決済成功・3DS 2態', cells: { payment: ['s1_card_3ds_verified', 's2_card_3ds_attempted'] } },
    { b: 'B-2', title: 'applepay 決済成功', cells: { payment: 's3_applepay' } },
    { b: 'B-3', title: 'wallet_pay 即時請求成功', cells: { payment: 's4_wallet_now' } },
    { b: 'B-4', title: 'wallet_pay 与信 pending', cells: { payment: 's5_wallet_pending' } },
    { b: 'B-5', title: 'paidy 決済成功', cells: { payment: 's6_paidy' } },
    { b: 'B-6', title: 'クーポン付き注文と ERP 連携', cells: { coupon: 'normal' } },
    { b: 'B-7', title: '社割クーポン通知', cells: { coupon: 'employee' } },
    { b: 'B-8', title: 'プロモーションコード付き注文', cells: { coupon: 'none', promo: 'present' } },
    { b: 'B-9', title: '固定額割引の通過', cells: { fixed_discount: 'present' } },
    { b: 'B-10', title: 'received_stock 割り当て', cells: { stock: 'received' } },
    { b: 'B-11', title: 'reservable_stock 割り当て', cells: { stock: 'reservable' } },
    { b: 'B-12', title: 'シーツのみ注文の関西倉庫優先', cells: { sheets_only: 'yes' } },
    { b: 'B-13', title: '在庫アラート 3 形態', cells: {}, extras: ['obs:stock_alert'] },
    { b: 'B-14', title: 'WMS 出庫成功', cells: { wms: 's15_ok' } },
    { b: 'B-15', title: '422 時間帯指定不可の再送', cells: { wms: ['s16_retry422_carrier_x', 's16_retry422_carrier_y'] } },
    { b: 'B-16', title: '503 メンテナンス時の出庫保留', cells: { wms: 's17_maint503' } },
    {
      b: 'B-17',
      title: '仮宛先フォールバック',
      cells: { wms: ['s18_temp_ok', 's18_temp_fail', 's16_retry422_nomatch'] },
      // fix 時点の B-17 は s18 2態のみ。nomatch 値と chain カバーは後の
      // レビューで拡張された — 値/連鎖側の addedBy により fix モードで自動的に剥がれる
      extras: ['chain:s16_retry422_carrier_x', 'chain:s16_retry422_carrier_y'],
    },
    { b: 'B-18', title: 'route の保存と表示', cells: { route: ['absent', 'empty', 'present'] } },
    { b: 'B-19', title: 'order_no の採番と保持', cells: { order_no: ['fresh', 'preassigned'] } },
    { b: 'B-20', title: 'ピックアップサービス付き注文', cells: { pickup: 'yes' } },
    { b: 'B-21', title: 'セット商品付属品の除外', cells: {}, extras: ['mod:set_items'] },
    { b: 'B-22', title: '類似返品注文の通知', cells: { similar_return: 'yes' } },
    { b: 'B-23', title: '不正注文アラート', cells: { fraud: 'yes' } },
  ],
}
