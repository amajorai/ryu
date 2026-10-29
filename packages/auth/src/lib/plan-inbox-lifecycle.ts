import { MS_PER_DAY } from "./plan-desktop-gate.ts";

/* -------------------------------------------------------------------------- *
 * Agent Inbox lifecycle (subscription lapse → grace → deactivated → deletable).
 *
 * Agent Inboxes (Ryu Mail) are a hosted feature: the free baseline gets a small
 * allowance (one inbox per person), while an active Plus/Pro/Max/Teams/Teams
 * Lite/Business plan carries the larger `emailEnabled` quota. When an inbox
 * stops being covered — the plan lapsed, or after a downgrade the inbox is
 * beyond the free baseline's one-inbox allowance — it must not
 * simply vanish (its address is a real, published identity and its stored mail
 * is the user's data), nor keep costing Ryu SES/storage forever. This is the one
 * place the lapse policy lives; it is a PURE, deterministic function (inject
 * `nowMs`) mirroring `decideDesktopAccess` (`plan-desktop-gate.ts`) — the only verification surface
 * without a live SES/Polar runtime.
 *
 * The states, in order:
 *  - `active`      — the owner's plan includes email. Inbound accepted; agent has
 *                    full access. Any prior lapse anchors are CLEARED, so a
 *                    re-upgrade within retention restores the inbox in full (the
 *                    row was never deleted; restore == reactivate, never recreate).
 *  - `grace`       — plan lapsed < `graceDays` ago. Inbound STILL accepted + stored
 *                    (never lose already-sent mail), but agent access is paused /
 *                    read-only. A clear, recoverable state.
 *  - `deactivated` — grace expired. Inbound is REJECTED (dropped-and-retained here;
 *                    a true SMTP bounce is an SES receipt-rule reject — owner-side
 *                    config). Stored mail is RETAINED for `retentionDays`, then
 *                    eligible for hard deletion (a scheduled sweep — follow-up).
 *                    The address is RESERVED: the inbox row is not deleted, so the
 *                    unique-address index blocks reassignment to any other account
 *                    (address reuse would leak the prior owner's mail).
 * -------------------------------------------------------------------------- */

/** The lapse policy's tunable windows (swappable; never inlined per-call-site). */
export interface InboxLifecycleConfig {
	/** Days after a plan lapse before an inbox is deactivated (agent read-only). */
	readonly graceDays: number;
	/** Days a deactivated inbox's stored mail is retained before deletion is eligible. */
	readonly retentionDays: number;
}

/** The single default lapse policy: 30-day grace, then 90-day retention. */
export const MAIL_LIFECYCLE: InboxLifecycleConfig = {
	graceDays: 30,
	retentionDays: 90,
};

/** An inbox's lifecycle state, derived from the owner's live entitlement + anchors. */
export type InboxLifecycleState = "active" | "grace" | "deactivated";

/** Inputs to the pure inbox-lifecycle decision. All times are epoch ms. */
export interface InboxLifecycleInput {
	/** When the inbox was deactivated (retention anchor), or null. */
	readonly deactivatedAtMs: number | null;
	/**
	 * Whether the inbox OWNER's current allowance covers this inbox: the plan
	 * includes Agent Inboxes (`emailQuotaForPlan(plan).enabled` from `plans.ts`) and,
	 * on the free baseline, this inbox holds the owner's free inbox slot. This
	 * is the lapse signal.
	 */
	readonly emailEntitled: boolean;
	/** When the lapse was first observed (grace anchor), or null if never lapsed. */
	readonly lapsedAtMs: number | null;
	/** Now, in epoch ms. Injected so the decision is deterministic in tests. */
	readonly nowMs: number;
}

/** The resolved inbox-lifecycle verdict. */
export interface InboxLifecycleVerdict {
	/** Whether inbound mail is still accepted + stored (active + grace). */
	readonly acceptsInbound: boolean;
	/** Whether agent access is paused / read-only (grace + deactivated). */
	readonly agentReadOnly: boolean;
	/** Deactivation anchor to persist (null unless deactivated). */
	readonly deactivatedAtMs: number | null;
	/** When stored mail becomes eligible for hard deletion (null unless deactivated). */
	readonly eligibleForDeletionAtMs: number | null;
	/** Grace anchor to persist (null when active). */
	readonly lapsedAtMs: number | null;
	readonly state: InboxLifecycleState;
}

/**
 * Decide an inbox's lifecycle state from the owner's entitlement and the stored
 * lapse/deactivation anchors. Pure and deterministic (inject `nowMs`). The caller
 * persists the returned anchors back to the inbox when they differ from what was
 * stored (a lazy state machine — transitions are realized on next access/inbound,
 * with a scheduled sweep as the follow-up for hard deletion).
 */
export const resolveInboxLifecycle = (
	input: InboxLifecycleInput,
	config: InboxLifecycleConfig = MAIL_LIFECYCLE
): InboxLifecycleVerdict => {
	const { emailEntitled, nowMs } = input;

	// Entitled → active. Clearing the anchors is what makes a re-upgrade within
	// retention a full, automatic restore (address + stored mail): the row was
	// never deleted, so reactivation just flips the state back.
	if (emailEntitled) {
		return {
			state: "active",
			lapsedAtMs: null,
			deactivatedAtMs: null,
			acceptsInbound: true,
			agentReadOnly: false,
			eligibleForDeletionAtMs: null,
		};
	}

	// Lapsed: anchor the grace window at first observation (or reuse the stored one).
	const lapsedAtMs = input.lapsedAtMs ?? nowMs;
	const graceEndsMs = lapsedAtMs + config.graceDays * MS_PER_DAY;

	// Still within grace: inbound accepted + stored, agent access read-only.
	if (nowMs < graceEndsMs) {
		return {
			state: "grace",
			lapsedAtMs,
			deactivatedAtMs: null,
			acceptsInbound: true,
			agentReadOnly: true,
			eligibleForDeletionAtMs: null,
		};
	}

	// Deactivated: inbound rejected, stored mail retained. Anchor deactivation at
	// grace end (or reuse the stored one) so the retention window is stable.
	const deactivatedAtMs = input.deactivatedAtMs ?? graceEndsMs;
	return {
		state: "deactivated",
		lapsedAtMs,
		deactivatedAtMs,
		acceptsInbound: false,
		agentReadOnly: true,
		eligibleForDeletionAtMs:
			deactivatedAtMs + config.retentionDays * MS_PER_DAY,
	};
};
