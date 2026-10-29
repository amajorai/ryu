import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { SpacesProvider } from "../../src/contexts/SpacesContext.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import { queryClient } from "../../src/lib/query-client.ts";
import SpaceDatabaseEditorPage from "../../src/pages/SpaceDatabaseEditorPage.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

// A live run against a real Core passes its URL, token, and the ids it
// created; mocked proofs use the fixed defaults.
const params = new URLSearchParams(window.location.search);

useNodeStore.setState({
	autoSelect: false,
	defaultNode: "Proof",
	nodes: [
		{
			name: "Proof",
			url: params.get("node") ?? "http://127.0.0.1:5226",
			token: params.get("token") ?? "proof-token",
			userJwt: null,
		},
	],
});

function Story() {
	return (
		<main className="h-screen bg-background text-foreground">
			<SpaceDatabaseEditorPage
				databaseId={params.get("database") ?? "database_feedback"}
				spaceId={params.get("space") ?? "space_product"}
			/>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={queryClient}>
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<TabsProvider>
					<SpacesProvider>
						<Story />
					</SpacesProvider>
				</TabsProvider>
			</EntitlementProvider>
		</AppSurfaceProvider>
	</QueryClientProvider>
);
