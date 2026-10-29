import { I18nProvider } from "@ryu/i18n/react";
import { SidebarInset, SidebarProvider } from "@ryu/ui/components/sidebar.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "../../contexts/auth-context.tsx";
import { AppSidebar } from "../../src/components/layout/AppSidebar.tsx";
import { TabDndProvider } from "../../src/components/layout/tabDnd.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import {
	ChatHistoryProvider,
	useChatHistoryContext,
} from "../../src/contexts/ChatHistoryContext.tsx";
import {
	SpacesProvider,
	useSpacesContext,
} from "../../src/contexts/SpacesContext.tsx";
import { SystemStatusProvider } from "../../src/contexts/SystemStatusContext.tsx";
import {
	TabsProvider,
	useTabsContext,
} from "../../src/contexts/TabsContext.tsx";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import { useCreateAgentDialog } from "../../src/store/useCreateAgentDialog.ts";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import type { SidebarProofState } from "../app-sidebar-interactions-proof.contracts.ts";
import { EntitlementProvider } from "./app-sidebar-entitlement.mock.tsx";
import "../../src/index.css";

// OS is rollout-flagged (off by default) and this proof exercises it, so switch
// it on as the app's flag sync (ProductModeAccessSync) would.
useProductModeStore.getState().setOsAccess(true);

// Gateway opens only in Console; grant the access App's ProductModeAccessSync
// would grant a local node.
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

declare global {
	interface Window {
		__APP_SIDEBAR_PROOF__?: SidebarProofState;
	}
}

const PROJECT_PATH = "/Users/proof/Project Alpha";
const INITIAL_ACTIVE_FOLDER =
	new URLSearchParams(location.search).get("active") === "off"
		? localStorage.getItem("ryu_workspace_folder")
		: PROJECT_PATH;

// Observe the genuine tab value and the optional forceNew field owned by the
// native openTab options. The tab producer ordinarily omits that request flag.
type SidebarProofTab = ReturnType<typeof useTabsContext>["tabs"][number] &
	Pick<
		NonNullable<Parameters<ReturnType<typeof useTabsContext>["openTab"]>[1]>,
		"forceNew"
	>;

function StateProbe() {
	const { activeConversationId, conversations } = useChatHistoryContext();
	const { activeTabId, tabs } = useTabsContext();
	const spaces = useSpacesContext();
	const gatewayOpen = useGatewayDialog((state) => state.open);
	const gatewaySection = useGatewayDialog((state) => state.section);
	const createAgentOpen = useCreateAgentDialog((state) => state.open);
	const workspace = useWorkspaceStore((state) => state.folder);
	const workspaceProjects = useWorkspaceStore((state) => state.projects);
	const recentFolders = useWorkspaceStore((state) => state.recentFolders);
	const tabSnapshot = useMemo(
		() =>
			tabs.map((tab: SidebarProofTab) => ({
				conversationId: tab.conversationId ?? null,
				forceNew: Boolean(tab.forceNew),
				id: tab.id,
				path: tab.path,
				title: tab.title,
			})),
		[tabs]
	);
	const nativeCallCount = window.__APP_SIDEBAR_PROOF__?.nativeCalls.length ?? 0;
	return (
		<main className="min-h-screen bg-background p-6 text-foreground">
			<h1 className="font-semibold text-lg">AppSidebar caller state</h1>
			<output className="block" data-testid="tab-state">
				{JSON.stringify({ activeTabId, tabs: tabSnapshot })}
			</output>
			<output className="block" data-testid="chat-state">
				{JSON.stringify({
					activeConversationId,
					conversations: conversations.map((conversation) => ({
						folderPath: conversation.folderPath ?? null,
						id: conversation.id,
						title: conversation.title,
					})),
				})}
			</output>
			<output className="block" data-testid="space-state">
				{JSON.stringify({
					appDisabled: spaces.appDisabled,
					error: spaces.error,
					loading: spaces.loading,
					spaces: spaces.spaces.map((space) => ({
						id: space.id,
						name: space.name,
					})),
				})}
			</output>
			<output className="block" data-testid="gateway-state">
				{JSON.stringify({ open: gatewayOpen, section: gatewaySection })}
			</output>
			<output className="block" data-testid="create-agent-state">
				{String(createAgentOpen)}
			</output>
			<output className="block" data-testid="workspace-state">
				{workspace ?? "(none)"}
			</output>
			<output className="block" data-testid="workspace-project-state">
				{JSON.stringify({
					projects: workspaceProjects.map((project) => ({
						folders: project.folders,
						id: project.id,
						name: project.name,
					})),
					recentFolders,
				})}
			</output>
			<output className="block" data-testid="native-call-count">
				{nativeCallCount}
			</output>
			<output className="block" data-testid="quick-reply-state">
				{window.__APP_SIDEBAR_PROOF__?.quickReplyId ?? "(none)"}
			</output>
			<output className="block" data-testid="quick-preview-state">
				{window.__APP_SIDEBAR_PROOF__?.quickPreviewId ?? "(none)"}
			</output>
			<div
				aria-label="AppSidebar production caller"
				data-testid="app-sidebar-mount"
			>
				<CallerAppSidebar />
			</div>
		</main>
	);
}

function CallerAppSidebar() {
	const history = useChatHistoryContext();
	const tabs = useTabsContext();
	const onNewConversation = useCallback(() => {
		const id = `sidebar-new-${Date.now()}`;
		history.createConversation(id, {
			folderPath: useWorkspaceStore.getState().folder ?? undefined,
		});
		history.setActiveConversationId(id);
		tabs.openTab("/chat", {
			conversationId: id,
			forceNew: true,
			title: "New chat",
		});
	}, [history, tabs]);
	const onSelectConversation = useCallback(
		(id: string) => {
			history.setActiveConversationId(id);
			tabs.openTab("/chat", { conversationId: id });
		},
		[history, tabs]
	);
	const onDeleteConversation = useCallback(
		(id: string) => {
			history.deleteConversation(id);
			if (history.activeConversationId === id) {
				history.setActiveConversationId(null);
			}
		},
		[history]
	);
	return (
		<div className="flex h-[720px] overflow-hidden rounded-xl border border-border">
			<SystemStatusProvider>
				<SidebarProvider defaultOpen>
					<AppSidebar
						activeConversationId={history.activeConversationId}
						onDeleteConversation={onDeleteConversation}
						onNewConversation={onNewConversation}
						onOpenQuickPreview={(id) => {
							const proofWindow = window;
							if (proofWindow.__APP_SIDEBAR_PROOF__) {
								proofWindow.__APP_SIDEBAR_PROOF__.quickPreviewId = id;
							}
						}}
						onOpenQuickReply={(id) => {
							const proofWindow = window;
							if (proofWindow.__APP_SIDEBAR_PROOF__) {
								proofWindow.__APP_SIDEBAR_PROOF__.quickReplyId = id;
							}
						}}
						onSelectConversation={onSelectConversation}
					/>
					<SidebarInset>
						<section className="p-4 text-muted-foreground text-sm">
							The AppSidebar above is mounted with its chat, Spaces, tabs, and
							desktop surface providers.
						</section>
					</SidebarInset>
				</SidebarProvider>
			</SystemStatusProvider>
		</div>
	);
}

function ProofSurface() {
	return (
		<EntitlementProvider>
			<AuthProvider>
				<I18nProvider>
					<ThemeProvider
						attribute="class"
						defaultTheme="dark"
						enableSystem={false}
					>
						<AppSurfaceProvider surface="desktop">
							<QueryClientProvider client={queryClient}>
								<TooltipProvider delay={0}>
									<TabsProvider
										initialTab={
											new URLSearchParams(window.location.search).get(
												"session"
											) === "main"
												? undefined
												: { path: "/chat", title: "Sidebar proof" }
										}
									>
										<TabDndProvider>
											<ChatHistoryProvider>
												<SpacesProvider>
													<StateProbe />
													<Toaster position="bottom-right" theme="dark" />
												</SpacesProvider>
											</ChatHistoryProvider>
										</TabDndProvider>
									</TabsProvider>
								</TooltipProvider>
							</QueryClientProvider>
						</AppSurfaceProvider>
					</ThemeProvider>
				</I18nProvider>
			</AuthProvider>
		</EntitlementProvider>
	);
}

queryClient.clear();
useWorkspaceStore.setState({
	folder: INITIAL_ACTIVE_FOLDER,
	projects: [
		{
			folders: [PROJECT_PATH],
			id: "sidebar-proof-project",
			name: "Project Alpha",
		},
		...useWorkspaceStore
			.getState()
			.projects.filter((project) => project.id !== "sidebar-proof-project"),
	],
	recentFolders: Array.from(
		new Set([
			...useWorkspaceStore.getState().recentFolders,
			...(useWorkspaceStore.getState().removedProjects.includes(PROJECT_PATH)
				? []
				: [PROJECT_PATH]),
		])
	),
	projectNames: {
		...useWorkspaceStore.getState().projectNames,
		[PROJECT_PATH]: "Project Alpha",
	},
});

const root = document.getElementById("root");
if (!root) {
	throw new Error("AppSidebar proof root is missing");
}

createRoot(root).render(<ProofSurface />);
