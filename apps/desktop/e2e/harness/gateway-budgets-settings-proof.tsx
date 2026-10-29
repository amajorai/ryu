import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { BudgetsCard } from "../../src/components/gateway/GatewayDialog.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import type { GatewayBudgetConfig } from "../../src/lib/api/gateway.ts";
import { parseProofJson } from "../fixture-json.ts";
import { gatewayBudgetWriteProofSchema } from "../gateway-budget-proof.contracts.ts";
import "../../src/index.css";

const TARGET: ApiTarget = {
	token: "gateway-budgets-proof-token",
	url: "http://127.0.0.1:7980",
};

const STORAGE_KEY = "gateway-budgets-proof-config";

// The Desktop checks GET /api/gateway/config against the full served shape
// before any card sees it, so a fixture that returns only `budgets` is rejected
// and the card shows a validation error instead of the budget rows. A gateway
// always serves `auth` and `providers`; the other sections are optional.
const SERVED_CONFIG_BASE = {
	auth: { api_keys: [], require_auth: false },
	providers: {
		anthropic: null,
		core: null,
		genai: null,
		local: null,
		openai: null,
		openrouter: null,
	},
};

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

interface GatewayBudgetsProofState {
	failNextConfigWrite: boolean;
	requests: CapturedRequest[];
	snapshot: () => { budgets: GatewayBudgetConfig; requests: CapturedRequest[] };
}

declare global {
	interface Window {
		__gatewayBudgetsProof: GatewayBudgetsProofState;
	}
}

function initialBudgets(): GatewayBudgetConfig {
	return {
		users: {
			"existing-user": {
				action: "stop",
				alert: "fanout",
				include: { model: false, media: true, tools: true },
				limit: 2_500_001,
			},
		},
		agents: {
			"agent-existing": {
				action: "notify",
				alert: "silent",
				include: { model: true, media: true, tools: false },
				limit: 3_000_000,
			},
		},
		session: {
			action: "notify",
			alert: "warn",
			include: { model: true, media: false, tools: true },
			limit: 4_000_000,
		},
	};
}

function readPersistedBudgets(): GatewayBudgetConfig {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored) {
		return gatewayBudgetWriteProofSchema.parse({ budgets: JSON.parse(stored) })
			.budgets;
	}
	const budgets = initialBudgets();
	localStorage.setItem(STORAGE_KEY, JSON.stringify(budgets));
	return budgets;
}

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function installGatewayMock(): void {
	// The production ThemeProvider applies the theme class to <html>. Dialogs
	// render through a body portal, so a class only on the rendered main would
	// leave their CSS variables in the default light theme.
	document.documentElement.classList.add("dark");
	const query = new URLSearchParams(window.location.search);
	const state: GatewayBudgetsProofState = {
		failNextConfigWrite: false,
		requests: [],
		snapshot() {
			return {
				budgets: readPersistedBudgets(),
				requests: structuredClone(state.requests),
			};
		},
	};
	window.__gatewayBudgetsProof = state;
	if (query.get("failRead") === "true") {
		localStorage.setItem("gateway-budgets-proof-fail-read", "true");
	}

	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const { pathname } = new URL(rawUrl, window.location.href);
		const method = (init?.method ?? "GET").toUpperCase();
		const body = isNativeText(init?.body) ? parseProofJson(init.body) : null;
		const capturedRequest = { body, method, path: pathname, status: 0 };
		state.requests.push(capturedRequest);

		if (pathname.endsWith("/api/gateway/config")) {
			if (method === "PUT") {
				if (state.failNextConfigWrite) {
					state.failNextConfigWrite = false;
					capturedRequest.status = 503;
					return jsonResponse({ message: "gateway_fixture_write_failed" }, 503);
				}
				const patch = gatewayBudgetWriteProofSchema.parse(body);
				if (patch.budgets) {
					localStorage.setItem(STORAGE_KEY, JSON.stringify(patch.budgets));
				}
				capturedRequest.status = 200;
				return jsonResponse({ ok: true });
			}
			if (localStorage.getItem("gateway-budgets-proof-fail-read") === "true") {
				localStorage.removeItem("gateway-budgets-proof-fail-read");
				capturedRequest.status = 503;
				return jsonResponse({ message: "gateway_fixture_read_failed" }, 503);
			}
			capturedRequest.status = 200;
			return jsonResponse({
				...SERVED_CONFIG_BASE,
				budgets: readPersistedBudgets(),
			});
		}
		if (pathname.endsWith("/api/agents")) {
			capturedRequest.status = 200;
			return jsonResponse({
				agents: [
					{ id: "agent-alpha", name: "Agent Alpha" },
					{ id: "agent-existing", name: "Existing Agent" },
				],
			});
		}
		return jsonResponse({});
	};
}

function ProofArtifact() {
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { retry: false, refetchOnWindowFocus: false },
				},
			}),
		[]
	);
	const canConfigure =
		new URLSearchParams(window.location.search).get("readOnly") !== "true";

	return (
		<EntitlementProvider>
			<QueryClientProvider client={queryClient}>
				<main className="dark min-h-screen bg-background px-8 py-8 text-foreground">
					<div className="mx-auto max-w-4xl">
						<header className="mb-6">
							<div className="text-primary text-xs tracking-widest">
								RYU · LIVE REACT PROOF
							</div>
							<h1 className="mt-2 font-semibold text-3xl">
								Gateway user and agent budgets
							</h1>
							<p className="mt-2 max-w-2xl text-base text-muted-foreground leading-6">
								Rendered budget controls backed by a stateful Gateway config
								fixture. Writes persist across reloads and their full payloads
								are asserted.
							</p>
						</header>
						<section className="rounded-2xl border border-border bg-card p-5">
							<BudgetsCard canConfigure={canConfigure} target={TARGET} />
						</section>
					</div>
				</main>
			</QueryClientProvider>
		</EntitlementProvider>
	);
}

installGatewayMock();
createRoot(document.getElementById("root")!).render(<ProofArtifact />);
