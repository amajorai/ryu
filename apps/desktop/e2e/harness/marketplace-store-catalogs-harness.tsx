import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import StorePage from "../../src/pages/StorePage.tsx";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import "../../src/index.css";

// Gateway opens only in Console; grant the access App's ProductModeAccessSync
// would grant a local node.
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

function Harness() {
	const gatewayOpen = useGatewayDialog((state) => state.open);
	const gatewaySection = useGatewayDialog((state) => state.section);
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					mutations: { retry: false },
					queries: { retry: false, staleTime: 0 },
				},
			})
	);
	const initialSection =
		new URLSearchParams(window.location.search).get("section") ??
		"integrations";
	return (
		<I18nProvider packs={[]}>
			<QueryClientProvider client={queryClient}>
				<div className="h-svh min-h-0 bg-background text-foreground">
					<StorePage initialSection={initialSection} />
				</div>
				<Toaster position="bottom-right" theme="dark" />
				<output className="sr-only" data-testid="gateway-fixture-state">
					{JSON.stringify({ open: gatewayOpen, section: gatewaySection })}
				</output>
			</QueryClientProvider>
		</I18nProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Marketplace Store catalogs harness root is missing");
}
createRoot(root).render(<Harness />);
