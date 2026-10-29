// Proof page for the Gateway dialog's Traffic map section, driven by a mocked
// Core: `/api/gateway/traffic` streams synthetic SSE rows at about 50 a second
// (ids, layers and S-codes only; no request text). `?rate=` changes the rate.
// `?org=1` signs in to a mocked organization with two named policies, so the
// map's drag-to-assign palette and its conflict notice can be exercised.
// `?section=policies` opens the dialog's "Guardrail policies" section instead,
// against the same mocked organization.
import { I18nProvider } from "@ryu/i18n/react";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { TOKEN_KEY } from "../../lib/auth-client.ts";
import { GatewayDialog } from "../../src/components/gateway/GatewayDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import {
	DEFAULT_GATEWAY_ACP,
	DEFAULT_GATEWAY_COMPUTER_USE,
	DEFAULT_SESSION_BUDGET,
} from "../../src/lib/api/gateway.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

const NODE = {
	name: "traffic-map-proof",
	token: "traffic-map-proof-token",
	url: "http://127.0.0.1:7983",
};
const params = new URLSearchParams(window.location.search);
const RATE = Number(params.get("rate") ?? "50");
const ORG = params.get("org") === "1";

const ORG_ID = "proof-org";
const PROOF_USER = "proof-user";
const ACCOUNTS_KEY = "ryu_accounts";
const ACTIVE_USER_KEY = "ryu_active_user_id";
if (ORG) {
	const token = "traffic-map-proof-session";
	localStorage.setItem(TOKEN_KEY, token);
	localStorage.setItem(
		ACCOUNTS_KEY,
		JSON.stringify([
			{
				email: "proof@example.test",
				image: null,
				name: "Proof",
				token,
				userId: PROOF_USER,
			},
		])
	);
	localStorage.setItem(ACTIVE_USER_KEY, PROOF_USER);
} else {
	localStorage.removeItem(TOKEN_KEY);
	localStorage.removeItem(ACCOUNTS_KEY);
	localStorage.removeItem(ACTIVE_USER_KEY);
}

interface ProofAssignment {
	id: string;
	policyId: string;
	scope: { id: string; kind: string };
}

/** Assignment writes the map sent, for the drag-to-assign checks. */
const proof = {
	assignRequests: [] as unknown[],
	assignments: [] as ProofAssignment[],
};
Reflect.set(window, "__trafficMapProof", proof);

function proofPolicy(id: string, name: string) {
	return {
		archivedAt: null,
		assignments: proof.assignments.filter(
			(assignment) => assignment.policyId === id
		),
		description: "",
		id,
		locked: [],
		name,
		rules: {},
		version: 1,
	};
}

function verdict(
	decidedBy: string,
	action: string,
	categories: string[] = [],
	degraded: string | null = null
) {
	return {
		action,
		categories,
		decided_by: decidedBy,
		degraded,
		detector_ids: [],
		evaluator_ids: [],
	};
}

const ROUTES = [
	"/v1/chat/completions",
	"/v1/messages",
	"/v1/responses",
	"/passthrough/anthropic/v1/messages",
];
const PROVIDERS = ["openai", "anthropic", "ollama"];

let seq = 0;
function makeRow(): Record<string, unknown> {
	seq += 1;
	const roll = Math.random();
	const base = {
		api_key: "sk-loc***",
		cache_hit: false,
		error: null,
		event_type: "model_call",
		input_tokens: 120,
		kind: "completion",
		latency_ms: 80 + Math.round(Math.random() * 400),
		model: "proof-model",
		output_tokens: 40,
		provider: PROVIDERS[seq % PROVIDERS.length],
		provider_cost_micro_usd: 1200,
		request_id: `req_${seq}`,
		route: ROUTES[seq % ROUTES.length],
		seq,
		session_id: null,
		status: 200,
		ts: new Date().toISOString(),
		verdict: verdict("none", "allow"),
	};
	const refused = (
		decidedBy: string,
		status: number,
		codes: string[] = []
	) => ({
		...base,
		error: `blocked by ${decidedBy}`,
		kind: "failure",
		provider: "none",
		status,
		verdict: verdict(decidedBy, "block", codes),
	});
	if (roll < 0.04) {
		return refused("platform_floor", 451, ["S9"]);
	}
	if (roll < 0.07) {
		return refused("org", 403);
	}
	if (roll < 0.09) {
		return refused("rate_limit", 429);
	}
	if (roll < 0.11) {
		return refused("inspector", 403);
	}
	if (roll < 0.18) {
		return { ...base, verdict: verdict("node", "sanitize") };
	}
	if (roll < 0.24) {
		return { ...base, cache_hit: true, kind: "cache_hit" };
	}
	if (roll < 0.26) {
		return { ...base, verdict: verdict("none", "allow", [], "t2") };
	}
	return base;
}

const TICK_MS = 100;

function trafficStream(signal: AbortSignal | null | undefined): Response {
	const encoder = new TextEncoder();
	let timer = 0;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const perTick = Math.max(1, Math.round((RATE * TICK_MS) / 1000));
			let ticks = 0;
			timer = window.setInterval(() => {
				ticks += 1;
				let chunk = "";
				for (let index = 0; index < perTick; index += 1) {
					chunk += `event: traffic\ndata: ${JSON.stringify(makeRow())}\n\n`;
				}
				if (ticks % 20 === 0) {
					// Never read as a traffic row (spec 07.10 CV-3).
					chunk +=
						'event: degraded\ndata: {"reason":"proof"}\n\n: keep-alive\n\n';
				}
				controller.enqueue(encoder.encode(chunk));
			}, TICK_MS);
			signal?.addEventListener("abort", () => {
				window.clearInterval(timer);
				try {
					controller.close();
				} catch {
					// Already closed.
				}
			});
		},
		cancel() {
			window.clearInterval(timer);
		},
	});
	return new Response(stream, {
		headers: { "content-type": "text/event-stream" },
	});
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

const CONFIG = {
	acp: DEFAULT_GATEWAY_ACP,
	auth: { api_keys: [], require_auth: false },
	budgets: { agents: {}, session: DEFAULT_SESSION_BUDGET, users: {} },
	computer_use: DEFAULT_GATEWAY_COMPUTER_USE,
	firewall: {
		alert: "silent",
		custom_patterns: [],
		enabled: true,
		evaluators: [],
		inspector: {
			action: "block",
			enabled: true,
			min_chars: 40,
			mode: "both",
			model: "gemma-3-270m-it",
			timeout_ms: 1500,
		},
		locked_fields: [],
		log_detections: true,
		policy: "sanitize",
		redact_pii: true,
		redact_secrets: true,
		scan_inbound: true,
		scan_outbound: true,
	},
	firewall_agent_overlays: {},
	firewall_org_overlays: {},
	pipeline_stages: [
		"rate-limit",
		"firewall",
		"inspector",
		"inline-input",
		"policy",
		"route",
		"audit",
	],
	providers: {
		anthropic: null,
		core: null,
		genai: null,
		local: null,
		openai: null,
		openrouter: null,
	},
	routing: { default_provider: "openai", fallback_chain: [], model_map: {} },
};

const STATIC: Record<string, unknown> = {
	"/api/agents": { agents: [] },
	"/api/agents/catalog": { agents: [] },
	"/api/auth/get-session": { session: null, user: null },
	"/api/engine/active": { active: null, available: [], running: false },
	"/api/engines": { engines: [] },
	"/api/gateway/evaluators": { evaluators: [] },
	"/api/gateway/exec-approval-mode": { value: "enforce" },
	"/api/models/installed": { models: [] },
	"/api/pi-config": { config: { defaultProvider: "openai", providers: {} } },
	"/api/plugins": { apps: [] },
	"/api/plugins/contributions": { settings_tabs: [] },
	"/api/sidecar/status": { sidecars: [] },
};

function orgResponse(path: string, init: RequestInit | undefined): Response {
	const base = `/api/control-plane/orgs/${ORG_ID}`;
	if (path.endsWith("/api/control-plane/me/permissions")) {
		return json({ permissions: ["audit.view", "gateway.configure"] });
	}
	if (path.endsWith("/api/control-plane/orgs")) {
		return json({
			organizations: [{ id: ORG_ID, name: "Proof org", role: "owner" }],
		});
	}
	if (path.endsWith(`${base}/guardrail-policies`)) {
		return json({
			policies: [
				proofPolicy("pol_strict", "Strict screening"),
				proofPolicy("pol_models", "Approved models only"),
			],
		});
	}
	if (path.endsWith(`${base}/guardrail-assignments`)) {
		const body = JSON.parse(String(init?.body ?? "{}")) as ProofAssignment;
		proof.assignRequests.push(body);
		const taken = proof.assignments.some(
			(assignment) =>
				assignment.scope.kind === body.scope.kind &&
				assignment.scope.id === body.scope.id
		);
		if (taken) {
			return json(
				{
					code: "scope_already_assigned",
					message: "this scope already has a policy",
				},
				409
			);
		}
		const created = { ...body, id: `asg_${proof.assignments.length + 1}` };
		proof.assignments.push(created);
		return json(created, 201);
	}
	if (path.endsWith(`${base}/members`)) {
		return json({ members: [{ role: "owner", userId: PROOF_USER }] });
	}
	if (path.endsWith(`${base}/gateway-keys`)) {
		return json({
			keys: [
				{ id: "key_ci", keyPrefix: "ryu_ci", name: "CI", revokedAt: null },
				{ id: "key_bot", keyPrefix: "ryu_bt", name: "Bot", revokedAt: null },
			],
		});
	}
	if (path.endsWith(base)) {
		return json({
			name: "Proof org",
			teams: [
				{ id: "team_platform", name: "Platform" },
				{ id: "team_research", name: "Research" },
			],
		});
	}
	return json({});
}

window.fetch = async (input, init) => {
	const rawUrl = input instanceof Request ? input.url : String(input);
	const path = new URL(rawUrl, window.location.href).pathname;
	if (ORG && path.includes("/api/control-plane/")) {
		return orgResponse(path, init);
	}
	if (ORG && path.endsWith("/api/auth/get-session")) {
		return json({
			session: { activeOrganizationId: ORG_ID },
			user: { email: "proof@example.test", id: PROOF_USER, name: "Proof" },
		});
	}
	if (path.endsWith("/api/gateway/traffic")) {
		return trafficStream(init?.signal);
	}
	if (path.endsWith("/api/gateway/status")) {
		return json({
			health: {
				auth_required: false,
				providers: ["openai", "anthropic", "ollama"],
				status: "ok",
				version: "proof",
			},
			metrics: {
				provider_health: {
					anthropic: {
						circuit: "half_open",
						consecutive_failures: 2,
						open_for_secs: null,
					},
				},
			},
			reachable: true,
			url: NODE.url,
		});
	}
	if (path.endsWith("/api/gateway/config")) {
		return json(CONFIG);
	}
	if (path.includes("/api/preferences/")) {
		return json({ value: null });
	}
	return json(STATIC[path] ?? {});
};

const queryClient = new QueryClient({
	defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

useNodeStore.setState({
	cloudNodes: [],
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});
useGatewayDialog.getState().openGateway(params.get("section") ?? "traffic-map");

function ProofSurface() {
	const gatewayOpen = useGatewayDialog((store) => store.open);
	const gatewaySection = useGatewayDialog((store) => store.section);
	const setGatewayOpen = useGatewayDialog((store) => store.setOpen);
	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<ThemeProvider
					attribute="class"
					defaultTheme={params.get("theme") ?? "dark"}
					enableSystem={false}
				>
					<main className="min-h-screen bg-background p-8 text-foreground">
						<TooltipProvider delay={0}>
							<GatewayDialog
								defaultSection={gatewaySection}
								onOpenChange={setGatewayOpen}
								open={gatewayOpen}
							/>
						</TooltipProvider>
					</main>
				</ThemeProvider>
			</EntitlementProvider>
		</AppSurfaceProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<I18nProvider>
				<MemoryRouter>
					<ProofSurface />
				</MemoryRouter>
			</I18nProvider>
		</QueryClientProvider>
	);
}
