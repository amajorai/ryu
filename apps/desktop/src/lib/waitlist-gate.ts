export type WaitlistGateStatus = "loading" | "approved" | "pending";

export type WaitlistGateState =
	| { readonly scope: "local" }
	| {
			readonly scope: "all" | "managed";
			readonly status: WaitlistGateStatus;
	  };

interface WaitlistNode {
	managed?: boolean | null;
}

/** Resolve whether this node is gated under the server's current scope flag. */
export function waitlistScopeForNode(
	node: WaitlistNode,
	managedOnly: boolean | null
): WaitlistGateState["scope"] | "loading" {
	if (managedOnly === null) {
		return "loading";
	}
	if (!managedOnly) {
		return "all";
	}
	return node.managed === true ? "managed" : "local";
}

/** The next managed-only scope after a flag read. A real read always wins; a
 *  failed one (`null`) keeps the last known scope, so one 5xx or network blip
 *  cannot flip a pending user's local node from "app" to the gate. Only the
 *  first read, with nothing known yet, fails closed to all-node gating. */
export function nextWaitlistManagedOnly(
	previous: boolean | null,
	read: boolean | null
): boolean {
	return read ?? previous ?? false;
}

export type WaitlistSurface = "loading" | "waitlisted" | "app";

/** Per-account marker that this signed-in user was confirmed approved before.
 *  Scoped by user id so a second, still-pending account on the same machine
 *  never inherits another account's approval. */
export function waitlistApprovedKeyForUser(userId: string): string {
	return `ryu_waitlist_approved:${userId}`;
}

/** Resolve the shell state without letting a stale managed-node check block a local node.
 *
 *  `cachedApproved` is this account's last confirmed approval. While the live
 *  checks are still in flight it renders the app instead of a full-screen
 *  placeholder; a fresh `pending` answer still wins and moves to the queue. */
export function resolveWaitlistSurface(input: {
	cachedApproved?: boolean;
	managedOnly: boolean | null;
	node: WaitlistNode;
	state: WaitlistGateState;
}): WaitlistSurface {
	const whileLoading: WaitlistSurface = input.cachedApproved
		? "app"
		: "loading";
	const scope = waitlistScopeForNode(input.node, input.managedOnly);
	if (scope === "local") {
		return "app";
	}
	if (scope === "loading") {
		return whileLoading;
	}
	if (input.state.scope !== scope || input.state.status === "loading") {
		return whileLoading;
	}
	return input.state.status === "pending" ? "waitlisted" : "app";
}
