import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { IntegrationsTab } from "../../src/components/settings/IntegrationsTab.tsx";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import { useSettingsDialog } from "../../src/store/useSettingsDialog.ts";
import { installIntegrationsProofFetch } from "./gateway-integrations-settings-proof.mock.ts";
import "../../src/index.css";

// Gateway opens only in Console; grant the access App's ProductModeAccessSync
// would grant a local node.
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

window.__GATEWAY_INTEGRATIONS_STORES__ = {
	openSettings: () => useSettingsDialog.getState().setOpen(true),
	snapshot: () => ({
		gatewayOpen: useGatewayDialog.getState().open,
		gatewaySection: useGatewayDialog.getState().section,
		settingsOpen: useSettingsDialog.getState().open,
	}),
};

const restoreFetch = installIntegrationsProofFetch();
window.addEventListener("pagehide", restoreFetch, { once: true });

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing root");
}

createRoot(root).render(
	<MemoryRouter initialEntries={["/settings"]}>
		<main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 bg-background p-8 text-foreground">
			<header>
				<p className="mb-2 text-primary text-xs tracking-(--tracking-section)">
					RYU · DESKTOP SETTINGS
				</p>
				<h1 className="font-medium text-3xl">Integrations</h1>
				<p className="mt-2 text-muted-foreground text-sm">
					Credentials and webhook-ingress preferences for the active node.
				</p>
			</header>
			<Routes>
				<Route element={<IntegrationsTab />} path="/settings" />
				<Route
					element={
						<h2 className="font-medium text-2xl">Marketplace proof route</h2>
					}
					path="/marketplace"
				/>
			</Routes>
			<Toaster position="bottom-right" theme="dark" />
		</main>
	</MemoryRouter>
);
