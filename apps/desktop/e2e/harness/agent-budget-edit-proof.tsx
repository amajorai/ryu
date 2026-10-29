import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { AgentBudgetPanel } from "../../src/components/agents/AgentBudgetPanel.tsx";
import "../../src/index.css";

const AGENT_ID = "proof-agent";
const budgetRule = {
	action: "restrict",
	alert: "warn",
	limit: 1_000_000,
	restrict_max_tokens: 256,
};

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const url = isNativeText(input) ? input : input.url;
	if (init?.method === "PUT" && url.includes("/api/gateway/config")) {
		return new Response(JSON.stringify({ ok: true }), {
			headers: { "Content-Type": "application/json" },
			status: 200,
		});
	}
	if (url.includes("/api/gateway/config")) {
		return new Response(
			JSON.stringify({
				budgets: {
					agents: { [AGENT_ID]: budgetRule },
					session: { action: "notify", alert: "silent", limit: 0 },
					users: {},
				},
			}),
			{ headers: { "Content-Type": "application/json" }, status: 200 }
		);
	}
	if (url.includes("/api/gateway/budget/spend")) {
		return new Response(
			JSON.stringify({
				agents: { [AGENT_ID]: 125_000 },
				limits: { agents: { [AGENT_ID]: 1_000_000 }, session: 0, users: {} },
				currency: "USD",
				reachable: true,
				sessions: {},
				unit: "micro_usd",
				users: {},
			}),
			{ headers: { "Content-Type": "application/json" }, status: 200 }
		);
	}
	return originalFetch(input, init);
};

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={queryClient}>
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<header>
					<p className="font-medium text-primary text-sm uppercase tracking-(--tracking-section)">
						Agent editor
					</p>
					<h1 className="mt-2 font-semibold text-3xl tracking-tight">
						Proof Agent
					</h1>
					<p className="mt-2 text-muted-foreground text-sm">
						Model &amp; provider settings
					</p>
				</header>
				<AgentBudgetPanel agentId={AGENT_ID} />
			</div>
		</main>
	</QueryClientProvider>
);

document.body.setAttribute("data-harness-ready", "1");
