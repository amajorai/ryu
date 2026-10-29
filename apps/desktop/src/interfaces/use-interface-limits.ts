// Subscription usage windows per agent for the interface snapshot (spec §3.2
// `agent.limit`). Polled round-robin: at most 6 agents per 5-minute tick, the
// least recently polled first, working or blocked agents first among equals,
// so every agent is reached within ceil(n / 6) ticks without a burst of probes.
// An agent never polled stays undefined (unknown); the scene claims nothing.

import type { InterfaceAgentLimit } from "@ryuhq/protocol/interfaces";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	fetchAgentUsage,
	supportsUsage,
	type UsageSnapshot,
} from "@/src/lib/api/usage.ts";
import { chooseAgentLimit } from "./snapshot.ts";

export const USAGE_POLLS_PER_TICK = 6;
export const USAGE_TICK_MS = 5 * 60_000;

export interface UsagePollCandidate {
	id: string;
	/** Working or blocked: polled first among equally stale agents. */
	urgent: boolean;
}

/**
 * The agents to poll this tick: least recently polled first (never polled
 * counts as oldest), urgent agents first among equals, then by id.
 */
export function pickUsagePolls(
	agents: readonly UsagePollCandidate[],
	lastPolled: ReadonlyMap<string, number>,
	max = USAGE_POLLS_PER_TICK
): string[] {
	return [...agents]
		.sort((a, b) => {
			const at = lastPolled.get(a.id) ?? Number.NEGATIVE_INFINITY;
			const bt = lastPolled.get(b.id) ?? Number.NEGATIVE_INFINITY;
			if (at !== bt) {
				return at < bt ? -1 : 1;
			}
			return Number(b.urgent) - Number(a.urgent) || a.id.localeCompare(b.id);
		})
		.slice(0, max)
		.map((agent) => agent.id);
}

/** The same cache key the chat usage bar uses, so a probe is shared. */
function usageKey(
	node: { token?: string | null; url: string; userJwt?: string | null },
	agentId: string
) {
	return [
		"agent-usage",
		node.url,
		node.token ?? null,
		node.userJwt ?? null,
		agentId,
	] as const;
}

interface UsageResult {
	data: UsageSnapshot | undefined;
	isError: boolean;
	isPending: boolean;
}

/** Keep only what the limits need, so `useQueries` can share the result. */
function combineUsage(
	results: readonly { data?: unknown; isError: boolean; isPending: boolean }[]
): UsageResult[] {
	return results.map((result) => ({
		data: result.data as UsageSnapshot | undefined,
		isError: result.isError,
		isPending: result.isPending,
	}));
}

const NO_IDS: readonly string[] = [];

/**
 * Polled limits by agent id, chosen per agent model. Each tick (and as soon
 * as the agent list arrives) the round-robin picks up to 6 agents: new ones
 * join the queries, already-polled ones are refetched. Queries share the chat
 * usage bar's cache key, so react-query dedupes and caches the probes.
 * Agents whose engine has no usage endpoint are never polled (unknown).
 */
export function useInterfaceLimits(
	enabled: boolean,
	agents: readonly { id: string; model?: string | null }[],
	urgentIds: ReadonlySet<string>
): ReadonlyMap<string, InterfaceAgentLimit | null> {
	const active = useActiveNode();
	const node = useMemo(
		() => ({
			token: active.token ?? null,
			url: active.url,
			userJwt: active.userJwt ?? null,
		}),
		[active.token, active.url, active.userJwt]
	);
	const nodeKey = JSON.stringify(node);
	const queryClient = useQueryClient();
	const target = useMemo(() => toTarget(node), [node]);
	// The polled list belongs to one node: after a switch it reads empty at
	// once, so the first tick on the new node probes instead of refetching.
	const [polledState, setPolledState] = useState<{
		ids: readonly string[];
		key: string;
	}>({ ids: NO_IDS, key: nodeKey });
	const polled = polledState.key === nodeKey ? polledState.ids : NO_IDS;
	const lastPolled = useRef({ key: nodeKey, times: new Map<string, number>() });
	const latest = useRef({ agents, polled, urgentIds });
	latest.current = { agents, polled, urgentIds };
	const candidateKey = agents
		.filter((agent) => supportsUsage(agent.id))
		.map((agent) => agent.id)
		.join("\n");

	useEffect(() => {
		if (!(enabled && candidateKey)) {
			return;
		}
		if (lastPolled.current.key !== nodeKey) {
			lastPolled.current = { key: nodeKey, times: new Map() };
		}
		const tick = () => {
			const current = latest.current;
			const candidates = current.agents
				.filter((agent) => supportsUsage(agent.id))
				.map((agent) => ({
					id: agent.id,
					urgent: current.urgentIds.has(agent.id),
				}));
			const now = Date.now();
			const times = lastPolled.current.times;
			const picked = pickUsagePolls(candidates, times);
			const known = new Set(current.polled);
			for (const id of picked) {
				times.set(id, now);
				if (known.has(id)) {
					Promise.resolve(
						queryClient.invalidateQueries({ queryKey: usageKey(node, id) })
					).catch(() => undefined);
				}
			}
			const fresh = picked.filter((id) => !known.has(id));
			if (fresh.length > 0) {
				setPolledState((state) => ({
					ids: state.key === nodeKey ? [...state.ids, ...fresh] : fresh,
					key: nodeKey,
				}));
			}
		};
		// Poll at once when the agent list arrives, then every 5 minutes.
		tick();
		const timer = setInterval(tick, USAGE_TICK_MS);
		return () => clearInterval(timer);
	}, [enabled, candidateKey, node, nodeKey, queryClient]);

	const results = useQueries({
		combine: combineUsage,
		queries: polled.map((id) => ({
			enabled,
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				fetchAgentUsage(target, id, signal),
			queryKey: usageKey(node, id),
			refetchOnWindowFocus: false,
			retry: false,
			// The round-robin decides when to refetch, not a per-query interval.
			staleTime: Number.POSITIVE_INFINITY,
		})),
	});

	return useMemo(() => {
		const limits = new Map<string, InterfaceAgentLimit | null>();
		const models = new Map(
			agents.map((agent) => [agent.id, agent.model ?? null])
		);
		polled.forEach((id, index) => {
			const result = results[index];
			if (!result || result.isPending) {
				return;
			}
			// A failed probe (even with older data cached) is usage unknown.
			limits.set(
				id,
				result.isError
					? null
					: chooseAgentLimit(result.data ?? null, models.get(id) ?? null)
			);
		});
		return limits;
	}, [agents, polled, results]);
}
