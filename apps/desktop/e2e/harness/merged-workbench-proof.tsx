import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "../../contexts/auth-context.tsx";
import Layout from "../../src/components/layout/Layout.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
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
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={queryClient}>
		<BrowserRouter>
			<I18nProvider>
				<AppSurfaceProvider surface="web">
					<AuthProvider>
						<EntitlementProvider>
							<Layout />
							<Toaster position="bottom-right" theme="system" />
						</EntitlementProvider>
					</AuthProvider>
				</AppSurfaceProvider>
			</I18nProvider>
		</BrowserRouter>
	</QueryClientProvider>
);
