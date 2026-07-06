/**
 * modelx-cart-payment spec.md §2「正常系バリエーション」の状態モデル全訳。
 *
 * 出典: ec-replace/.dandori/specs/modelx-cart-payment/spec.md（fixed 2026-07-04）
 *
 * 転記時のモデリング判断（実験の考察対象）:
 * 1. §3（異常系マトリクス）と B-12〜B-31 は対象外。cart-payment.model.ts が
 *    正常系 B-1〜B-23 のみを転記した前例に倣い、本モデルも正常系 B-1〜B-11 に限定した
 * 2. modelx spec には cart-payment のような「軸間関係（直交性の宣言）」節が**存在しない**。
 *    そのため orthogonal / orthogonalGroups は全件「推定 — ユーザー未確認」。
 *    宣言が一件もないこと自体が cart-payment との非対称点
 * 3. 軸5「刺繍テキスト」（S11）は text_1 / product_type / text_2 の 3 独立軸に分解した。
 *    B-10 の Given が「text_1 空/値あり × 商品 Queen・King/その他 × text_2 空/値あり」と
 *    明示的にクロス積で書かれているため。ただし text_2 の出力は product_type=other のとき
 *    常に "" に強制される（入力値を無視）— これは軸間の直交でなく dependent 関係
 * 4. B-4（引き取りサービス）の PickupQuota 減算 3 ケース（同一 service_id 複数アイテム /
 *    複数 quota 行での PK 昇順選択 / 該当 quota 行なし）は §2 の S-table には現れず
 *    B-4 の Then 文中にのみ記述されている。§2 由来でない軸として pickup_quota_match を
 *    新設し、ref は S 番号でなく B-4 とした（cart-payment の「B行本文からの発見」を
 *    dependent で扱った先例と異なり、こちらは独立した値集合を持つため軸として分解した）
 * 5. シングルクォート除去（B-10 本文の付随記述）は独立シナリオを持たないため modifier
 * 6. coupon の employee（S3）は「有効クーポン」の下位区分（B-3 = B-2 + 追加条件）だが、
 *    相互排他な文字列としての性質は cart-payment の payment 軸（S1/S2 が同一軸のパラメタ
 *    ライズ関係）に近いと判断し、独立軸への分解はせず 1 軸 3 値で表現した
 */
import type { Model } from './model-types.ts'

export const model: Model = {
  axes: [
    {
      id: 'coupon',
      label: '軸1: クーポン',
      base: 'none',
      values: [
        { id: 'none' },
        { id: 'valid', ref: 'S2' },
        { id: 'employee', ref: 'S3', note: 'valid の下位区分（EMPLOYEE_COUPON_CODE）' },
      ],
    },
    {
      id: 'pickup_service',
      label: '軸2: 引き取りサービス（サービスアイテム）',
      base: 'no',
      values: [{ id: 'no' }, { id: 'yes', ref: 'S4' }],
    },
    {
      id: 'pickup_quota_match',
      label: '軸2修飾: PickupQuota 行の一致パターン（B-4 本文由来、§2 に非対応 S 番号なし）',
      base: 'single_item_single_quota',
      values: [
        { id: 'single_item_single_quota' },
        { id: 'multi_item_single_quota', note: '同一 service_id の複数アイテム行 — 同じ quota 行が複数回減る' },
        { id: 'multi_quota_pk_order', note: '同一 service_id の複数 PickupQuota 行 — PK 昇順の先頭行のみ減る' },
        { id: 'no_quota_row', note: '該当 quota 行なし — 黙ってスキップ（throw しない、R14）' },
      ],
    },
    {
      id: 'route',
      label: '軸3: route',
      base: 'absent',
      values: [{ id: 'absent' }, { id: 'empty', ref: 'S6' }, { id: 'present', ref: 'S5' }],
    },
    {
      id: 'monthly_stock',
      label: '軸4: 当月在庫レコード',
      base: 'normal',
      values: [
        { id: 'normal', note: 'S1 の暗黙の前提（レコードあり・十分な数）' },
        { id: 'absent', ref: 'S7' },
        { id: 'exactly_one', ref: 'S8' },
      ],
    },
    {
      id: 'delivery_date',
      label: '軸5: 配送希望日',
      base: 'normal',
      values: [
        { id: 'normal', note: 'S1 の暗黙の前提（範囲内の通常値）' },
        { id: 'boundary_low', ref: 'S9' },
        { id: 'boundary_high', ref: 'S9' },
      ],
    },
    {
      id: 'payment_3ds',
      label: '軸6: CardPay 3DS ステータス',
      base: 'verified',
      values: [{ id: 'verified', ref: 'S10' }, { id: 'attempted', ref: 'S10' }],
    },
    {
      id: 'embroidery_text_1',
      label: '軸7a: 刺繍テキスト1',
      base: 'empty',
      values: [{ id: 'empty', ref: 'S11' }, { id: 'value', ref: 'S11' }],
    },
    {
      id: 'product_type',
      label: '軸7b: 商品種別（刺繍テキスト2の有無を左右）',
      base: 'other',
      values: [{ id: 'other', ref: 'S11' }, { id: 'queen_king', ref: 'S11' }],
    },
    {
      id: 'embroidery_text_2',
      label: '軸7c: 刺繍テキスト2（product_type=other のとき出力は入力に関わらず強制 ""）',
      base: 'empty',
      values: [{ id: 'empty', ref: 'S11' }, { id: 'value', ref: 'S11' }],
    },
  ],

  observations: [],

  modifiers: [
    {
      id: 'quote_stripping',
      ref: 'B-10',
      affects: ['シート刺繍列（text_1, text_2）'],
      note: '刺繍テキストのシングルクォートは除去される。B-10 の Then に埋め込まれた付随記述で、独立シナリオを持たない',
    },
  ],

  // modelx spec には cart-payment のような「軸間関係の宣言」節が存在しない。
  // 以下はすべて spec 本文の記述（各シナリオが独立した検証・計算ステップであること）
  // からの推定裁定 — ユーザー未確認
  orthogonal: [
    { axes: ['embroidery_text_2', 'coupon'], reason: '推定 — ユーザー未確認: 刺繍テキストはシート出力のみに影響し他の検証・計算と独立', addedBy: '推定 — ユーザー未確認' },
    { axes: ['embroidery_text_2', 'pickup_service'], reason: '推定 — ユーザー未確認: 同上', addedBy: '推定 — ユーザー未確認' },
    { axes: ['embroidery_text_2', 'pickup_quota_match'], reason: '推定 — ユーザー未確認: 同上', addedBy: '推定 — ユーザー未確認' },
    { axes: ['embroidery_text_2', 'route'], reason: '推定 — ユーザー未確認: 同上', addedBy: '推定 — ユーザー未確認' },
    { axes: ['embroidery_text_2', 'monthly_stock'], reason: '推定 — ユーザー未確認: 同上', addedBy: '推定 — ユーザー未確認' },
    { axes: ['embroidery_text_2', 'delivery_date'], reason: '推定 — ユーザー未確認: 同上', addedBy: '推定 — ユーザー未確認' },
    { axes: ['embroidery_text_2', 'payment_3ds'], reason: '推定 — ユーザー未確認: 同上', addedBy: '推定 — ユーザー未確認' },
    { axes: ['embroidery_text_2', 'embroidery_text_1'], reason: '推定 — ユーザー未確認: text_1 と text_2 は別カラムで独立に決まる', addedBy: '推定 — ユーザー未確認' },
    { axes: ['pickup_quota_match', 'coupon'], reason: '推定 — ユーザー未確認: PickupQuota 減算はクーポン判定と別データ・別処理', addedBy: '推定 — ユーザー未確認' },
    { axes: ['pickup_quota_match', 'route'], reason: '推定 — ユーザー未確認: 同上', addedBy: '推定 — ユーザー未確認' },
    { axes: ['pickup_quota_match', 'monthly_stock'], reason: '推定 — ユーザー未確認: 同上（商品在庫と PickupQuota は別テーブル）', addedBy: '推定 — ユーザー未確認' },
    { axes: ['pickup_quota_match', 'delivery_date'], reason: '推定 — ユーザー未確認: 同上', addedBy: '推定 — ユーザー未確認' },
    { axes: ['pickup_quota_match', 'payment_3ds'], reason: '推定 — ユーザー未確認: 同上', addedBy: '推定 — ユーザー未確認' },
    { axes: ['pickup_quota_match', 'embroidery_text_1'], reason: '推定 — ユーザー未確認: 同上', addedBy: '推定 — ユーザー未確認' },
    { axes: ['pickup_quota_match', 'product_type'], reason: '推定 — ユーザー未確認: 同上', addedBy: '推定 — ユーザー未確認' },
  ],

  orthogonalGroups: [
    {
      group: [
        'coupon',
        'pickup_service',
        'route',
        'monthly_stock',
        'delivery_date',
        'payment_3ds',
        'embroidery_text_1',
        'product_type',
      ],
      reason: '推定 — ユーザー未確認: クーポン判定・サービスアイテム処理・route表示・在庫チェック・配送日検証・3DS判定・刺繍テキスト整形はそれぞれ他要素の入力に依存しない独立ステップと読める（spec 本文に明示の直交宣言なし）',
      addedBy: '推定 — ユーザー未確認',
    },
  ],

  dependent: [
    {
      cells: { product_type: 'other', embroidery_text_2: '*' },
      note: 'product_type=other のときシート text_2 は入力値によらず常に "" に強制される（S11 Then）。product_type=queen_king のときのみ text_2 は text_1 と同様の 空→"Model X" / 値あり→そのまま のルールに従う',
    },
    {
      cells: { pickup_service: 'yes', pickup_quota_match: '*' },
      note: 'pickup_quota_match は pickup_service=yes のときのみ観測可能な PickupQuota 減算パターン（B-4 本文）',
    },
  ],

  only: [
    {
      axis: 'pickup_quota_match',
      value: 'multi_item_single_quota',
      requires: { pickup_service: ['yes'] },
      note: 'PickupQuota 減算パターンは引き取りサービスがある注文でのみ発生',
    },
    {
      axis: 'pickup_quota_match',
      value: 'multi_quota_pk_order',
      requires: { pickup_service: ['yes'] },
      note: '同上',
    },
    {
      axis: 'pickup_quota_match',
      value: 'no_quota_row',
      requires: { pickup_service: ['yes'] },
      note: '同上',
    },
  ],

  chains: [],

  // 正常系 B 行（B-1〜B-11）の Covers 宣言。cells は基準シナリオからのデルタ
  covers: [
    { b: 'B-1', title: '最小注文の成功', cells: {} },
    { b: 'B-2', title: '有効クーポンで成功', cells: { coupon: 'valid' } },
    { b: 'B-3', title: '社割クーポンの追加 Slack 通知', cells: { coupon: 'employee' } },
    {
      b: 'B-4',
      title: '引き取りサービス付きで成功',
      cells: {
        pickup_service: 'yes',
        pickup_quota_match: [
          'single_item_single_quota',
          'multi_item_single_quota',
          'multi_quota_pk_order',
          'no_quota_row',
        ],
      },
    },
    { b: 'B-5', title: 'route の保存と表示', cells: { route: ['absent', 'empty', 'present'] } },
    { b: 'B-6', title: '当月在庫レコード不在時の自動作成', cells: { monthly_stock: 'absent' } },
    { b: 'B-7', title: '在庫切れ Slack 警告', cells: { monthly_stock: 'exactly_one' } },
    { b: 'B-8', title: '配送日境界の成功', cells: { delivery_date: ['boundary_low', 'boundary_high'] } },
    { b: 'B-9', title: '3DS ステータス 2 態の成功', cells: { payment_3ds: ['verified', 'attempted'] } },
    {
      b: 'B-10',
      title: '刺繍テキストのシート行反映',
      cells: {
        embroidery_text_1: ['empty', 'value'],
        product_type: ['other', 'queen_king'],
        embroidery_text_2: ['empty', 'value'],
      },
      extras: ['mod:quote_stripping'],
    },
    { b: 'B-11', title: 'シート行の全カラム（S1 詳細）', cells: {} },
  ],
}
