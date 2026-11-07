/** Owner channel (T17): a simulated WhatsApp thread between a tenant's owner/manager/staff and the agent. */

export type MemberRole = "owner" | "manager" | "staff";

/** A message the agent sends to a member. `toMemberId` + role stand in for the decrypted phone a real channel would resolve. */
export interface OwnerOutgoing {
  tenantId: string;
  toMemberId: string;
  role: MemberRole;
  kind: "escalation" | "digest" | "customer_message";
  text: string;
  at: string;
}

/** Simulated delivery seam: v0 collects; a WhatsApp implementation replaces it later. */
export interface OwnerOutbox {
  send(m: OwnerOutgoing): Promise<void>;
}

export function collectingOutbox(sink: OwnerOutgoing[]): OwnerOutbox {
  return {
    send(m) {
      sink.push(m);
      return Promise.resolve();
    },
  };
}

/** Customer-bound text produced by an owner action. Always a code template; never owner free text. */
export interface CustomerMessage {
  threadId: string;
  text: string;
}
