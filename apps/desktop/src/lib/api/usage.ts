// apps/desktop/src/lib/api/usage.ts
//
// Per-agent subscription usage (the chat "usage bar"). When a subscription ACP
// agent is active in chat (Claude Code, Codex), Core reads that CLI's own local
// OAuth token and calls the vendor's usage endpoint, returning the 5h "session"
// and weekly rate-limit windows — à la CodexBar / openusage. Core owns all the
// provider logic + the never-refresh token safety; this is a thin typed reader.
//
// The endpoint always returns 200: refusals carry `available: false` + a
// `reason` rather than an error, so callers never branch on HTTP status — they
// hide the bar on `unsupported` and show a hint otherwise.

import type { ApiTarget } from "@/src/lib/api/client.ts";
import { request } from "@/src/lib/api/client.ts";

/** Why a snapshot has no live windows (mirrors Core's `UsageUnavailable`). */
export type UsageReason =
	| "unsupported"
	| "not_logged_in"
	| "token_expired"
	| "missing_scope"
	| "rate_limited"
	| "error";

/** One rolling rate-limit window. `usedPercent` is 0–100. */
export interface UsageWindow {
	label: string;
	resetsAt: string | null;
	usedPercent: number;
}

/** Normalized usage snapshot for one agent. */
export interface UsageSnapshot {
	agentId: string;
	available: boolean;
	engine: string;
	extraUsageUsd: number | null;
	plan: string | null;
	reason: UsageReason | null;
	windows: UsageWindow[];
}

/** Raw snake_case wire shape from Core. */
interface WireWindow {
	label: string;
	resets_at?: string | null;
	used_percent: number;
}

interface WireSnapshot {
	agent_id: string;
	available: boolean;
	engine: string;
	extra_usage_usd?: number | null;
	plan?: string | null;
	reason?: UsageReason | null;
	windows: WireWindow[];
}

function toSnapshot(wire: WireSnapshot): UsageSnapshot {
	return {
		agentId: wire.agent_id,
		engine: wire.engine,
		available: wire.available,
		plan: wire.plan ?? null,
		reason: wire.reason ?? null,
		windows: wire.windows.map((w) => ({
			label: w.label,
			usedPercent: w.used_percent,
			resetsAt: w.resets_at ?? null,
		})),
		extraUsageUsd: wire.extra_usage_usd ?? null,
	};
}

/**
 * Cheap client-side guess of whether an agent has a readable subscription usage
 * window, mirroring Core's `engine_for_agent`. Used to gate the poll so we don't
 * hit the endpoint every few minutes for agents that will always answer
 * `unsupported` (Core is the source of truth — this is just a poll filter).
 */
export function supportsUsage(agentId: string | null | undefined): boolean {
	if (!agentId) {
		return false;
	}
	const id = agentId.toLowerCase();
	return id.includes("claude") || id.includes("codex");
}

/**
 * Fetch the usage snapshot for one agent. `agentId` may be an `acp:`-prefixed id
 * (it's percent-encoded for the path).
 */
export async function fetchAgentUsage(
	target: ApiTarget,
	agentId: string
): Promise<UsageSnapshot> {
	const wire = await request<WireSnapshot>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/usage`
	);
	return toSnapshot(wire);
}
