// Browser proof for the real Vault page against an isolated Core. The page is
// rendered unchanged; only the native shell and auth gate are replaced by the
// same QueryClient and node store seams used by existing desktop stories.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import VaultPage from "../../src/pages/VaultPage.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const coreUrl =
	(import.meta.env.VITE_CORE_URL as string | undefined) ??
	"http://127.0.0.1:8980";
const node = {
	name: "local",
	url: coreUrl,
	token: "vault-proof-token",
	userJwt: null,
};

useNodeStore.setState({
	defaultNode: node.name,
	localNodes: [node],
	nodes: [node],
	cloudNodes: [],
	suggestedCloudNodes: [],
});

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<div className="h-screen bg-background text-foreground">
				<VaultPage />
			</div>
		</QueryClientProvider>
	);
}
