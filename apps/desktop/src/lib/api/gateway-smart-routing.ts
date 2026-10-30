import { ApiError, type ApiTarget } from "./client.ts";
import {
	fetchGatewayConfig,
	updateGatewayConfig,
} from "./gateway-config-api.ts";
import type { Evaluator } from "./gateway-evaluators.ts";
import type { SmartRoutingConfig } from "./gateway-routing-config.ts";
import {
	isOpenRoutePool,
	type RoutePool,
	routingViewIncludesSmartRouting,
} from "./gateway-routing-helpers.ts";
import { restartGateway } from "./system.ts";

/** Thrown when the gateway does not report `routing.smart_routing`. */
export class SmartRoutingUnavailableError extends Error {
	constructor() {
		super(
			"This gateway does not report smart routing, so it has no routing pools."
		);
		this.name = "SmartRoutingUnavailableError";
	}
}

/** One agent's routing pool from the gateway config, or null when it has none. */
export async function fetchAgentRoutePool(
	target: ApiTarget,
	agentId: string
): Promise<RoutePool | null> {
	const cfg = await fetchGatewayConfig(target);
	if (!routingViewIncludesSmartRouting(cfg.routing)) {
		throw new SmartRoutingUnavailableError();
	}
	return cfg.routing.smart_routing?.agent_pools?.[agentId] ?? null;
}

/**
 * Set (or clear, for null or an open pool) one agent's routing pool. Reads the
 * current routing and writes it back whole with only this agent's entry
 * changed, because `PUT /v1/config` replaces the routing section wholesale.
 * Refuses when the gateway does not serve `smart_routing`, so a fabricated
 * default can never overwrite a hand-written config.
 */
export async function saveAgentRoutePool(
	target: ApiTarget,
	agentId: string,
	pool: RoutePool | null
): Promise<void> {
	await updateSmartRouting(target, (current) => {
		const agentPools = { ...(current.agent_pools ?? {}) };
		if (pool === null || isOpenRoutePool(pool)) {
			delete agentPools[agentId];
		} else {
			agentPools[agentId] = pool;
		}
		return { ...current, agent_pools: agentPools };
	});
}

/**
 * One agent's stored routing override (`smart_routing.agent_routes`), or null
 * when it routes with the node's smart routing.
 */
export async function fetchAgentRouteOverride(
	target: ApiTarget,
	agentId: string
): Promise<SmartRoutingConfig | null> {
	const cfg = await fetchGatewayConfig(target);
	if (!routingViewIncludesSmartRouting(cfg.routing)) {
		throw new SmartRoutingUnavailableError();
	}
	return cfg.routing.smart_routing?.agent_routes?.[agentId] ?? null;
}

/**
 * Set (or clear, for null) one agent's stored routing override. The gateway
 * applies it to every request attributed to the agent, ACP agents included.
 * Same read-merge-write and refusal rules as {@link saveAgentRoutePool}.
 */
export async function saveAgentRouteOverride(
	target: ApiTarget,
	agentId: string,
	config: SmartRoutingConfig | null
): Promise<void> {
	await updateSmartRouting(target, (current) => {
		const agentRoutes = { ...(current.agent_routes ?? {}) };
		if (config === null) {
			delete agentRoutes[agentId];
		} else {
			// An override's own per-agent maps are ignored by the gateway; keep
			// them off the wire so the stored entry stays small.
			const { agent_pools: _pools, agent_routes: _routes, ...own } = config;
			agentRoutes[agentId] = own;
		}
		return { ...current, agent_routes: agentRoutes };
	});
}

/** Attempts per save before a revision conflict is surfaced to the caller. */
const SMART_ROUTING_SAVE_ATTEMPTS = 3;

/** Tail of the in-flight smart-routing saves, per gateway target. */
const smartRoutingSaveQueues = new Map<string, Promise<void>>();

/**
 * Read the gateway config, apply `mutate` to `routing.smart_routing`, and write
 * the whole routing section back (`PUT /v1/config` replaces it wholesale).
 * Refuses when the gateway does not serve `smart_routing`, so a fabricated
 * default can never overwrite a hand-written config.
 *
 * Lost updates are prevented two ways. Saves to the same target run one after
 * another, each reading the config the previous one wrote. Every write also
 * carries the read's `expectedRevision`, so a write that lands in between
 * (another window, or the Gateway dialog's own revision-checked save) makes the
 * gateway answer 409; `mutate` only changes this caller's entry, so it is
 * re-applied to a fresh read instead of overwriting the other change.
 */
function updateSmartRouting(
	target: ApiTarget,
	mutate: (current: SmartRoutingConfig) => SmartRoutingConfig
): Promise<void> {
	const key = target.url;
	const previous = smartRoutingSaveQueues.get(key) ?? Promise.resolve();
	const run = previous
		.catch(() => undefined)
		.then(() => writeSmartRouting(target, mutate));
	const tail = run.catch(() => undefined);
	smartRoutingSaveQueues.set(key, tail);
	tail.then(() => {
		if (smartRoutingSaveQueues.get(key) === tail) {
			smartRoutingSaveQueues.delete(key);
		}
	});
	return run;
}

async function writeSmartRouting(
	target: ApiTarget,
	mutate: (current: SmartRoutingConfig) => SmartRoutingConfig
): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		const cfg = await fetchGatewayConfig(target);
		const current = cfg.routing.smart_routing;
		if (!(routingViewIncludesSmartRouting(cfg.routing) && current)) {
			throw new SmartRoutingUnavailableError();
		}
		try {
			await updateGatewayConfig(target, {
				routing: { ...cfg.routing, smart_routing: mutate(current) },
				expectedRevision: cfg.configRevision ?? undefined,
			});
			return;
		} catch (error) {
			const conflict = error instanceof ApiError && error.status === 409;
			if (!conflict || attempt >= SMART_ROUTING_SAVE_ATTEMPTS) {
				throw error;
			}
		}
	}
}

/**
 * Persist the full custom-evaluator set to the gateway, then restart it so the
 * new entry becomes catalogued + runnable (`custom_evaluators` is a startup
 * snapshot, like routing — invisible until the gateway respawns).
 *
 * Read the current custom set from `fetchEvaluators()` filtered by
 * `builtin === false`, add/replace your entry, and pass the COMPLETE array here
 * (full-replacement). Resolves once the restart request completes; callers
 * should refetch the catalog after this resolves.
 */
export async function saveCustomEvaluators(
	target: ApiTarget,
	customEvaluators: Evaluator[],
	signal?: AbortSignal
): Promise<void> {
	const result = await updateGatewayConfig(
		target,
		{ custom_evaluators: customEvaluators },
		signal
	);
	// Current gateways apply custom evaluators live and report
	// `applied.restartRequired: false`. An older gateway that omits the receipt
	// still reads them only at startup, so it is restarted as before.
	// restartGateway never throws for the externally-managed / failure cases.
	if (configUpdateNeedsRestart(result)) {
		await restartGateway(target);
	}
}

/** Whether a `PUT /api/gateway/config` receipt asks for a gateway restart. */
export function configUpdateNeedsRestart(receipt: object): boolean {
	if (!("applied" in receipt)) {
		return true;
	}
	const applied = receipt.applied;
	if (typeof applied !== "object" || applied === null) {
		return true;
	}
	return !("restartRequired" in applied) || applied.restartRequired !== false;
}

/**
 * Convenience: add or replace one custom evaluator in the current set and
 * persist. `existing` should be the current custom set (from `fetchEvaluators`
 * filtered by `builtin === false`).
 */
export async function saveCustomEvaluator(
	target: ApiTarget,
	evaluator: Evaluator,
	existing: Evaluator[],
	signal?: AbortSignal
): Promise<void> {
	const next = existing.filter((e) => e.id !== evaluator.id);
	next.push({ ...evaluator, builtin: false });
	await saveCustomEvaluators(target, next, signal);
}

/**
 * Convenience: remove one custom evaluator by id and persist. `existing` is the
 * current custom set (from `fetchEvaluators` filtered by `builtin === false`).
 */
export async function deleteCustomEvaluator(
	target: ApiTarget,
	id: string,
	existing: Evaluator[],
	signal?: AbortSignal
): Promise<void> {
	const next = existing.filter((e) => e.id !== id);
	await saveCustomEvaluators(target, next, signal);
}
