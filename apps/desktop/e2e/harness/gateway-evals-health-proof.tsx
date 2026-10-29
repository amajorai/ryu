import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { TOKEN_KEY } from "../../lib/auth-client.ts";
import { GatewayDialog } from "../../src/components/gateway/GatewayDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import { LOCAL_FALLBACK, useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const NODE = {
	managed: true,
	name: "gateway-evals-health-proof",
	orgId: "eval-health-proof-org",
	token: "gateway-evals-health-proof-token",
	url: "http://127.0.0.1:7982",
	userJwt: null,
};
const queryClient = new QueryClient({
	defaultOptions: {
		queries: { refetchOnWindowFocus: false, retry: false },
	},
});

// `node=local` opens the dialog on this computer's own Core, whose process the
// desktop shell starts and restarts; every other proof targets the managed node.
const onLocalComputer =
	new URLSearchParams(window.location.search).get("node") === "local";
useNodeStore.setState(
	onLocalComputer
		? {
				cloudNodes: [NODE],
				defaultNode: LOCAL_FALLBACK.name,
				localNodes: [LOCAL_FALLBACK],
				nodes: [LOCAL_FALLBACK, NODE],
			}
		: {
				cloudNodes: [NODE],
				defaultNode: NODE.name,
				localNodes: [NODE],
				nodes: [NODE],
			}
);
localStorage.setItem(TOKEN_KEY, "gateway-evals-health-proof-session");
setInterfaceLevel("expert");

function ProofSurface() {
	const params = new URLSearchParams(window.location.search);
	const surface = params.get("surface");
	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<main className="min-h-screen bg-background p-8 text-foreground">
						<GatewayDialog
							defaultSection={surface === "health" ? "health" : "evals"}
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
