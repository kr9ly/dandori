export type OrderStatus = 'draft' | 'confirmed' | 'shipped'

export function confirmOrder(id: string): OrderStatus {
  return 'confirmed'
}
