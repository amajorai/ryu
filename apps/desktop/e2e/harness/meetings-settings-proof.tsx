import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MeetingsSettings } from "../../src/components/settings/MeetingsSettings.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import type { Node } from "../../src/store/useNodeStore.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const FIXTURE_NODE: Node = {
	managed: true,
	name: "meetings-settings-proof-node",
	orgId: "meetings-settings-proof-org",
	serverId: "meetings-settings-proof-server",
	token: "meetings-settings-proof-node-token",
	url: window.location.origin,
	userJwt: "meetings-settings-proof-user-jwt",
};

useNodeStore.setState({
	cloudNodes: [FIXTURE_NODE],
	defaultNode: FIXTURE_NODE.name,
	localNodes: [],
	nodes: [FIXTURE_NODE],
});

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			refetchOnWindowFocus: false,
			retry: false,
		},
	},
});

function ProofSurface() {
	return (
		<QueryClientProvider client={queryClient}>
			<EntitlementProvider>
				<ThemeProvider
					attribute="class"
					defaultTheme="light"
					forcedTheme="light"
				>
					<main className="min-h-screen bg-background p-8 text-foreground">
						<div className="mx-auto max-w-3xl">
							<MeetingsSettings />
						</div>
						<Toaster position="bottom-right" theme="light" />
					</main>
				</ThemeProvider>
			</EntitlementProvider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Meetings settings proof root was not found");
}
createRoot(root).render(<ProofSurface />);
