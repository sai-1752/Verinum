/** Billing provider contract. The app depends on this, never on Stripe directly. */
export type BillingEvent =
  | { kind: "subscription"; eventId: string; workspaceId: string | null; customerId: string; subscriptionId: string; planId: string | null; status: string; currentPeriodEnd: number | null; cancelAtPeriodEnd: boolean }
  | { kind: "ignored"; eventId: string; type: string };

export interface BillingProvider {
  readonly name: string;
  createCheckout(o: { workspaceId: string; planId: string; email: string; customerId?: string | null; successUrl: string; cancelUrl: string }): Promise<{ url: string }>;
  createPortal(o: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Verifies the signature over the RAW body and parses the event. Throws on a bad signature. */
  parseWebhook(rawBody: string, signatureHeader: string | undefined, nowSeconds: number): BillingEvent;
}
