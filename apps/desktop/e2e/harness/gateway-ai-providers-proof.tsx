import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ProviderControlCenter } from "../../src/components/gateway/ProviderControlCenter.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { installCoreFixture } from "./gateway-ai-providers-proof-fixture.ts";
import { NODE } from "./gateway-ai-providers-proof-state.ts";
import "../../src/index.css";

declare const window: Window;

// Gateway opens only in Console; grant the access App's ProductModeAccessSync
// would grant a local node.
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

function ProofSurface() {
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { refetchOnWindowFocus: false, retry: false },
				},
			}),
		[]
	);
	const params = new URLSearchParams(window.location.search);
	const managed = params.get("managed") === "true";
	const canSetGatewayAccount = params.get("permission") !== "denied";

	return (
		<QueryClientProvider client={queryClient}>
			<I18nProvider>
				<MemoryRouter>
					<AppSurfaceProvider surface="desktop">
						<EntitlementProvider>
							<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
								<main className="mx-auto min-h-screen max-w-5xl bg-background p-8 text-foreground">
									<header className="mb-5">
										<p className="text-muted-foreground text-xs tracking-widest">
											RYU · LIVE REACT PROOF
										</p>
										<h1 className="mt-2 font-semibold text-2xl">
											Gateway AI providers
										</h1>
										<p className="mt-1 max-w-2xl text-muted-foreground text-sm">
											Rendered ProviderControlCenter with stateful Core
											provider, account, model, and Gateway routing fixtures.
										</p>
									</header>
									<ProviderControlCenter
										canSetGatewayAccount={canSetGatewayAccount}
										credentials={<p>Credential integration slot</p>}
										integrations={<p>Provider integration slot</p>}
										managed={managed}
										routing={<p>Routing integration slot</p>}
									/>
								</main>
								<Toaster position="bottom-right" theme="system" />
							</ThemeProvider>
						</EntitlementProvider>
					</AppSurfaceProvider>
				</MemoryRouter>
			</I18nProvider>
		</QueryClientProvider>
	);
}

useNodeStore.setState({
	cloudNodes: [],
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});
setInterfaceLevel("expert");
installCoreFixture();

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<ProofSurface />);
}
