import "@fontsource-variable/geist";
import "@fontsource-variable/inter";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { AgentSmartRouteOverride } from "../../src/components/agents/AgentSmartRouteOverride.tsx";
import { type Node, useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const AGENT_ID = "agent-smart-route-fixture";
const TARGET_NODE: Node = {
	name: "local",
	token: null,
	url: window.location.origin,
	userJwt: null,
};
const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			refetchOnWindowFocus: false,
			retry: false,
		},
	},
});

useNodeStore.setState({
	defaultNode: TARGET_NODE.name,
	localNodes: [TARGET_NODE],
	nodes: [TARGET_NODE],
});

function ProofSurface() {
	return (
		<ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
			<main className="min-h-dvh bg-background p-8 text-foreground">
				<div className="mx-auto flex max-w-4xl flex-col gap-6">
					<header className="rounded-2xl border bg-card p-6 shadow-sm">
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							Production component proof · local gateway config fixture
						</p>
						<h1 className="mt-2 font-semibold text-2xl">
							Per-agent smart routing
						</h1>
						<p className="mt-2 text-muted-foreground text-sm">
							The production AgentSmartRouteOverride reads and writes the
							per-agent override in the gateway config through the real Desktop
							API client. A local browser fixture stores the gateway config; no
							model or provider is contacted.
						</p>
						<p className="mt-2 font-mono text-xs">Agent: {AGENT_ID}</p>
					</header>
					<section
						aria-label="Agent route override editor"
						className="rounded-2xl border bg-card p-6 shadow-sm"
						data-testid="agent-route-override"
					>
						<AgentSmartRouteOverride agentId={AGENT_ID} />
					</section>
				</div>
				<Toaster position="bottom-right" theme="light" />
			</main>
		</ThemeProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Per-agent routing proof root not found.");
}

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<ProofSurface />
	</QueryClientProvider>
);
document.body.dataset.harnessReady = "1";
