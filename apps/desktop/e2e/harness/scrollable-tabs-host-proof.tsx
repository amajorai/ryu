import { I18nProvider } from "@ryu/i18n/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "../../contexts/auth-context.tsx";
import Layout from "../../src/components/layout/Layout.tsx";
import { PageWrapper } from "../../src/components/layout/PageWrapper.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import {
	hydrateSealedLocalStorage,
	sealedLocalStorage,
} from "../../src/lib/content-seal.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });
useNodeStore.setState({
	autoSelect: false,
	defaultNode: "Tabs proof",
	nodes: [
		{
			name: "Tabs proof",
			url: location.origin,
			token: "tabs-fixture",
			userJwt: null,
		},
	],
});
// The session snapshot is sealed (content-seal.ts): plaintext
// `ryu_session_tabs` is only the seed and is never written back. Expose the
// app's own sealed reader so the proof reads exactly what a restart restores.
Object.defineProperty(window, "__readSessionTabs", {
	value: () => sealedLocalStorage.getItem("ryu_session_tabs"),
});
const root = document.getElementById("root");
if (!root) {
	throw new Error("Scrollable tabs proof root is missing");
}
// Hydrate sealed storage before the first render, as main.tsx does, so a
// reload restores the sealed session tabs instead of the plaintext seed.
hydrateSealedLocalStorage()
	.then(() => createRoot(root).render(<ProofSurface />))
	.catch(() => undefined);

function ProofSurface() {
	return (
		<QueryClientProvider client={queryClient}>
			<BrowserRouter>
				<I18nProvider>
					<AppSurfaceProvider surface="web">
						<AuthProvider>
							<PageWrapper>
								<EntitlementProvider>
									<Layout />
								</EntitlementProvider>
							</PageWrapper>
						</AuthProvider>
					</AppSurfaceProvider>
				</I18nProvider>
			</BrowserRouter>
		</QueryClientProvider>
	);
}
