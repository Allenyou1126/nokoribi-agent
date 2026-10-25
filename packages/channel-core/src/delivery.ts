import type { DeliveryMode } from "./contract.js";

/** Result of resolving one inbound message's delivery semantics. */
export interface DeliveryChoice {
    readonly mode: DeliveryMode;
    /** Whether the caller must clear its one-shot mode after this message. */
    readonly consumedOneShot: boolean;
}

/**
 * Choose delivery for one inbound message.
 *
 * Precedence: explicit code-level delivery, then a bare `/steer` or `/queue`
 * one-shot, then the agent's current status (running → steer, idle → followup).
 */
export function chooseDelivery(
    explicit: DeliveryMode | undefined,
    oneShot: DeliveryMode | null,
    status: "idle" | "running"
): DeliveryChoice {
    if (explicit !== undefined) {
        return { mode: explicit, consumedOneShot: false };
    }
    if (oneShot !== null) {
        return { mode: oneShot, consumedOneShot: true };
    }
    return {
        mode: status === "running" ? "steer" : "followup",
        consumedOneShot: false,
    };
}
