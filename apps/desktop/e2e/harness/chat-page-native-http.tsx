// Render the shipping Layout and ChatPage with one deterministic Core thread.
// Only native IPC and Core/control-plane requests are replaced by local fixtures.

import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../contexts/auth-context.tsx";
import { LanguagePackBridge } from "../../src/components/LanguagePackBridge.tsx";
import Layout from "../../src/components/layout/Layout.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import { LOCAL_FALLBACK, useNodeStore } from "../../src/store/useNodeStore.ts";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import {
	TAB_LABEL_BLANK_TITLE,
	TAB_LABEL_STALE_TITLE,
} from "../chat-page-native-http-state.ts";
import { createChatPageNativeDependencies } from "./chat-page-native-http-dependencies.ts";
import "@fontsource-variable/geist";
import "../../src/index.css";

const CORE_URL =
	import.meta.env.VITE_CHAT_PAGE_CORE_URL ?? "http://127.0.0.1:5591";
const CORE_TOKEN = "chat-page-native-node-a-token";
const LOCAL_NODE = { ...LOCAL_FALLBACK, url: CORE_URL, token: CORE_TOKEN };
const OTHER_NODE = {
	...LOCAL_FALLBACK,
	id: "native-proof-b",
	name: "Native HTTP B",
	url: "http://127.0.0.1:5594",
	token: "chat-page-native-node-b-token",
};
const CONVERSATION_ID = "conversation-toolbar-share-fixture";
const CONVERSATION_TITLE = "Toolbar share regression fixture";
const OWNER_ID = "share-owner";
const EARLIER_THREAD_ID = "conversation-earlier-thread-fixture";
const LATEST_THREAD_ID = "conversation-latest-thread-fixture";
const WORKSPACE_PATH = "/tmp/ryu-chat-controls-project";
// The suggested-task scenarios (see chat-page-native-http-state.ts): the global
// project selection sits apart from the thread's own folder.
const OTHER_WORKSPACE_PATH = "/tmp/ryu-other-project";
const TASK_SUGGESTION_WITH_DRAFTS = [
	"task-suggestion",
	"task-suggestion-agent",
	"task-suggestion-temporary",
];
const TASK_SUGGESTION_SCENARIOS = [
	...TASK_SUGGESTION_WITH_DRAFTS,
	"task-suggestion-bare",
];
const scenario =
	new URLSearchParams(location.search).get("scenario") ?? "share";
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

const nativeDependencies = createChatPageNativeDependencies(localStorage, {
	acceptNewChats: TASK_SUGGESTION_SCENARIOS.includes(scenario),
});
const fixture = {
	nativeSnapshot: () => ({
		callbacks: callbacks.size,
		listeners: listeners.size,
		unexpected: [...unexpectedNativeCommands],
	}),
	unmount: (): void => {
		throw new Error("Chat fixture root is not mounted");
	},
};
Object.defineProperty(window, "__chatPageNativeFixture", {
	value: {
		nativeSnapshot: fixture.nativeSnapshot,
		nativeDiagnostics: () => ({
			listeners: [...listeners.entries()].map(([id, listener]) => ({
				id,
				...listener,
			})),
			callbackIds: [...callbacks.keys()],
			heldClipsListenerIds: [...heldClipsListeners.keys()],
			unexpected: structuredClone(unexpectedNativeDetails),
		}),
		holdNextClipsListener: () => {
			if (holdNextClipsListener || heldClipsListeners.size) {
				throw new Error("A native Clips acknowledgment is already held");
			}
			holdNextClipsListener = true;
		},
		releaseClipsListener: (id: number) => {
			const release = heldClipsListeners.get(id);
			if (!release) {
				throw new Error("Unknown held native Clips acknowledgment");
			}
			heldClipsListeners.delete(id);
			release(id);
		},
		unmount: () => fixture.unmount(),
		nodeStore: useNodeStore,
		workspaceStore: useWorkspaceStore,
	},
});
// Match the SDK's callback and listener lifecycle: unlisten first unregisters
// its JS callback through the event-plugin internals, then invokes native cleanup.
const callbacks = new Map<number, (payload: unknown) => void>();
const listeners = new Map<number, { event: string; handler: number }>();
const unexpectedNativeCommands: string[] = [];
const unexpectedNativeDetails: Array<{
	command: string;
	args: unknown;
	error: string;
}> = [];
let nativeDefault =
	sessionStorage.getItem("chat-page-native-default") ?? "local";
let holdNextClipsListener = false;
const heldClipsListeners = new Map<number, (id: number) => void>();
let nextCallback = 0;
let nextListener = 0;
Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
	value: {
		unregisterListener: (event: string, id: number) => {
			const listener = listeners.get(id);
			if (listener?.event === event) {
				callbacks.delete(listener.handler);
			}
		},
	},
});
Object.defineProperty(window, "__TAURI_INTERNALS__", {
	value: {
		metadata: {
			currentWindow: { label: "main" },
			currentWebview: { label: "main" },
		},
		transformCallback: (callback: (payload: unknown) => void) => {
			const id = ++nextCallback;
			callbacks.set(id, callback);
			return id;
		},
		unregisterCallback: (id: number) => {
			callbacks.delete(id);
		},
		invoke: async (
			command: string,
			args?: {
				event?: string;
				handler?: number;
				eventId?: number;
				name?: string;
				[key: string]: unknown;
			}
		) => {
			if (command === "plugin:event|listen") {
				if (
					typeof args?.event !== "string" ||
					typeof args.handler !== "number" ||
					!callbacks.has(args.handler)
				) {
					throw new Error("Invalid native event registration");
				}
				const id = ++nextListener;
				listeners.set(id, { event: args.event, handler: args.handler });
				if (args.event === "clips:quick-attach" && holdNextClipsListener) {
					holdNextClipsListener = false;
					return new Promise<number>((resolve) =>
						heldClipsListeners.set(id, resolve)
					);
				}
				return id;
			}
			if (command === "plugin:event|unlisten") {
				if (
					typeof args?.eventId !== "number" ||
					(listeners.has(args.eventId) &&
						listeners.get(args.eventId)?.event !== args.event)
				) {
					throw new Error("Invalid native event cleanup");
				}
				listeners.delete(args.eventId);
				return null;
			}
			// The mounted Layout refreshes the native profile and probes this local
			// fixture Core. These are the native DTOs consumed by the real stores.
			if (command === "list_nodes") {
				return {
					default: nativeDefault,
					nodes: [{ ...LOCAL_NODE }, { ...OTHER_NODE }],
				};
			}
			if (command === "set_default_node") {
				if (
					!args ||
					Object.keys(args).length !== 1 ||
					![LOCAL_NODE.name, OTHER_NODE.name].includes(args.name ?? "")
				) {
					throw new Error("Invalid owned default node");
				}
				nativeDefault = args.name as string;
				sessionStorage.setItem("chat-page-native-default", nativeDefault);
				return null;
			}
			if (command === "local_node_token") {
				return { token: CORE_TOKEN };
			}
			if (command === "test_node") {
				return { online: true };
			}
			try {
				const dependency = nativeDependencies.invoke(command, args);
				if (dependency.handled) {
					return dependency.value;
				}
			} catch (error) {
				unexpectedNativeCommands.push(command);
				unexpectedNativeDetails.push({
					command,
					args: structuredClone(args),
					error: String(error),
				});
				throw error;
			}
			unexpectedNativeCommands.push(command);
			unexpectedNativeDetails.push({
				command,
				args: structuredClone(args),
				error: `Unexpected native command: ${command}`,
			});
			throw new Error(`Unexpected native command: ${command}`);
		},
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
	defaultNode: nativeDefault,
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
if (root) {
	const reactRoot = createRoot(root);
	fixture.unmount = () => reactRoot.unmount();
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
}
