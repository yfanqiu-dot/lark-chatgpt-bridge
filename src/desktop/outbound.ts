/** A lost send receipt cannot safely be retried. The ledger retains /result recovery. */
export const desktopOutboundConfig = { retry: { maxAttempts: 1 } } as const;
