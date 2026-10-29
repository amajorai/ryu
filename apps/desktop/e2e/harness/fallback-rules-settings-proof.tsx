declare const window: ProofWindow;

import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { z } from "zod";
import { TOKEN_KEY } from "../../lib/auth-client.ts";
import { GatewayDialog } from "../../src/components/gateway/GatewayDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import type { RoutingPolicy } from "../../src/lib/api/routing.ts";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { queryClient as appQueryClient } from "../../src/lib/query-client.ts";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

// Gateway opens only in Console; grant the access App's ProductModeAccessSync
// would grant a local node.
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

const API_BASE = "http://127.0.0.1:5365";
const POLICY_KEY = "fallback-rules-settings-proof-policy";
const NODE = {
	managed: false,
	name: "fallback-rules-settings-proof",
	orgId: null,
	token: null,
	url: API_BASE,
	userJwt: null,
};

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number | null;
}

interface ProofSnapshot {
	calls: CapturedRequest[];
	policy: ReturnType<typeof JSON.parse>;
	writeFailuresLeft: number;
}

interface ProofWindow extends Window {
	__fallbackRulesProof: {
		slowNextWrite: () => void;
		snapshot: () => ProofSnapshot;
	};
}

declare global {
	interface Window {
		__fallbackRulesProof: ProofWindow["__fallbackRulesProof"];
	}
}

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			refetchOnWindowFocus: false,
			retry: 1,
			retryDelay: 20,
		},
		mutations: { retry: false },
	},
});

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function emptySelection() {
	return {
		access_mode: "",
		agent_id: "",
		effort: "",
		model: "",
		provider: "",
		thinking_level: "",
	};
}

function initialPolicy(scenario: string): RoutingPolicy {
	if (scenario === "empty") {
		return { rules: [] };
	}
	const rules: RoutingPolicy["rules"] = [
		{
			applies_to_agents: [],
			enabled: true,
			fallback: emptySelection(),
			id: "proof-wallet-rule",
			notify: true,
			when: { source: "ryu_credits", below_usd: 5 },
		},
		{
			applies_to_agents: [],
			enabled: false,
			fallback: emptySelection(),
			id: "proof-subscription-rule",
			notify: false,
			when: {
				agent_id: "claude",
				remaining_below_percent: 50,
				source: "subscription_window",
				window: "",
			},
		},
	];
	return { rules: scenario === "single" ? rules.slice(0, 1) : rules };
}

const policyEnvelopeSchema = z
	.object({ rules: z.array(z.json()) })
	.passthrough();

function storedPolicy() {
	const stored = localStorage.getItem(POLICY_KEY);
	if (!stored) {
		return { rules: [] };
	}
	try {
		return policyEnvelopeSchema.parse(parseProofJson(stored));
	} catch {
		return { rules: [] };
	}
}

function isPolicyBody(
	value: ProofJsonValue
): value is ProofJsonValue & { rules: ProofJsonValue[] } {
	return policyEnvelopeSchema.safeParse(value).success;
}

function installFixture(): void {
	const params = new URLSearchParams(window.location.search);
	const scenario = params.get("scenario") ?? "lifecycle";
	const reset = params.get("reset") === "true";
	if (reset) {
		localStorage.removeItem(POLICY_KEY);
	}
	if (localStorage.getItem(POLICY_KEY) === null) {
		localStorage.setItem(POLICY_KEY, JSON.stringify(initialPolicy(scenario)));
	}
	if (reset) {
		params.delete("reset");
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${params.size ? `?${params}` : ""}`
		);
	}
	const denied = params.get("permission") === "denied";
	if (denied) {
		localStorage.setItem(TOKEN_KEY, "fallback-rules-proof-session");
	} else {
		localStorage.removeItem(TOKEN_KEY);
	}

	let policyReadFailuresLeft =
		params.get("failPolicyReadOnce") === "true" ? 1 : 0;
	let writeFailuresLeft = Number(params.get("failPolicyWrites") ?? "0");
	let slowWritesLeft = 0;
	const calls: CapturedRequest[] = [];
	window.__fallbackRulesProof = {
		slowNextWrite: () => {
			slowWritesLeft += 1;
		},
		snapshot: () => ({
			calls: structuredClone(calls),
			policy: structuredClone(storedPolicy()),
			writeFailuresLeft,
		}),
	};
	const tauriWindow = window;
	const proofTauriKernel = {
		invoke: async () => undefined,
		transformCallback: () => 1,
	};
	// SAFETY: This browser fixture installs this exact complete private two-method kernel.
	// The mutation view owns only that fixture slot, not a public Tauri result contract.
	(
		tauriWindow as Omit<typeof tauriWindow, "__TAURI_INTERNALS__"> & {
			__TAURI_INTERNALS__: typeof proofTauriKernel;
		}
	).__TAURI_INTERNALS__ = proofTauriKernel;
	appQueryClient.clear();
	queryClient.clear();

	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(rawUrl, window.location.href);
		const method = (init?.method ?? "GET").toUpperCase();
		const body = isNativeText(init?.body) ? parseProofJson(init.body) : null;
		let status = 200;
		let response: Response;
		const call: CapturedRequest = {
			body,
			method,
			path: url.pathname,
			status: null,
		};
		calls.push(call);

		if (url.pathname === "/api/routing/policy" && method === "GET") {
			if (policyReadFailuresLeft > 0) {
				policyReadFailuresLeft -= 1;
				status = 503;
				response = json({ message: "Temporary policy read failure" }, status);
			} else {
				response = json({
					...storedPolicy(),
					credit_providers: ["openai", "anthropic"],
				});
			}
		} else if (url.pathname === "/api/routing/policy" && method === "PUT") {
			if (slowWritesLeft > 0) {
				slowWritesLeft -= 1;
				await new Promise((resolve) => window.setTimeout(resolve, 350));
			}
			if (writeFailuresLeft > 0) {
				writeFailuresLeft -= 1;
				status = 503;
				response = json({ message: "Temporary policy write failure" }, status);
			} else if (isPolicyBody(body)) {
				localStorage.setItem(POLICY_KEY, JSON.stringify(body));
				response = json({ ok: true, rules: body.rules.length });
			} else {
				status = 400;
				response = json(
					{ message: "Expected a routing policy with rules" },
					status
				);
			}
		} else if (url.pathname === "/api/gateway/status") {
			response = json({
				health: { auth_required: false, providers: ["openai"], status: "ok" },
				metrics: {
					cache: { exact_hits: 0, hit_rate: 0, misses: 0, semantic_hits: 0 },
					composio: { calls: 0 },
					provider_health: {},
					provider_quota: {},
					providers: { errors: {}, requests: {} },
					requests: {
						budget_downgraded: 0,
						budget_exceeded: 0,
						budget_notified: 0,
						budget_restricted: 0,
						errors: 0,
						firewall_blocked: 0,
						rate_limited: 0,
						total: 0,
					},
					tokens: { input: 0, output: 0 },
				},
				openai_configured: true,
				reachable: true,
				url: API_BASE,
			});
		} else if (url.pathname === "/api/gateway/config") {
			response = json({ auth: { api_keys: [], require_auth: false } });
		} else if (url.pathname === "/api/agents") {
			response = json({
				agents: [
					{
						id: "claude",
						name: "Claude",
						engine: "claude",
						transport: "acp",
						installed: true,
						recommended: false,
						lifecycle_status: "active",
					},
					{
						id: "codex",
						name: "Codex",
						engine: "codex",
						transport: "acp",
						installed: true,
						recommended: false,
						lifecycle_status: "active",
					},
				],
			});
		} else if (url.pathname === "/api/pi-config/catalog") {
			response = json({
				apiTypes: ["openai-completions"],
				providers: [
					{
						accounts: [],
						active: true,
						api: "openai-completions",
						authEnv: "OPENAI_API_KEY",
						authKind: "api-key",
						configured: true,
						custom: false,
						id: "openai",
						label: "OpenAI",
						routing: "gateway",
						suggestedModels: ["gpt-4o-mini"],
						supportsDiscovery: true,
					},
				],
				thinkingLevels: ["low", "medium"],
			});
		} else if (url.pathname === "/api/engines") {
			response = json({ engines: [] });
		} else if (url.pathname === "/api/engine/active") {
			response = json({ active: null, available: [], running: false });
		} else if (url.pathname === "/api/plugins") {
			response = json({ apps: [] });
		} else if (url.pathname === "/api/plugins/contributions") {
			response = json({ settings_tabs: [] });
		} else if (url.pathname === "/api/auth/get-session") {
			response = json({
				session: denied ? { activeOrganizationId: "org-fallback-proof" } : null,
				user: denied ? { id: "fallback-proof-user" } : null,
			});
		} else if (url.pathname === "/api/control-plane/orgs") {
			response = json({
				organizations: [
					{
						canSendFrom: false,
						id: "org-fallback-proof",
						isPersonal: false,
						name: "Fallback proof org",
						role: "member",
						slug: "fallback-proof-org",
					},
				],
			});
		} else if (url.pathname === "/api/control-plane/me/permissions") {
			response = json({
				permissions: denied ? [] : ["gateway.configure"],
			});
		} else if (url.pathname === "/api/auth/status") {
			response = json({ authenticated: false, token: null });
		} else {
			response = json({});
		}
		call.status = status;
		return response;
	};
}

function ProofSurface() {
	const open = useGatewayDialog((state) => state.open);
	const section = useGatewayDialog((state) => state.section);
	const setOpen = useGatewayDialog((state) => state.setOpen);
	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<main className="min-h-screen bg-background p-6 text-foreground">
						<header className="mx-auto mb-4 max-w-7xl">
							<p className="text-muted-foreground text-xs uppercase tracking-wide">
								Gateway settings proof
							</p>
							<h1 className="mt-1 font-semibold text-xl">Fallback rules</h1>
						</header>
						<GatewayDialog
							defaultSection={section}
							onOpenChange={setOpen}
							open={open}
						/>
						<Toaster position="bottom-right" theme="dark" />
					</main>
				</ThemeProvider>
			</EntitlementProvider>
		</AppSurfaceProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing proof root");
}

useNodeStore.setState({
	cloudNodes: [],
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});
useGatewayDialog.getState().openGateway("routing");
setInterfaceLevel("expert");
installFixture();

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<I18nProvider>
			<MemoryRouter>
				<ProofSurface />
			</MemoryRouter>
		</I18nProvider>
	</QueryClientProvider>
);

export type FallbackRulesProofPublisher = ProofWindow["__fallbackRulesProof"];
