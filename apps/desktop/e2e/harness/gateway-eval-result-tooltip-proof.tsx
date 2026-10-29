import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { TOKEN_KEY } from "../../lib/auth-client.ts";
import { GatewayDialog } from "../../src/components/gateway/GatewayDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import type { EvalRunResult } from "../../src/lib/api/gateway.ts";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const NODE = {
	managed: true,
	name: "gateway-eval-result-tooltip-proof",
	orgId: "eval-result-tooltip-proof-org",
	token: "gateway-eval-result-tooltip-proof-token",
	url: "http://127.0.0.1:7982",
	userJwt: null,
};

interface CapturedEvalRequest {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
}

declare global {
	interface Window {
		__gatewayEvalResultTooltipProof: {
			requests: CapturedEvalRequest[];
		};
	}
}

const LONG_PROMPT =
	"A release engineer opens a production incident after a deploy, compares the request latency with the previous stable build, and chooses the safest rollback plan.";

function result(): EvalRunResult {
	return {
		aggregate: {
			latency_available_cases: 1,
			mean_latency: 0.82,
			mean_overall: 0.91,
			mean_substring_match: 0.8,
			mean_token_efficiency: 0.76,
			policy_available_cases: 1,
			policy_pass_rate: 1,
			total_cases: 1,
		},
		cases: [
			{
				assertion_score: 1,
				assertions: [],
				assertions_pass: true,
				latency_available: true,
				latency_score: 0.82,
				overall: 0.91,
				policy_available: true,
				policy_pass: true,
				prompt: LONG_PROMPT,
				response_text: "Roll back the deployment and verify the stable build.",
				substring_match: 0.8,
				token_efficiency: 0.76,
			},
		],
	};
}

useNodeStore.setState({
	cloudNodes: [NODE],
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});
localStorage.setItem(TOKEN_KEY, "gateway-eval-result-tooltip-proof-session");
setInterfaceLevel("expert");

const evalRequests: CapturedEvalRequest[] = [];
window.__gatewayEvalResultTooltipProof = { requests: evalRequests };
const fixtureFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
	const url = new URL(
		input instanceof Request ? input.url : String(input),
		window.location.href
	);
	if (url.pathname.endsWith("/api/gateway/evals/run")) {
		const method = (init?.method ?? "POST").toUpperCase();
		const rawBody =
			init?.body ??
			(input instanceof Request ? await input.clone().text() : null);
		const body = isNativeText(rawBody) ? parseProofJson(rawBody) : null;
		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined)
		);
		evalRequests.push({
			authorization: headers.get("authorization"),
			body,
			method,
			path: url.pathname,
		});
		return Response.json(result());
	}
	return fixtureFetch(input, init);
};

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { refetchOnWindowFocus: false, retry: false },
	},
});

function ProofSurface() {
	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<main className="min-h-screen bg-background p-8 text-foreground">
						<GatewayDialog
							defaultSection="evals"
							onOpenChange={() => undefined}
							open
						/>
						<Toaster position="bottom-right" theme="system" />
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
