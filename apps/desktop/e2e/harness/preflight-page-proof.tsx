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
	name: "preflight-proof-remote",
	orgId: "preflight-proof-org",
	token: "preflight-proof-node-token",
	url: "http://127.0.0.1:5319",
	userJwt: null,
};
const queryClient = new QueryClient({
	defaultOptions: {
		queries: { refetchOnWindowFocus: false, retry: false },
	},
});

// `node=local` opens the dialog on this computer's own Core, whose process the
// desktop shell starts and restarts; the other proofs target the remote node.
const LOCAL_NODE = { ...LOCAL_FALLBACK, token: "preflight-proof-local-token" };
const onLocalComputer =
	new URLSearchParams(window.location.search).get("node") === "local";
useNodeStore.setState({
	activeNodeOnline: true,
	autoSelect: false,
	autoSelectedNode: null,
	cloudNodes: [NODE],
	defaultNode: onLocalComputer ? LOCAL_NODE.name : NODE.name,
	localNodes: onLocalComputer ? [LOCAL_NODE] : [NODE],
	nodes: onLocalComputer ? [LOCAL_NODE, NODE] : [NODE],
	tabOverrides: {},
});
localStorage.setItem(TOKEN_KEY, "preflight-proof-session");
setInterfaceLevel("expert");

function ProofSurface() {
	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<main className="min-h-screen bg-background p-8 text-foreground">
						<GatewayDialog
							defaultSection="health"
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
