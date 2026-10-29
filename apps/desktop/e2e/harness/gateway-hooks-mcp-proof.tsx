import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { HooksSection } from "../../src/components/gateway/HooksSection.tsx";
import { McpSection } from "../../src/components/gateway/McpSection.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";
import { installGatewayHooksMcpProofFetch } from "./gateway-hooks-mcp-proof.mock.ts";
import "../../src/index.css";

declare global {
	interface Window {
		__RYU_GATEWAY_HOOKS_MCP_PROOF__?: {
			readState: () => ProofJsonValue;
		};
	}
}

const restoreFetch = installGatewayHooksMcpProofFetch();
window.addEventListener("pagehide", restoreFetch, { once: true });
window.__RYU_GATEWAY_HOOKS_MCP_PROOF__ = {
	readState: () =>
		parseProofJson(
			localStorage.getItem("ryu.gateway-hooks-mcp-proof.state") ?? "{}"
		),
};

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 0 } },
});
const target: ApiTarget = {
	token: "hooks-mcp-proof-token",
	url: "http://127.0.0.1:7980",
};
const canConfigure =
	new URLSearchParams(window.location.search).get("role") !== "viewer";
const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Missing root");
}

createRoot(rootElement).render(
	<QueryClientProvider client={queryClient}>
		<main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 bg-background p-8 text-foreground">
			<header className="flex items-start justify-between gap-6">
				<div>
					<p className="mb-2 text-primary text-xs tracking-(--tracking-section)">
						RYU · GATEWAY SETTINGS
					</p>
					<h1 className="font-medium text-3xl">Hooks and MCP</h1>
					<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
						Inspect lifecycle automation and the servers and tools exposed by
						this node.
					</p>
				</div>
				<div className="rounded-full border border-success/50 bg-success/60 px-3 py-1.5 font-medium text-success text-xs">
					LOCAL API FIXTURES
				</div>
			</header>
			<section aria-labelledby="hooks-proof-title" className="space-y-4">
				<h2 className="font-medium text-xl" id="hooks-proof-title">
					Hooks
				</h2>
				<HooksSection canConfigure={canConfigure} target={target} />
			</section>
			<section aria-labelledby="mcp-proof-title" className="space-y-4">
				<h2 className="font-medium text-xl" id="mcp-proof-title">
					MCP inventory
				</h2>
				<McpSection target={target} />
			</section>
		</main>
	</QueryClientProvider>
);
