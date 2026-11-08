// apps/desktop/src/lib/api/agent-egress-allowlist.ts
//
// One agent's egress allowlist: the hosts its app sessions (a Bot browser
// session, for one) may reach. Core owns validation and storage
// (`apps/core/src/sidecar/ext_proxy/egress_policy/`) and stamps the list on the agent's
// verified app requests. `null` means the agent is unrestricted; an empty list
// allows no host. Reads need `agent.view`, writes `agent.edit`.

import { z } from "zod";

import { type ApiTarget, request } from "./client.ts";

/** Most hosts one allowlist may name; Core refuses a longer list. */
export const MAX_EGRESS_ALLOWLIST_HOSTS = 32;

const allowlistResponseSchema = z.looseObject({
	agent_id: z.string(),
	allowlist: z.union([z.null(), z.array(z.string())]),
});

const ENTRY_SEPARATOR = /[\s,]+/;

function allowlistPath(agentId: string): string {
	return `/api/agents/${encodeURIComponent(agentId)}/egress-allowlist`;
}

/** Split an editor's text (one host per line, or comma-separated) into entries. */
export function parseAllowlistText(text: string): string[] {
	return text
		.split(ENTRY_SEPARATOR)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

/** The editor text for a stored list: one host per line. */
export function formatAllowlistText(allowlist: readonly string[]): string {
	return allowlist.join("\n");
}

export async function fetchAgentEgressAllowlist(
	target: ApiTarget,
	agentId: string
): Promise<string[] | null> {
	const body = await request(
		target,
		allowlistPath(agentId),
		{},
		allowlistResponseSchema
	);
	return body.allowlist;
}

/** Store `allowlist` for the agent. Returns the list as Core normalized it. */
export async function saveAgentEgressAllowlist(
	target: ApiTarget,
	agentId: string,
	allowlist: readonly string[]
): Promise<string[] | null> {
	const body = await request(
		target,
		allowlistPath(agentId),
		{ method: "PUT", body: { allowlist } },
		allowlistResponseSchema
	);
	return body.allowlist;
}

/** Remove the agent's allowlist, leaving it unrestricted. */
export async function clearAgentEgressAllowlist(
	target: ApiTarget,
	agentId: string
): Promise<void> {
	await request(
		target,
		allowlistPath(agentId),
		{ method: "DELETE" },
		allowlistResponseSchema
	);
}
