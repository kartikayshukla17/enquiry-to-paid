/** Chasers (T19): the simulated WhatsApp send side. No network; a real WhatsApp adapter replaces the collecting double later. */

export type ChaserKind = "free_text" | "template";

/**
 * One customer-bound chaser. `free_text` goes inside the customer's 24h service window; `template` is an approved template
 * message (a fixed, pre-registered body with named parameters) used outside it. `text` is the rendered body either way.
 */
export interface ChaserMessage {
  tenantId: string;
  threadId: string;
  customerId: string;
  /** 1 (24h) or 2 (72h). There is no 3. */
  n: 1 | 2;
  kind: ChaserKind;
  /** Approved template name, for kind "template". */
  template?: string;
  /** Values injected into the template, all from code or the kernel quote. */
  params: { business: string; amount: string; link?: string };
  text: string;
  at: string;
}

export interface ChaserOutbox {
  send(m: ChaserMessage): Promise<void>;
}

export function collectingChaserOutbox(sink: ChaserMessage[]): ChaserOutbox {
  return {
    send(m) {
      sink.push(m);
      return Promise.resolve();
    },
  };
}
