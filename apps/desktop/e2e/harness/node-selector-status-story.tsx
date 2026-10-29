import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// Browser proof for the real compact NodeSelector trigger and active-node row.
// The story supplies a deterministic Core status response so the product surface
// can be inspected without starting Core or depending on a user's node file.

import { I18nProvider } from "@ryu/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { NodeSelector } from "../../src/components/shell/NodeSelector.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { SystemStatusProvider } from "../../src/contexts/SystemStatusContext.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import { LOCAL_FALLBACK, useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const proofNodes = [
	LOCAL_FALLBACK,
	{
		name: "lan-box",
		token: null,
		url: "http://192.168.1.44:7980",
	},
	{
		managed: true,
		name: "cloud-workspace",
		token: null,
		url: "https://cloud.example.com",
	},
];

function jsonResponse<FixturePayload>(body: FixturePayload): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status: 200,
	});
}

declare global {
	interface Window {
		nodeMenuProof: { info: number; gateway: number; cancelled: number };
	}
}
window.nodeMenuProof = { info: 0, gateway: 0, cancelled: 0 };
const cloudflaredStory = new URLSearchParams(location.search).has(
	"cloudflared"
);
window.fetch = async (input, init) => {
	const url = isNativeText(input)
		? input
		: input instanceof Request
			? input.url
			: input.toString();

	const detail = url.endsWith("/api/system/info")
		? "info"
		: url.endsWith("/api/gateway/status")
			? "gateway"
			: null;
	if (detail) {
		window.nodeMenuProof[detail]++;
		if (new URLSearchParams(location.search).has("hold")) {
			return new Promise<Response>((_resolve, reject) => {
				const abort = () => {
					window.nodeMenuProof.cancelled++;
					reject(new DOMException("cancelled", "AbortError"));
				};
				if (init?.signal?.aborted) {
					abort();
				} else {
					init?.signal?.addEventListener("abort", abort, { once: true });
				}
			});
		}
	}
	if (url.endsWith("/api/mesh/status")) {
		return jsonResponse(
			cloudflaredStory
				? {
						backend: "cloudflared",
						backend_state: "Running",
						cloudflaredUrl: "https://warm-tree.trycloudflare.com",
						enabled: true,
						reachable: true,
						up: true,
					}
				: {}
		);
	}
	if (url.endsWith("/api/preferences/mesh-backend")) {
		return jsonResponse(cloudflaredStory ? { value: "cloudflared" } : {});
	}
	if (url.endsWith("/api/system/status")) {
		return jsonResponse({
			engine: { active: "llamacpp", running: true },
			gateway: { reachable: true },
			mesh: null,
			sidecars: [
				{ name: "core", running: true },
				{ name: "gateway", running: true },
				{ name: "shadow", running: true },
			],
		});
	}

	if (url.endsWith("/api/system/info")) {
		return jsonResponse({
			cpu_cores: 10,
			cpu_name: "Proof machine",
			disk_human: "512 GB",
			hostname: "proof-machine",
			ram_human: "32 GB",
			used_disk_human: "120 GB",
			used_ram_human: "8 GB",
		});
	}

	return jsonResponse({});
};

useNodeStore.setState({
	defaultNode: LOCAL_FALLBACK.name,
	localNodes: proofNodes,
	nodes: proofNodes,
});

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function Story() {
	return (
		<I18nProvider>
			<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
				<QueryClientProvider client={queryClient}>
					<EntitlementProvider>
						<TabsProvider>
							<SystemStatusProvider>
								<main className="min-h-screen bg-background p-10 text-foreground">
									<div className="w-80 rounded-xl border border-border/60 bg-sidebar p-4 shadow-sm">
										<p className="mb-3 font-medium text-muted-foreground text-xs">
											Computer selector
										</p>
										<NodeSelector mode="compact-dropdown" />
									</div>
								</main>
							</SystemStatusProvider>
						</TabsProvider>
					</EntitlementProvider>
				</QueryClientProvider>
			</ThemeProvider>
		</I18nProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
