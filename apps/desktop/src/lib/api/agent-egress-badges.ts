// apps/desktop/src/lib/api/agent-egress-badges.ts
//
// Split out of `agent-egress.ts`; import from there. See that module's header.

import type {
	AgentEgress,
	AgentEgressView,
	EgressBadgeDescriptor,
} from "./agent-egress-types.ts";

/**
 * The status pill for one row. SIX visually distinct states, because collapsing
 * them to on/off is exactly the lie this surface exists to remove: an agent
 * running a model on this laptop and an agent streaming your prompts to
 * Anthropic unfiltered are not both "not governed" — and a preference that was
 * saved four seconds ago is not yet the state of a process that started an hour
 * ago.
 *
 * `savedTo` is the value THIS PANEL last wrote for the row, or `null` if it has
 * written nothing. It is the only in-force signal reachable from the desktop, and
 * it is a one-way one: a write we just made is definitely not in force yet for an
 * already-running instance, but its absence does NOT prove the displayed state is
 * in force (the same preference is writable from the agent editor, and Core
 * exposes no per-agent live-instance state — see the module header of
 * `AgentEgressSection.tsx` for exactly what Core would have to serve). That is why
 * the standing {@link AgentEgress.takesEffect} sentence is rendered on the row
 * whether or not this flag is set: the badge sharpens the claim in the one case we
 * can prove, and the sentence covers the rest.
 *
 * A row whose `takesEffect` is `null` has no spawn step to wait for, so a write
 * there IS the current state and the badge must not hedge — hedging everywhere is
 * how a caveat stops being read.
 */
export function describeEgressBadge(
	row: AgentEgress,
	savedTo: boolean | null = null
): EgressBadgeDescriptor {
	if (savedTo !== null && row.takesEffect !== null) {
		// Both directions hedge. Turning routing OFF is the same lie mirrored: a
		// running agent keeps going THROUGH the gateway after the switch says
		// "Straight to provider", and someone who flipped it off to keep a
		// subscription outside Ryu egress deserves to know it has not happened yet.
		return {
			label: savedTo ? "Gateway on next start" : "Direct on next start",
			variant: "outline",
			pendingStart: true,
		};
	}
	if (row.mechanism === "local-engine") {
		return {
			label: "On this device",
			variant: "secondary",
			pendingStart: false,
		};
	}
	if (row.governed === null) {
		return { label: "Unknown", variant: "outline", pendingStart: false };
	}
	if (row.governed) {
		// "Pointed at" rather than "through": Ryu sets OPENAI_BASE_URL, but it
		// cannot make a third-party binary read it.
		return row.bestEffort
			? { label: "Pointed at gateway", variant: "outline", pendingStart: false }
			: { label: "Through gateway", variant: "default", pendingStart: false };
	}
	if (row.mechanism === "unroutable") {
		return {
			label: "Can't be routed",
			variant: "outline",
			pendingStart: false,
		};
	}
	return {
		label: "Straight to provider",
		variant: "destructive",
		pendingStart: false,
	};
}

export function summarizeAgentEgress(rows: AgentEgress[]): AgentEgressView {
	let governedCount = 0;
	let bestEffortCount = 0;
	let directCount = 0;
	let otherCount = 0;
	let toolsOnCount = 0;
	let toolsOffCount = 0;
	let toolsOtherCount = 0;
	for (const row of rows) {
		if (row.governed === true) {
			if (row.bestEffort) {
				bestEffortCount += 1;
			} else {
				governedCount += 1;
			}
		} else if (row.governed === false) {
			directCount += 1;
		} else {
			otherCount += 1;
		}
		if (row.tools.enabled === true) {
			toolsOnCount += 1;
		} else if (row.tools.enabled === false) {
			toolsOffCount += 1;
		} else {
			toolsOtherCount += 1;
		}
	}
	return {
		rows,
		governedCount,
		bestEffortCount,
		directCount,
		otherCount,
		toolsOnCount,
		toolsOffCount,
		toolsOtherCount,
	};
}

/** The status pill for a row's TOOL half. Separate function, separate words. */
export function describeToolBadge(
	row: AgentEgress,
	savedTo: boolean | null = null
): EgressBadgeDescriptor {
	// Same hedge as the egress badge and for the same reason, but the pending
	// window is different (see {@link TAKES_EFFECT_TOOLS}): a chat with a live
	// ACP instance keeps the bridge it was built with. "Pending" here means "not
	// yet in your open chats", not "not yet anywhere".
	if (savedTo !== null && row.tools.takesEffect !== null) {
		return {
			label: savedTo ? "Tools on in new chats" : "Tools off in new chats",
			variant: "outline",
			pendingStart: true,
		};
	}
	if (row.tools.enabled === null) {
		return { label: "Not applicable", variant: "outline", pendingStart: false };
	}
	if (row.tools.enabled) {
		// The flagship's tools do not come from this switch, so it does not get the
		// same pill as an agent whose bridge is on — a shared label would imply a
		// shared control, and there is no control here to find.
		return row.tools.mechanism === "pi-extension"
			? {
					label: "Tools via Pi extension",
					variant: "secondary",
					pendingStart: false,
				}
			: { label: "Ryu tools on", variant: "default", pendingStart: false };
	}
	return row.tools.mechanism === "pi-no-bridge"
		? { label: "Can't take tools", variant: "outline", pendingStart: false }
		: { label: "Ryu tools off", variant: "destructive", pendingStart: false };
}
