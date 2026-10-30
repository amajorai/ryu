// apps/desktop/src/lib/api/agent-egress-bulk.ts
//
// Split out of `agent-egress.ts`; import from there. See that module's header.

import type {
	AgentEgressView,
	ToolBridgeChange,
	ToolBridgeMechanism,
	ToolBridgePlan,
	ToolBridgeSkip,
} from "./agent-egress-types.ts";
import type { ApiTarget } from "./client.ts";
import { setAgentToolBridgeMany } from "./preferences.ts";

// ── The bulk action: "give every agent Ryu's tools" ──────────────────────────
//
// ── Why it is TOOLS-ONLY, and why that is not a half-measure ─────────────────
// A one-click "configure every agent" that included egress would, on the very
// first click, re-point Claude Code's Pro/Max sign-in at the local gateway and
// move where that spend is counted — for every agent at once, from a button whose
// label says "configure". Egress remains an explicit per-agent opt-out in Core
// precisely because it is a decision per agent and per credential; a bulk control
// should not overwrite a user's existing direct-egress choice.
//
// The tools half has no such property (the bridge offers only the allowlist the
// agent already has, re-checked per call), so it is the half a bulk action may
// safely own. Egress stays exactly where it is: one row, one switch, one
// deliberate act. This is stated in the plan itself — {@link ToolBridgePlan}
// carries `egressUntouched` so the confirming UI must show it rather than
// remember to.
//
// ── Why it is a PLAN, not an apply ───────────────────────────────────────────
// `planEnableToolsForAll` computes and returns; nothing is written until
// `applyToolBridgePlan` is called with it. So the dialog above can render the
// exact per-agent list — including the ones it will NOT touch and why — and the
// user confirms a specific, enumerated change rather than a verb.

/**
 * What "turn Ryu's tools on for every agent" would actually do to THIS node.
 *
 * Skips are enumerated rather than filtered away. A preview that silently omits
 * the agents it cannot help lets the user believe the click covered everything,
 * and the single most important omission — the flagship and bare `acp:pi` — is
 * exactly the one they most need to read, because it is the answer to "why does
 * my Pi agent still ignore Ryu's tools".
 */
export function planEnableToolsForAll(
	view: AgentEgressView,
	enabled = true
): ToolBridgePlan {
	const changes: ToolBridgeChange[] = [];
	const skipped: ToolBridgeSkip[] = [];
	for (const row of view.rows) {
		const { tools } = row;
		if (tools.control === null) {
			skipped.push({
				agentId: row.agentId,
				name: row.name,
				reason: skipReason(tools.mechanism),
			});
			continue;
		}
		if (tools.enabled === enabled) {
			continue;
		}
		changes.push({
			agentId: row.agentId,
			name: row.name,
			from: tools.enabled === true,
			to: enabled,
		});
	}
	return { changes, skipped, egressUntouched: true };
}

/** The one-line reason a row has no tool control, in the user's terms. */
function skipReason(mechanism: ToolBridgeMechanism): string {
	switch (mechanism) {
		case "pi-extension":
			return "Already has Ryu's tools, from a Pi extension rather than this switch.";
		case "pi-no-bridge":
			return "Cannot take Ryu's tools at all — Pi accepts no tool server, and the Ryu Pi extension is only installed for the Ryu agent.";
		default:
			return "Not an ACP agent, so there is no tool bridge to turn on.";
	}
}

/**
 * Apply a plan in ONE preference write.
 *
 * `setAgentToolBridgeMany` is a single read-merge-write. Looping the single-agent
 * setter would be a lost-update race against itself — every call reads the same
 * pre-write blob of the one shared key, so a five-agent bulk action could persist
 * one entry and silently drop four. That is a worse failure than not offering the
 * button, because the UI would report success.
 *
 * A plan with no changes writes nothing and succeeds: re-confirming a bulk action
 * that is already satisfied must not churn the node's preferences.
 */
export function applyToolBridgePlan(
	target: ApiTarget,
	plan: ToolBridgePlan
): Promise<boolean> {
	if (plan.changes.length === 0) {
		return Promise.resolve(true);
	}
	const entries: Record<string, boolean> = {};
	for (const change of plan.changes) {
		entries[change.agentId] = change.to;
	}
	return setAgentToolBridgeMany(target, entries);
}
