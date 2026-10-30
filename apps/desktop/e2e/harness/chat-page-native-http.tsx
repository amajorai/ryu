// Render the shipping Layout and ChatPage with one deterministic Core thread.
// Only native IPC and Core/control-plane requests are replaced by local fixtures.

// First, so the native bridge exists before any app module loads, as in Tauri.
// Biome keeps a bare import in place; the named import below reuses it.
import "./chat-page-native-http-bridge.ts";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../contexts/auth-context.tsx";
import { vaultHydrated } from "../../lib/auth-client.ts";
import { LanguagePackBridge } from "../../src/components/LanguagePackBridge.tsx";
import Layout from "../../src/components/layout/Layout.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import {
	hydrateSealedLocalStorage,
	sealedLocalStorage,
} from "../../src/lib/content-seal.ts";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import {
	TAB_LABEL_BLANK_TITLE,
	TAB_LABEL_STALE_TITLE,
} from "../chat-page-native-http-state.ts";
import {
	LOCAL_NODE,
	nativeBridge,
	OTHER_NODE,
	scenario,
	TASK_SUGGESTION_SCENARIOS,
	TASK_SUGGESTION_WITH_DRAFTS,
} from "./chat-page-native-http-bridge.ts";
import "@fontsource-variable/geist";
import "../../src/index.css";

const CONVERSATION_ID = "conversation-toolbar-share-fixture";
const CONVERSATION_TITLE = "Toolbar share regression fixture";
const OWNER_ID = "share-owner";
const EARLIER_THREAD_ID = "conversation-earlier-thread-fixture";
const LATEST_THREAD_ID = "conversation-latest-thread-fixture";
const WORKSPACE_PATH = "/tmp/ryu-chat-controls-project";
// The suggested-task scenarios (see chat-page-native-http-state.ts): the global
// project selection sits apart from the thread's own folder.
const OTHER_WORKSPACE_PATH = "/tmp/ryu-other-project";
// Scenarios whose first tab is a blank new chat (no conversation yet), with the
// label that tab was opened with. See chat-page-native-http-state.ts.
const BLANK_TAB_TITLES: Record<string, string> = {
	"task-suggestion-temporary": "New chat",
	"tab-label-blank": TAB_LABEL_BLANK_TITLE,
};
const blankTabTitle = BLANK_TAB_TITLES[scenario];
// A tab on the conversation whose label is out of date, with no message in it.
const staleLabelTitle =
	scenario === "tab-label-empty-thread" ? TAB_LABEL_STALE_TITLE : undefined;
// This opt-in proof exposes the same node store the shipping hooks subscribe to.
// No alternative store or test-only UI controls are introduced.
if (scenario === "side-chat-caller") {
	Object.defineProperty(window, "__sideChatNodeFixture", {
		value: useNodeStore,
	});
}
const mergedThreadScenario = [
	"merged-thread-picker",
	"merged-thread-review",
].includes(scenario);
const currentConversationId = mergedThreadScenario
	? LATEST_THREAD_ID
	: CONVERSATION_ID;
const currentConversationTitle = mergedThreadScenario
	? "Latest project thread"
	: CONVERSATION_TITLE;

const fixture = {
	nativeSnapshot: nativeBridge.snapshot,
	unmount: (): void => {
		throw new Error("Chat fixture root is not mounted");
	},
};
Object.defineProperty(window, "__chatPageNativeFixture", {
	value: {
		nativeSnapshot: fixture.nativeSnapshot,
		nativeDiagnostics: nativeBridge.diagnostics,
		holdNextClipsListener: nativeBridge.holdNextClipsListener,
		releaseClipsListener: nativeBridge.releaseClipsListener,
		unmount: () => fixture.unmount(),
		nodeStore: useNodeStore,
		workspaceStore: useWorkspaceStore,
		// Session tabs and the workbench layout are sealed with the desktop
		// content key, so proofs read them through the shipping facade.
		sealedLocalItem: (key: string) => sealedLocalStorage.getItem(key),
		removeSealedLocalItem: (key: string) => sealedLocalStorage.removeItem(key),
	},
});

const seedKey = `share-toolbar-entry-seeded:${scenario}`;
const firstScenarioVisit = sessionStorage.getItem(seedKey) !== "true";
if (firstScenarioVisit) {
	localStorage.setItem("ryu_startup_behavior", "restore");
	localStorage.setItem("ryu:tab-dropdown", "false");
	if (["copy-transcript", "model-selection-caller"].includes(scenario)) {
		localStorage.setItem("ryu_default_agent", "agent-fixture");
		if (scenario === "model-selection-caller") {
			localStorage.setItem("ryu:interface-level", "expert");
		}
	}
	localStorage.setItem(
		"ryu_session_tabs",
		JSON.stringify({
			activeIndex: 0,
			tabs: [
				{
					...(mergedThreadScenario || blankTabTitle !== undefined
						? {}
						: { conversationId: currentConversationId }),
					path: mergedThreadScenario ? "/chat/agent/agent-fixture" : "/chat",
					title: blankTabTitle ?? staleLabelTitle ?? currentConversationTitle,
				},
			],
		})
	);
	// `?signedOut=1` opens the thread with no account signed in.
	if (new URLSearchParams(location.search).get("signedOut") !== "1") {
		localStorage.setItem(
			"ryu_accounts",
			JSON.stringify([
				{
					email: "jiawei@example.test",
					image: null,
					name: "Jia Wei Ng",
					token: "share-toolbar-fixture-token",
					userId: OWNER_ID,
				},
			])
		);
		localStorage.setItem("ryu_active_user_id", OWNER_ID);
		localStorage.setItem("ryu_session_token", "share-toolbar-fixture-token");
	}
	sessionStorage.setItem(seedKey, "true");
}

if (scenario === "model-selection-caller") {
	setInterfaceLevel("expert");
}
// `?productMode=bot` opens the thread in the Bot product instead of Console.
useProductModeStore.setState({
	requestedMode:
		new URLSearchParams(location.search).get("productMode") === "bot"
			? "bot"
			: "console",
	consoleAccess: true,
});
useNodeStore.setState({
	defaultNode: nativeBridge.defaultNode(),
	nodes: [LOCAL_NODE, OTHER_NODE],
	tabOverrides: {},
});
// The Changes pane opens as a workbench tab scoped to the chat's project, and
// the workbench only renders it for the open workspace folder. The review
// scenarios reload the page to restore retained tabs, which drops the in-memory
// folder, so they seed it on every load instead of once per session.
const seedsWorkspaceEveryLoad = [
	"review-pane",
	"merged-thread-review",
].includes(scenario);
if (
	seedsWorkspaceEveryLoad ||
	(firstScenarioVisit &&
		[
			"workspace-required",
			"worktree-handoff",
			"undo-file-edits",
			...TASK_SUGGESTION_SCENARIOS,
		].includes(scenario))
) {
	useWorkspaceStore.setState({
		folder: (() => {
			if (["workspace-required", "task-suggestion-bare"].includes(scenario)) {
				return null;
			}
			// The thread owns WORKSPACE_PATH; the global selection sits elsewhere.
			return TASK_SUGGESTION_WITH_DRAFTS.includes(scenario)
				? OTHER_WORKSPACE_PATH
				: WORKSPACE_PATH;
		})(),
		worktreeMode: false,
		worktreeBranch: "existing-native-proof-branch",
		projectNames: { [WORKSPACE_PATH]: "Project Atlas" },
		projects: [
			{
				folders: [WORKSPACE_PATH],
				id: "project:chat-controls",
				name: "Project Atlas",
			},
		],
		recentFolders: [WORKSPACE_PATH],
		removedProjects: [],
	});
}

const root = document.getElementById("root");
// Like main.tsx, the first render waits for the sealed auth vault and the sealed
// localStorage values; synchronous readers would otherwise see a signed-out
// session and no restored tabs.
if (root) {
	const reactRoot = createRoot(root);
	fixture.unmount = () => reactRoot.unmount();
	void Promise.all([vaultHydrated, hydrateSealedLocalStorage()]).then(() => {
		reactRoot.render(
			<AppSurfaceProvider surface="desktop">
				<QueryClientProvider client={queryClient}>
					<ThemeProvider
						attribute="class"
						defaultTheme="dark"
						enableSystem={false}
					>
						<LanguagePackBridge>
							<AuthProvider>
								<MemoryRouter>
									<EntitlementProvider>
										<Layout />
										<Toaster />
									</EntitlementProvider>
								</MemoryRouter>
							</AuthProvider>
						</LanguagePackBridge>
					</ThemeProvider>
				</QueryClientProvider>
			</AppSurfaceProvider>
		);
	});
}
