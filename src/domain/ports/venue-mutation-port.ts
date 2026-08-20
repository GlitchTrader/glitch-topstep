/** Venue-side order mutations delegated from execution sagas. */
export interface PlaceOrderRequest {
  accountId: number;
  contractId: string;
  type: number;
  side: number;
  size: number;
  limitPrice?: number | null;
  stopPrice?: number | null;
  customTag?: string | null;
  linkedOrderId?: number | null;
}

export interface ModifyOrderRequest {
  accountId: number;
  orderId: number;
  size?: number | null;
  limitPrice?: number | null;
  stopPrice?: number | null;
}

export interface VenueMutationPort {
  placeOrder(request: PlaceOrderRequest): Promise<{ orderId: number }>;
  modifyOrder(request: ModifyOrderRequest): Promise<void>;
  cancelOrder(accountId: number, orderId: number): Promise<void>;
}
