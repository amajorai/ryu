import { I18nProvider } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { TOKEN_KEY, useSession } from "../../lib/auth-client.ts";
import { AccountList } from "../../src/components/layout/NavUser.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import StorePage from "../../src/pages/StorePage.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const node = {
	name: "marketplace-detail-proof",
	url: location.origin,
	token: "marketplace-detail-node-token",
	userJwt: null,
};
useNodeStore.setState({
	nodes: [node],
	defaultNode: node.name,
	autoSelect: false,
	autoSelectedNode: null,
});
// The account-lifetime proof seeds its own vault, which migrates into the
// sealed slot and leaves no plaintext token; re-seeding one here would put a
// plaintext credential back after every reload.
if (
	!(
		location.search.includes("signed-out") ||
		location.search.includes("account-lifetime") ||
		localStorage.getItem(TOKEN_KEY)
	)
) {
	localStorage.setItem(TOKEN_KEY, "marketplace-detail-session-token");
}
function ReviewAccountControls() {
	const { data: session } = useSession();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="fixed top-3 right-3 z-50">
				Review account controls
			</DropdownMenuTrigger>
			<DropdownMenuContent>
				<AccountList
					activeUser={session?.user ?? null}
					onSignOutAll={() => {
						throw new Error("Unexpected sign out in review account proof");
					}}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
document.documentElement.classList.add("dark");
const client = new QueryClient({
	defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing proof root");
}
createRoot(root).render(
	<QueryClientProvider client={client}>
		<I18nProvider>
			<ThemeProvider attribute="class" defaultTheme="dark">
				<MemoryRouter>
					<EntitlementProvider>
						<TabsProvider>
							<main className="h-screen bg-background text-foreground">
								{location.search.includes("account-lifetime") ? (
									<ReviewAccountControls />
								) : null}
								<StorePage initialSection="bundles" />
								<Toaster />
							</main>
						</TabsProvider>
					</EntitlementProvider>
				</MemoryRouter>
			</ThemeProvider>
		</I18nProvider>
	</QueryClientProvider>
);
