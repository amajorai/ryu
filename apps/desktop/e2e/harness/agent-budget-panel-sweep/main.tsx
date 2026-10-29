import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { AgentBudgetPanel } from "../../../src/components/agents/AgentBudgetPanel.tsx";
import { EntitlementProvider } from "../../../src/contexts/entitlement-context.tsx";
import type {
	BudgetRule,
	GatewayBudgetConfig,
} from "../../../src/lib/api/gateway.ts";
import { useNodeStore } from "../../../src/store/useNodeStore.ts";
import { gatewayBudgetWriteProofSchema } from "../../gateway-budget-proof.contracts.ts";
import "../../../src/index.css";

const AGENT_ID = "agent-budget-sweep-agent";
const CONFIG_KEY = "agent-budget-panel-sweep-config";
const NODE = {
	name: "agent-budget-panel-sweep",
	token: "agent-budget-panel-sweep-token",
	url: window.location.origin,
};

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

interface ProofState {
	failNextConfigRead: boolean;
	failNextConfigWrite: boolean;
	requests: CapturedRequest[];
	snapshot: () => { budgets: GatewayBudgetConfig; requests: CapturedRequest[] };
}

declare global {
	interface Window {
		__agentBudgetPanelSweep: ProofState;
	}
}

function rule(
	limit: number,
	action: BudgetRule["action"] = "notify"
): BudgetRule {
	return {
		action,
		alert: "warn",
		include: { model: true, media: true, tools: true },
		limit,
		...(action === "restrict" ? { restrict_max_tokens: 256 } : undefined),
	};
}

function initialBudgets(): GatewayBudgetConfig {
	return {
		agents: {
			[AGENT_ID]: rule(2_500_000),
			"agent-budget-sweep-keep": rule(3_000_000, "stop"),
		},
		session: rule(4_000_000),
		users: { "user-budget-sweep-keep": rule(5_000_000) },
	};
}

function readBudgets(): GatewayBudgetConfig {
	const stored = localStorage.getItem(CONFIG_KEY);
	if (stored) {
		return gatewayBudgetWriteProofSchema.parse(JSON.parse(stored)).budgets;
	}
	const budgets = initialBudgets();
	localStorage.setItem(CONFIG_KEY, JSON.stringify({ budgets }));
	return budgets;
}

function response<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

const proof: ProofState = {
	failNextConfigRead: false,
	failNextConfigWrite: false,
	requests: [],
	snapshot: () => ({ budgets: readBudgets(), requests: [...proof.requests] }),
};
window.__agentBudgetPanelSweep = proof;

const originalFetch = window.fetch.bind(window);
const fixtureFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const rawUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(rawUrl, window.location.href);
	const method = (
		init?.method ?? (input instanceof Request ? input.method : "GET")
	).toUpperCase();
	const path = `${url.pathname}${url.search}`;
	if (url.pathname === "/api/pi-config/catalog") {
		return response({ apiTypes: [], providers: [], thinkingLevels: [] });
	}
	if (url.pathname === "/api/auth/get-session") {
		return response({ session: null, user: null });
	}
	if (url.pathname === "/api/billing/subscription-status") {
		return response({ entitlement: null });
	}
	if (url.pathname === "/api/engines") {
		return response({ engines: [] });
	}
	if (url.pathname === "/api/engine/active") {
		return response({ active: null, available: [], running: false });
	}
	if (
		url.pathname === "/api/agents" ||
		url.pathname === "/api/agents/catalog"
	) {
		return response({ agents: [] });
	}
	if (url.pathname === "/api/gateway/config") {
		const body = isNativeText(init?.body) ? JSON.parse(init.body) : null;
		if (method === "PUT") {
			if (proof.failNextConfigWrite) {
				proof.failNextConfigWrite = false;
				proof.requests.push({ body, method, path, status: 503 });
				return response(
					{ error: "The Gateway is temporarily unavailable. Try again." },
					503
				);
			}
			const budgets = gatewayBudgetWriteProofSchema.parse(body).budgets;
			if (budgets) {
				localStorage.setItem(CONFIG_KEY, JSON.stringify({ budgets }));
			}
			proof.requests.push({ body, method, path, status: 200 });
			return response({ ok: true });
		}
		if (proof.failNextConfigRead) {
			proof.failNextConfigRead = false;
			proof.requests.push({ body: null, method, path, status: 503 });
			return response(
				{ error: "The Gateway is temporarily unavailable. Try again." },
				503
			);
		}
		proof.requests.push({ body: null, method, path, status: 200 });
		return response({ budgets: readBudgets() });
	}
	if (url.pathname === "/api/gateway/budget/spend") {
		const budgets = readBudgets();
		proof.requests.push({ body: null, method, path, status: 200 });
		return response({
			agents: { [AGENT_ID]: 400_000 },
			currency: "USD",
			limits: {
				agents: Object.fromEntries(
					Object.entries(budgets.agents).map(([id, configured]) => [
						id,
						configured.limit,
					])
				),
				session: budgets.session.limit,
				users: Object.fromEntries(
					Object.entries(budgets.users).map(([id, configured]) => [
						id,
						configured.limit,
					])
				),
			},
			reachable: true,
			sessions: {},
			unit: "micro_usd",
			users: {},
		});
	}
	if (url.pathname.startsWith("/api/")) {
		return response({ error: "unsupported_budget_fixture_route" }, 404);
	}
	return originalFetch(input, init);
};
window.fetch = Object.assign(fixtureFetch, {
	preconnect: window.fetch.preconnect,
});

useNodeStore.setState({
	cloudNodes: [],
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});

const queryClient = new QueryClient({
	defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});
const root = document.getElementById("root");
if (!root) {
	throw new Error("Agent budget panel proof root was not found.");
}

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<EntitlementProvider>
			<main className="min-h-screen bg-background p-8 text-foreground">
				<div className="mx-auto flex max-w-3xl flex-col gap-6">
					<header className="rounded-2xl border bg-card p-6 shadow-sm">
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							Production AgentBudgetPanel
						</p>
						<h1 className="mt-2 font-semibold text-2xl">Budget settings</h1>
						<p className="mt-2 text-muted-foreground text-sm">
							Agent: {AGENT_ID} · local stateful Gateway fixture
						</p>
					</header>
					<AgentBudgetPanel agentId={AGENT_ID} />
				</div>
			</main>
		</EntitlementProvider>
	</QueryClientProvider>
);

document.body.dataset.harnessReady = "1";
