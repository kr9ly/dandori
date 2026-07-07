/**
 * offline-store-order spec.md §2「正常系バリエーション」+ B-31〜B-41（レビュー末尾追加）の状態モデル全訳。
 *
 * 出典: ec-replace/.dandori/specs/offline-store-order/spec.md（fix 2026-07-05）
 *
 * 転記時のモデリング判断（実験の考察対象）:
 * 1. 軸A（WMS 出庫応答）は cart-payment 同様、正常系（200/503）と異常系
 *    （422×2社/その他エラー/422応答自体の欠陥）を同一軸に混在させた。フェーズ8の
 *    if/elif 完全排他（spec 記載）に対応する単一の状態空間だから
 * 2. 軸C（在庫割当）に "allocation_failed"（B-23, フェーズ7再確認失敗）を追加した。
 *    B-36 の非整数割引 parameterize が「在庫割当失敗時は1014優先」を明示するため、
 *    正常系2値だけでは依存交点を表現できない
 * 3. 軸B（商品構成）と B-ax4（数量）・B-ax5（セット）は spec の宣言通り独立軸に分解した
 *    （cart-payment の判断1を踏襲）。quantity・stock は perItem: true
 * 4. B-31〜B-41 はレビューラウンドで発掘された単発のバグ再現テストで、spec 本文が他軸との
 *    関係を論じていない。各々を独立軸として立て、他軸との関係は「推定 — ユーザー未確認」を
 *    付けた orthogonal '*' 宣言で埋めた
 * 5. B-28（bulk 応答の shipment 欠落）は wms 軸の値でなく別軸にした。200 応答の中身の
 *    構造欠陥であり「どの応答コードか」とは独立した観測点のため。ただし意味を持つのは
 *    a1_success の時だけなので only 制約で従属関係を明示した
 * 6. composition × delivery_pref の依存宣言は「個別配送の商品同士が異なる日付を持てる」
 *    という spec の主張を厳密には検査できない（delivery_pref が order レベルの軸で
 *    per-item の日付差異を表現できないため）。摩擦メモに記載
 */
import type { Model } from './model-types.ts'

export const model: Model = {
  axes: [
    {
      id: 'wms',
      label: '軸A: WMS 出庫依頼応答',
      base: 'a1_success',
      values: [
        { id: 'a1_success', ref: 'B-1' },
        { id: 'a2_maintenance', ref: 'B-2' },
        { id: 'a3_422_carrier_x', ref: 'B-24' },
        { id: 'a3_422_carrier_y', ref: 'B-24' },
        { id: 'a4_other_error', ref: 'B-25' },
        { id: 'a5_422_malformed', ref: 'B-37', addedBy: 'R6' },
      ],
    },
    {
      id: 'composition',
      label: '軸B: 商品構成',
      base: 'bundled_only',
      values: [
        { id: 'bundled_only', ref: 'B-1' },
        { id: 'individual_only', ref: 'B-3' },
        { id: 'mixed', ref: 'B-4' },
      ],
    },
    {
      id: 'quantity',
      label: '軸B-ax4: 数量',
      base: 'single',
      perItem: true,
      values: [{ id: 'single' }, { id: 'multi', ref: 'B-5' }],
    },
    {
      id: 'set_item',
      label: '軸B-ax5: セット商品展開',
      base: 'absent',
      values: [{ id: 'absent' }, { id: 'present', ref: 'B-6' }],
    },
    {
      id: 'stock',
      label: '軸C: 在庫割当',
      base: 'product_stock',
      perItem: true,
      values: [
        { id: 'product_stock', ref: 'B-1' },
        { id: 'reservable_stock', ref: 'B-7' },
        { id: 'allocation_failed', ref: 'B-23', note: 'フェーズ7再確認での割当不能' },
      ],
    },
    {
      id: 'sale',
      label: '軸D: セール',
      base: 'none',
      values: [
        { id: 'none', ref: 'B-1' },
        { id: 'integer_discount', ref: 'B-8' },
        { id: 'noninteger_discount', ref: 'B-36', addedBy: 'R6' },
      ],
    },
    {
      id: 'delivery_pref',
      label: '軸E: 配送希望',
      base: 'date_and_time',
      values: [
        { id: 'date_and_time', ref: 'B-1' },
        { id: 'both_empty', ref: 'B-9' },
        { id: 'date_only', ref: 'B-10' },
      ],
    },
    {
      id: 'similar_return',
      label: '軸F: 類似返品注文（後処理）',
      base: 'none',
      values: [
        { id: 'none', ref: 'B-1' },
        { id: 'present', ref: 'B-11' },
        { id: 'mail_null_match', ref: 'B-33', note: 'mail IS NULL 無条件マッチによる偽陽性', addedBy: 'R3' },
      ],
    },
    {
      id: 'warehouse_side',
      label: '軸(追加): 配送先都道府県の倉庫優先方向',
      base: 'west',
      values: [
        { id: 'west', note: '基準シナリオは地域未指定 — west を暫定 base とした（摩擦メモ参照）' },
        { id: 'east', ref: 'B-31', addedBy: 'R10' },
      ],
    },
    {
      id: 'individual_layer_asymmetry',
      label: '軸(追加): individual 判定の層間非対称',
      base: 'absent',
      values: [{ id: 'absent' }, { id: 'present', ref: 'B-34', addedBy: 'R3' }],
    },
    {
      id: 'individual_source_asymmetry',
      label: '軸(追加): individual 判定ソースの非対称（フェーズ2 vs フェーズ5）',
      base: 'absent',
      values: [{ id: 'absent' }, { id: 'present', ref: 'B-38', addedBy: 'R11' }],
    },
    {
      id: 'post_express',
      label: '軸(追加): ポスト便到達性退化',
      base: 'absent',
      values: [{ id: 'absent' }, { id: 'present', ref: 'B-35', addedBy: 'R5' }],
    },
    {
      id: 'postal_format',
      label: '軸(追加): 郵便番号表記',
      base: 'plain',
      values: [{ id: 'plain' }, { id: 'hyphenated', ref: 'B-41', addedBy: 'R21' }],
    },
    {
      id: 'bulk_shipment_integrity',
      label: '軸(追加): bulk 応答の shipment 構造完全性',
      base: 'ok',
      values: [{ id: 'ok' }, { id: 'shipment_missing', ref: 'B-28', addedBy: 'R4' }],
    },
  ],

  observations: [],
  modifiers: [],

  orthogonal: [
    { axes: ['wms', 'composition'], reason: '出庫応答は商品構成に依存しない（spec A×B/C/D/E 直交宣言）' },
    { axes: ['wms', 'stock'], reason: '同上（A×C）' },
    { axes: ['wms', 'sale'], reason: '同上（A×D）' },
    { axes: ['wms', 'delivery_pref'], reason: '同上（A×E）' },
    { axes: ['composition', 'stock'], reason: '商品単位で独立 — 混在が成立する（spec B×C 宣言）' },
    { axes: ['stock', 'delivery_pref'], reason: '在庫割当と配送希望チェックは別処理フェーズ（フェーズ5→フェーズ7）— 明示的な交差記述なし（推定 — ユーザー未確認）', addedBy: '推定裁定' },
    { axes: ['sale', '*'], reason: 'D: 金額計算にのみ影響 — 他軸と直交（spec 軸間関係）' },
    { axes: ['similar_return', '*'], reason: 'F: 全軸と直交 — 後処理は注文確定後の横断関心事（spec 軸間関係）' },
    { axes: ['quantity', '*'], reason: '数量分割は他フェーズの分岐条件を変えないと推定（推定 — ユーザー未確認）', addedBy: '推定裁定' },
    { axes: ['set_item', '*'], reason: 'セット展開は付属品マスタのみに依存 — stock/quantity 以外との交差記述なし（推定 — ユーザー未確認）', addedBy: '推定裁定' },
    { axes: ['warehouse_side', '*'], reason: '都道府県は配送先住所由来で他軸と無関係に決まる（推定 — ユーザー未確認）', addedBy: '推定裁定' },
    { axes: ['individual_layer_asymmetry', '*'], reason: '単発の層間非対称バグ再現 — 他軸との交差記述なし（推定 — ユーザー未確認）', addedBy: '推定裁定' },
    { axes: ['individual_source_asymmetry', '*'], reason: '単発の判定ソース非対称バグ再現 — 他軸との交差記述なし（推定 — ユーザー未確認）', addedBy: '推定裁定' },
    { axes: ['post_express', '*'], reason: '単発の到達性退化バグ再現 — 他軸との交差記述なし（推定 — ユーザー未確認）', addedBy: '推定裁定' },
    { axes: ['postal_format', '*'], reason: '正規化後は他処理と無関係（推定 — ユーザー未確認）', addedBy: '推定裁定' },
    { axes: ['bulk_shipment_integrity', '*'], reason: 'bulk 応答構造チェックは応答コード分類と別観測点 — wms との関係は only 制約で別途宣言', addedBy: '推定裁定' },
  ],

  orthogonalGroups: [],

  dependent: [
    {
      cells: { set_item: 'present', stock: '*' },
      note: 'B-6: 付属品の在庫確認・減算キーは original_product_info（元商品）— stock のどちらの値でも成立',
    },
    {
      cells: { quantity: 'multi', set_item: 'present' },
      note: 'B-32: quantity≥2 × セット展開で set_parent_product の誤リンクが発生（旧実装バグ忠実再現）',
      addedBy: 'R1',
    },
    {
      cells: { composition: 'mixed', delivery_pref: 'date_and_time' },
      note: '同梱商品は全て同一 delivery_date 必須・individual は商品ごとに異なる delivery_date 可（spec B×E）。' +
        'B-4 は同梱と individual が同一日のケースのみ — 「individual 同士が異なる日付を持つ」交点は本モデルでは表現できない（摩擦メモ参照）',
    },
    {
      cells: { sale: 'noninteger_discount', stock: 'allocation_failed' },
      note: 'B-36 parameterize: 非整数割引 × 在庫割当失敗 → 1014 優先（金額計算未到達）',
      addedBy: 'R6',
    },
    {
      cells: { sale: 'noninteger_discount', wms: ['a3_422_carrier_x', 'a3_422_carrier_y'] },
      note: 'B-36 parameterize: 非整数割引 × WMS 422 → 1015 優先',
      addedBy: 'R6',
    },
    {
      cells: { sale: 'noninteger_discount', wms: 'a4_other_error' },
      note: 'B-36 parameterize: 非整数割引 × WMS 非200非503 → 1009 優先',
      addedBy: 'R6',
    },
    {
      cells: { sale: 'noninteger_discount', wms: 'a2_maintenance' },
      note: 'B-36 parameterize: 非整数割引 × WMS 503 → throw（旧実装も金額計算に到達し500）',
      addedBy: 'R6',
    },
    {
      cells: { warehouse_side: 'east', stock: '*' },
      note: 'B-31: 都道府県により優先倉庫リストが変わり在庫割当対象倉庫が変わる',
      addedBy: 'R10',
    },
  ],

  only: [
    {
      axis: 'bulk_shipment_integrity',
      value: 'shipment_missing',
      requires: { wms: ['a1_success'] },
      note: 'B-28: shipment 欠落チェックは 200 応答経路でのみ意味を持つ（422/503/other は phase8 の別分岐で先に終端する）',
    },
  ],

  chains: [],

  covers: [
    { b: 'B-1', title: '基準シナリオ — 同梱商品1点の注文成功', cells: {} },
    { b: 'B-2', title: 'WMS 503 メンテナンス — 購入続行', cells: { wms: 'a2_maintenance' } },
    { b: 'B-3', title: '単体発送商品（individual）のみの注文', cells: { composition: 'individual_only' } },
    { b: 'B-4', title: '同梱+単体発送の混在注文', cells: { composition: 'mixed' } },
    { b: 'B-5', title: 'quantity≥2 の分割', cells: { quantity: 'multi' } },
    { b: 'B-6', title: 'セット商品の展開と在庫キー付け替え', cells: { set_item: 'present' } },
    { b: 'B-7', title: 'ReservableStock フォールバック', cells: { stock: 'reservable_stock' } },
    { b: 'B-8', title: '開催中セールありの金額計算', cells: { sale: 'integer_discount' } },
    { b: 'B-9', title: 'delivery_date/time とも空文字', cells: { delivery_pref: 'both_empty' } },
    { b: 'B-10', title: 'delivery_date のみ指定', cells: { delivery_pref: 'date_only' } },
    { b: 'B-11', title: '類似返品注文ありの後処理', cells: { similar_return: 'present' } },
    { b: 'B-12', title: 'トークン認証失敗（軸非依存の異常系）', cells: {} },
    { b: 'B-13', title: '形式系入力検証エラー（軸非依存の異常系）', cells: {} },
    { b: 'B-14', title: '住所マスタ照合エラー（軸非依存の異常系）', cells: {} },
    { b: 'B-15', title: '配送不可エリア（軸非依存の異常系）', cells: {} },
    { b: 'B-16', title: 'items 不正（軸非依存の異常系）', cells: {} },
    { b: 'B-17', title: 'ProductInfo 不存在（軸非依存の異常系）', cells: {} },
    { b: 'B-18', title: '配送希望時間帯が不正スロット（軸非依存の異常系）', cells: {} },
    { b: 'B-19', title: '時間帯指定なしエリアで delivery_time 指定（軸非依存の異常系）', cells: {} },
    { b: 'B-20', title: '在庫なし（配送日確認フェーズ、軸非依存の異常系）', cells: {} },
    { b: 'B-21', title: '配送希望日が範囲外（軸非依存の異常系）', cells: {} },
    { b: 'B-22', title: '重複リクエスト（軸非依存の異常系）', cells: {} },
    { b: 'B-23', title: '在庫割当失敗（フェーズ7再確認）', cells: { stock: 'allocation_failed' } },
    { b: 'B-24', title: 'WMS 422 — 時間帯不可地域の登録副作用', cells: { wms: ['a3_422_carrier_x', 'a3_422_carrier_y'] } },
    { b: 'B-25', title: 'WMS その他エラー', cells: { wms: 'a4_other_error' } },
    { b: 'B-28', title: '未ハンドル例外 — bulk レスポンス不整合は throw', cells: { bulk_shipment_integrity: 'shipment_missing' }, addedBy: 'R4' },
    { b: 'B-29', title: '後処理の例外吸収（軸非依存の横断）', cells: {} },
    { b: 'B-30', title: '入力スキーマ整合の PBT（軸非依存の formal gate）', cells: {} },
    { b: 'B-31', title: '倉庫選択の都道府県依存', cells: { warehouse_side: 'east' }, addedBy: 'R10' },
    { b: 'B-32', title: 'quantity≥2 × セット商品の set_base 誤リンク', cells: { quantity: 'multi', set_item: 'present' }, addedBy: 'R1' },
    { b: 'B-33', title: '類似注文照合の mail IS NULL 無条件マッチ', cells: { similar_return: 'mail_null_match' }, addedBy: 'R3' },
    { b: 'B-34', title: 'individual 判定の層間非対称', cells: { individual_layer_asymmetry: 'present' }, addedBy: 'R3' },
    { b: 'B-35', title: 'WMS delivery_method は常に HOME_DELIVERY', cells: { post_express: 'present' }, addedBy: 'R5' },
    {
      b: 'B-36',
      title: '非整数割引額は throw + fail fast（parameterize 交点込み）',
      cells: {
        sale: 'noninteger_discount',
        stock: ['product_stock', 'allocation_failed'],
        wms: ['a1_success', 'a2_maintenance', 'a3_422_carrier_x', 'a3_422_carrier_y', 'a4_other_error'],
      },
      addedBy: 'R6',
    },
    { b: 'B-37', title: 'WMS 422 応答の errors キー欠落は throw', cells: { wms: 'a5_422_malformed' }, addedBy: 'R6' },
    { b: 'B-38', title: 'individual 分類の判定ソース非対称', cells: { individual_source_asymmetry: 'present' }, addedBy: 'R11' },
    { b: 'B-39', title: 'items 空配列 — 0 商品注文の正常作成（軸外の境界値、摩擦メモ参照）', cells: {}, addedBy: 'R14' },
    { b: 'B-40', title: 'フェーズ2 複合不正入力の打ち切り順序（軸非依存の異常系）', cells: {}, addedBy: 'R17' },
    { b: 'B-41', title: 'ハイフン付き郵便番号の正常系', cells: { postal_format: 'hyphenated' }, addedBy: 'R21' },
  ],
}
