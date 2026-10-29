import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { InboxCenter } from "@/src/components/inbox/InboxCenter.tsx";
import { TabsContext } from "@/src/contexts/TabsContext.tsx";
import { NOTIFICATION_LAYOUT_STEPS } from "@/src/lib/notification-layout.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { createTabsProofContext } from "./tabs-proof-context.ts";
import "@/src/index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Inbox Center proof root is missing.");
}

const proofNode = {
	name: "inbox-proof",
	token: "inbox-proof-node-token",
	url: window.location.origin,
	userJwt: "inbox-proof-user-jwt",
};
useNodeStore.setState({
	activeNodeOnline: true,
	autoSelect: false,
	autoSelectedNode: null,
	cloudNodes: [],
	defaultNode: proofNode.name,
	localNodes: [proofNode],
	nodes: [proofNode],
	tabOverrides: {},
});

const openedTabs: string[] = [];
const externalUrls: string[] = [];
const tabsValue = createTabsProofContext({
	openTab(path: string) {
		openedTabs.push(path);
		return `inbox-proof-${openedTabs.length}`;
	},
});

interface InboxCenterProofApi {
	clearOpenedTabs(): void;
	externalUrls(): string[];
	openedTabs(): string[];
	recordExternalUrl(url: string): void;
}

declare global {
	interface Window {
		__inboxCenterProof: InboxCenterProofApi;
	}
}

window.__inboxCenterProof = {
	clearOpenedTabs() {
		openedTabs.length = 0;
	},
	externalUrls() {
		return [...externalUrls];
	},
	recordExternalUrl(url: string) {
		externalUrls.push(url);
	},
	openedTabs() {
		return [...openedTabs];
	},
};

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			refetchOnWindowFocus: false,
			retry: false,
		},
	},
});
const params = new URLSearchParams(window.location.search);
const layout =
	NOTIFICATION_LAYOUT_STEPS.find((step) => step.id === params.get("layout"))
		?.id ?? "split";
const showAnnouncements = params.get("announcements") === "true";

createRoot(rootElement).render(
	<QueryClientProvider client={queryClient}>
		<TabsContext.Provider value={tabsValue}>
			<div className="min-h-screen bg-background text-foreground">
				<aside
					aria-label="Desktop sidebar"
					className="fixed inset-y-0 left-0 flex w-14 flex-col justify-end border-border border-r p-3"
				>
					<InboxCenter layout={layout} showAnnouncements={showAnnouncements} />
				</aside>
				<main className="ml-14 min-h-screen p-8">
					<p className="text-muted-foreground text-sm">
						Production InboxCenter interaction proof
					</p>
				</main>
				<Toaster position="top-right" />
			</div>
		</TabsContext.Provider>
	</QueryClientProvider>
);
document.body.dataset.harnessReady = "true";
