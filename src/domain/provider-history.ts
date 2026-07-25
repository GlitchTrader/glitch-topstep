export interface ProviderHistorySyncStatus {
  syncKey: string;
  cursorUtc: string | null;
  lastAttemptUtc: string | null;
  lastSucceededUtc: string | null;
  lastWindowStartUtc: string | null;
  lastWindowEndUtc: string | null;
  lastError: string | null;
  lastOrdersSeen: number;
  lastTradesSeen: number;
  lastEventsAppended: number;
}

export interface ProviderHistorySyncResult {
  attemptedWindows: number;
  completedWindows: number;
  ordersSeen: number;
  tradesSeen: number;
  eventsAppended: number;
  status: ProviderHistorySyncStatus;
}
