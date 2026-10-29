import { I18nProvider } from "@ryu/i18n/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import App from "../../src/App.tsx";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

queryClient.setDefaultOptions({
	...queryClient.getDefaultOptions(),
	queries: { ...queryClient.getDefaultOptions().queries, retry: false },
});
// Read-only diagnostics supplement assertions on the actual product controls.
Object.defineProperty(window, "consoleAccessProof", {
	value: {
		snapshot: () => ({
			node: useNodeStore.getState().getActiveNode(),
			defaultNode: useNodeStore.getState().defaultNode,
			requestedMode: useProductModeStore.getState().requestedMode,
			consoleAccess: useProductModeStore.getState().consoleAccess,
			organizationQuery: queryClient.getQueryState(["settings", "orgs"]),
		}),
	},
});
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing Console access proof root");
}
createRoot(root).render(
	<I18nProvider>
		<QueryClientProvider client={queryClient}>
			<App hostSurface="desktop" />
		</QueryClientProvider>
	</I18nProvider>
);
