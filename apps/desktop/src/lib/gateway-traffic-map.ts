// The desktop's traffic map binding (managed guardrails spec 07.4 and 07.7):
// the local gateway's topology from `/v1/config` and `/health`, and the live
// feed from Core's `/api/gateway/traffic` relay turned into canvas pulses.

import {
	type CanvasFeedState,
	type CanvasHealth,
	createEventDeduper,
	pulseFromEvent,
	type TopologyIndex,
	type TrafficPulse,
} from "@ryu/blocks/desktop/gateway-canvas/model.ts";
import {
	buildTopology,
	type TopologyInput,
} from "@ryu/blocks/desktop/gateway-canvas/topology.ts";
import type {
	ProviderCircuitState,
	TrafficEvent,
} from "@/src/lib/api/gateway.ts";

/** `subscribeGatewayTraffic` bound to a target. */
export type TrafficSubscribe = (
	onEvent: (event: TrafficEvent) => void,
	onError: (message: string, detail?: { status: number }) => void,
	onEnd: () => void,
	onOpen: () => void
) => () => void;

/** Pipeline stage names (`/v1/config` `pipeline_stages`) the map draws. */
const STAGE_INSPECTOR = "inspector";
const STAGE_EVALUATORS = "inline-input";

const PROVIDER_LABELS: Record<string, string> = {
	anthropic: "Anthropic",
	core: "Ryu Core models",
	genai: "Google Gemini",
	llamacpp: "llama.cpp",
	lmstudio: "LM Studio",
	local: "Local engine",
	mlx: "MLX",
	ollama: "Ollama",
	openai: "OpenAI",
	openrouter: "OpenRouter",
	vercel: "Vercel AI Gateway",
};

export function providerLabel(name: string): string {
	return (
		PROVIDER_LABELS[name] ??
		name
			.split(/[-_]/)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ")
	);
}

function circuitHealth(state: ProviderCircuitState | undefined): CanvasHealth {
	if (!state || state.circuit === "closed") {
		return "ok";
	}
	return state.circuit === "open" ? "down" : "degraded";
}

export interface LocalTopologyInput {
	/** Policies assigned per scope kind in the signed-in organization. */
	assignedPolicies?: Partial<Record<string, number>>;
	/** Whether the gateway answered `/health`. */
	gatewayReachable: boolean;
	pipelineStages?: readonly string[];
	providerHealth?: Record<string, ProviderCircuitState>;
	/** Provider names the gateway serves (`/health` `providers`). */
	providers: readonly string[];
	/** Whether a Ryu account (and so the control plane) is connected. */
	signedIn: boolean;
}

function policyDetail(count: number | undefined, fallback: string): string {
	if (!count) {
		return fallback;
	}
	return count === 1 ? "1 policy assigned" : `${count} policies assigned`;
}

/** The local gateway's map: route families, the full chain, its providers. */
export function buildLocalTopology(input: LocalTopologyInput) {
	const stages = new Set(input.pipelineStages ?? []);
	const known = (input.pipelineStages?.length ?? 0) > 0;
	const assigned = input.assignedPolicies ?? {};
	const chain: TopologyInput["chain"] = {
		"scope:agent": {
			detail: policyDetail(assigned.agent, "Agent policies"),
			label: "Agents",
		},
		"scope:key": {
			detail: policyDetail(assigned.key, "Key policies"),
			label: "Keys",
		},
		"scope:member": {
			detail: policyDetail(assigned.member, "Member policies"),
			label: "Members",
		},
		"scope:org": {
			detail: policyDetail(assigned.org, "Organization policies"),
			label: "Organization",
		},
		"scope:team": {
			detail: policyDetail(assigned.team, "Team policies"),
			label: "Teams",
		},
		"stage:budget": { detail: "Spend caps", label: "Budgets", locked: true },
		"stage:node": {
			detail: "Firewall and DLP",
			label: "This node's filters",
		},
		"stage:platform_floor": {
			detail: "Ryu-held credentials only",
			label: "Ryu platform floor",
			locked: true,
		},
		"stage:rate_limit": {
			detail: "Per key and client",
			label: "Rate limits",
			locked: true,
		},
		"stage:standing": {
			detail: "Ryu-managed traffic only",
			label: "Account standing",
			locked: true,
		},
	};
	if (!known || stages.has(STAGE_INSPECTOR)) {
		chain["stage:inspector"] = {
			detail: "Model-based screening",
			label: "Inspector",
		};
	}
	if (!known || stages.has(STAGE_EVALUATORS)) {
		chain["stage:evaluator"] = {
			detail: "Inline evaluators",
			label: "Evaluators",
		};
	}
	const providers = [...new Set(input.providers)].map((name) => ({
		health: circuitHealth(input.providerHealth?.[name]),
		label: providerLabel(name),
		name,
	}));
	providers.push({ health: "ok", label: "Other providers", name: "other" });
	const infra: NonNullable<TopologyInput["infra"]> = [
		{ detail: "Relays this feed", id: "infra:core", label: "Ryu Core" },
	];
	if (input.signedIn) {
		infra.push({
			detail: "Policies and standing",
			id: "infra:control_plane",
			label: "Ryu control plane",
		});
	}
	return buildTopology({
		chain,
		gateway: {
			detail: "Local node",
			health: input.gatewayReachable ? "ok" : "down",
			label: "This gateway",
		},
		infra,
		providers,
		route: { detail: "Model routing and cache", label: "Router" },
		surfaces: [
			{
				detail: "/v1/chat, /v1/responses",
				id: "surface:openai",
				label: "OpenAI-compatible API",
			},
			{
				detail: "/v1/messages",
				id: "surface:anthropic",
				label: "Anthropic Messages API",
			},
			{
				detail: "Your own subscriptions",
				id: "surface:passthrough",
				label: "Subscription passthrough",
			},
			{
				detail: "Media, tools, services",
				id: "surface:other",
				label: "Other routes",
			},
		],
	});
}

const FORBIDDEN = 403;
const MAX_BACKOFF_MS = 15_000;

/**
 * Follow the local traffic feed: reconnect with backoff, drop a reconnect's
 * replayed rows, map each terminal row to a pulse, reconnect after a clean
 * close too, and stop for good on a permission refusal. Returns the
 * unsubscribe function.
 */
export function followGatewayTraffic(
	subscribe: TrafficSubscribe,
	index: () => TopologyIndex,
	onPulse: (pulse: TrafficPulse) => void,
	onStatus: (state: CanvasFeedState) => void
): () => void {
	const fresh = createEventDeduper();
	let stopped = false;
	let attempt = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let unsubscribe: (() => void) | null = null;
	let current: CanvasFeedState["status"] | null = null;
	// Report a change of state only, never once per event.
	const report = (state: CanvasFeedState) => {
		if (state.status !== current || state.message) {
			current = state.status;
			onStatus(state);
		}
	};

	const connect = () => {
		if (stopped) {
			return;
		}
		report({ status: "connecting" });
		unsubscribe = subscribe(
			(event) => {
				attempt = 0;
				report({ status: "live" });
				if (!fresh(event)) {
					return;
				}
				const pulse = pulseFromEvent(event, index());
				if (pulse) {
					onPulse(pulse);
				}
			},
			(message, detail) => {
				if (detail?.status === FORBIDDEN) {
					if (!stopped) {
						report({ status: "denied" });
					}
					return;
				}
				retry(message);
			},
			// A clean close (a gateway restart) reconnects too; the replay it
			// serves is deduped above.
			() => retry("Traffic feed closed"),
			// An idle gateway sends no rows, so the open stream itself is live.
			// The backoff resets on the first row, not here, so a feed that
			// opens and closes at once still backs off.
			() => report({ status: "live" })
		);
	};
	const retry = (message: string) => {
		if (stopped) {
			return;
		}
		report({ message, status: "unavailable" });
		attempt += 1;
		const wait = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1));
		timer = setTimeout(connect, wait);
	};
	connect();
	return () => {
		stopped = true;
		if (timer) {
			clearTimeout(timer);
		}
		unsubscribe?.();
	};
}
