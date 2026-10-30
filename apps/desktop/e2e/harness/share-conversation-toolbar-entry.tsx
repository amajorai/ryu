// First, so the native bridge exists before any app module loads, as in Tauri.
// Biome keeps a bare import in place; the named import below reuses it.
import "./share-conversation-toolbar-bridge.ts";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";

declare const window: Window;

import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../contexts/auth-context.tsx";
import { BACKEND_URL } from "../../lib/app-urls.ts";
import { vaultHydrated } from "../../lib/auth-client.ts";
import { LanguagePackBridge } from "../../src/components/LanguagePackBridge.tsx";
import Layout from "../../src/components/layout/Layout.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { hydrateSealedLocalStorage } from "../../src/lib/content-seal.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { LOCAL_FALLBACK, useNodeStore } from "../../src/store/useNodeStore.ts";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import { parseProofJsonRecord } from "../fixture-json.ts";
import { createChatControlBackground } from "./chat-page-control-background.ts";
// Render the shipping Layout and ChatPage with one deterministic Core thread.
// Only native IPC and Core/control-plane requests are replaced by local fixtures.
import {
	prepareChatProofRequest,
	rejectUnexpectedChatProofRequest,
	type UnexpectedChatProofRequest,
} from "./chat-page-proof-http.ts";
import {
	setToolbarLocalNode,
	toolbarNativeBridge,
} from "./share-conversation-toolbar-bridge.ts";
import "@fontsource-variable/geist";
import "../../src/index.css";

setToolbarLocalNode(LOCAL_FALLBACK);
const CONVERSATION_ID = "conversation-toolbar-share-fixture";
const CONVERSATION_TITLE = "Toolbar share regression fixture";
const OWNER_ID = "share-owner";
const EARLIER_THREAD_ID = "conversation-earlier-thread-fixture";
const LATEST_THREAD_ID = "conversation-latest-thread-fixture";
const WORKSPACE_PATH = "/tmp/ryu-chat-controls-project";
const scenario =
	new URLSearchParams(location.search).get("scenario") ?? "share";
// This opt-in proof exposes the same node store the shipping hooks subscribe to.
// No alternative store or test-only UI controls are introduced.
if (scenario === "side-chat-caller") {
	Object.defineProperty(window, "__sideChatNodeFixture", {
		value: useNodeStore,
	});
}
const mergedThreadScenario = scenario === "merged-thread-picker";
const currentConversationId = mergedThreadScenario
	? LATEST_THREAD_ID
	: CONVERSATION_ID;
const currentConversationTitle = mergedThreadScenario
	? "Latest project thread"
	: CONVERSATION_TITLE;

interface FixtureCall {
	body: unknown;
	method: string;
	path: string;
}

interface ShareToolbarFixture {
	access: {
		can_manage: boolean;
		collaborators: Array<{ role: "participant" | "viewer"; user_id: string }>;
		owner_user_id: string;
		team_id: string | null;
		visibility: "org" | "private" | "team";
	};
	calls: FixtureCall[];
	nativeDiagnostics: () => {
		listeners: Array<{ id: number; event: string; handler: number }>;
		callbackIds: number[];
		unexpected: unknown[];
		heldClipsListenerIds: number[];
	};
	nativeSnapshot: () => {
		callbacks: number;
		listeners: number;
		unexpected: string[];
	};
	unexpectedRequests: UnexpectedChatProofRequest[];
	unmount: () => void;
	uploads: Array<{ filename: string; size: number; type: string }>;
}

const fixture: ShareToolbarFixture = {
	access: {
		can_manage: true,
		collaborators: [],
		owner_user_id: OWNER_ID,
		team_id: null,
		visibility: "private",
	},
	calls: [],
	nativeSnapshot: toolbarNativeBridge.snapshot,
	nativeDiagnostics: toolbarNativeBridge.diagnostics,
	unmount: () => {
		throw new Error("Chat fixture root is not mounted");
	},
	unexpectedRequests: [],
	uploads: [],
};

Object.defineProperty(window, "__shareToolbarFixture", { value: fixture });

const seedKey = `share-toolbar-entry-seeded:${scenario}`;
if (sessionStorage.getItem(seedKey) !== "true") {
	localStorage.setItem("ryu_startup_behavior", "restore");
	localStorage.setItem("ryu:tab-dropdown", "false");
	if (scenario === "copy-transcript") {
		localStorage.setItem("ryu_default_agent", "agent-fixture");
	}
	localStorage.setItem(
		"ryu_session_tabs",
		JSON.stringify({
			activeIndex: 0,
			tabs: [
				{
					...(mergedThreadScenario
						? undefined
						: { conversationId: currentConversationId }),
					path: mergedThreadScenario ? "/chat/agent/agent-fixture" : "/chat",
					title: currentConversationTitle,
				},
			],
		})
	);
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
	sessionStorage.setItem(seedKey, "true");
}

function parseBody(init?: RequestInit) {
	if (!isNativeText(init?.body)) {
		return null;
	}
	try {
		return parseProofJsonRecord(init.body);
	} catch {
		return init.body;
	}
}

function recordCall(path: string, init?: RequestInit) {
	fixture.calls.push({
		body: parseBody(init),
		method: init?.method ?? "GET",
		path,
	});
}

const defaultMessageRows = [
	{
		author_user_id: OWNER_ID,
		content: "We need to share the launch plan with the organization.",
		created_at: 1_724_000_000_000,
		id: "toolbar-share-user-message",
		role: "user",
	},
	{
		content: "The organization copy is ready for review.",
		created_at: 1_724_000_010_000,
		id: "toolbar-share-assistant-message",
		role: "assistant",
	},
];
const messageRows =
	scenario === "dismiss-plugin-note"
		? [
				defaultMessageRows[0],
				{
					...defaultMessageRows[1],
					parts: [
						{
							text: "The organization copy is ready for review.",
							type: "text",
						},
						{
							data: {
								question: "Review before sharing",
								text: "Review this launch plan before sharing.",
							},
							id: "plugin-note-fixture",
							type: "data-plugin_note",
						},
					],
				},
			]
		: defaultMessageRows;

const earlierThreadMessages = [
	{
		content: "This belongs to the earlier project thread.",
		created_at: 1_724_000_000_000,
		id: "earlier-thread-message",
		role: "user",
	},
	{
		content: "Earlier work is still readable here.",
		created_at: 1_724_000_010_000,
		id: "earlier-thread-reply",
		role: "assistant",
	},
];
const latestThreadMessages = [
	{
		content: "This is the most recent project thread.",
		created_at: 1_724_000_020_000,
		id: "latest-thread-message",
		role: "user",
	},
	{
		content: "Continue the current project work here.",
		created_at: 1_724_000_030_000,
		id: "latest-thread-reply",
		role: "assistant",
	},
];

const composerControls =
	scenario === "composer-controls"
		? [
				{
					default: "balanced",
					flag: "response_mode",
					id: "response-mode",
					label: "Response mode",
					options: [
						{ label: "Balanced", value: "balanced" },
						{ label: "Precise", value: "precise" },
					],
					placement: "bar",
					plugin: "com.ryu.test-tools",
					type: "select",
				},
				{
					flag: "current_run",
					id: "current-run",
					label: "Current run",
					plugin: "com.ryu.test-tools",
					source: {
						http: { path: "/api/ext/com.ryu.test-tools/current-run" },
						items: "items",
					},
					type: "chip",
				},
				{
					args: { stage: "toolbar-regression" },
					capability: "checks.run",
					flag: "run_checks",
					id: "run-checks",
					label: "Run checks",
					placement: "bar",
					plugin: "com.ryu.test-tools",
					type: "action",
				},
			]
		: [];

const historyPreview = {
	checkpointId: "a".repeat(64),
	repoAvailable: false,
	repoError: "No project repository is attached to this fixture.",
	repoRoot: null,
	redactions: { custom: 0, pii: 0, secrets: 0 },
	transcript: {
		agentId: null,
		branch: null,
		codeCommit: null,
		createdAt: "2024-08-19T00:00:00.000Z",
		format: "ryu-portable-conversation",
		messages: messageRows.map((message) => ({
			agentId: null,
			content: message.content,
			createdAt: new Date(message.created_at).toISOString(),
			id: message.id,
			role: message.role,
		})),
		omittedStructuredParts: 0,
		redactionPolicy: "locked-sensitive-v1",
		sourceId: "b".repeat(64),
		title: currentConversationTitle,
		updatedAt: "2024-08-19T00:00:10.000Z",
		version: 1,
	},
};

function conversationSummary(
	id: string,
	title: string,
	updatedAt: number,
	agentId: string | null = null
) {
	return {
		agent_id: agentId,
		archived: false,
		branch: null,
		created_at: 1_724_000_000_000,
		folder_path: null,
		id,
		last_message_at: updatedAt,
		message_count: 2,
		run_status: null,
		title,
		updated_at: updatedAt,
		worktree_path: null,
	};
}

const conversationSummaries = mergedThreadScenario
	? [
			conversationSummary(
				LATEST_THREAD_ID,
				"Latest project thread",
				1_724_000_030_000,
				"agent-fixture"
			),
			conversationSummary(
				EARLIER_THREAD_ID,
				"Earlier project thread",
				1_724_000_010_000,
				"agent-fixture"
			),
		]
	: [
			conversationSummary(
				currentConversationId,
				currentConversationTitle,
				1_724_000_010_000,
				scenario === "copy-transcript" ? "agent-fixture" : null
			),
		];

const pluginCompanions =
	scenario === "drawesome-dialog"
		? [
				{
					approved_grants: [],
					first_party: true,
					has_ui: true,
					id: "app__drawesome-companion",
					label: "Drawesome",
					name: "Drawesome",
					plugin_id: "@ryu/drawesome",
				},
			]
		: [];

const background = createChatControlBackground(
	{
		coreUrl: LOCAL_FALLBACK.url,
		backendUrl: BACKEND_URL,
		conversationIds: [
			CONVERSATION_ID,
			EARLIER_THREAD_ID,
			LATEST_THREAD_ID,
			"conversation-forked-fixture",
		],
		ownerId: OWNER_ID,
	},
	fixture.unexpectedRequests
);
Object.defineProperty(window, "__chatControlBackground", {
	value: background.snapshot,
});
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
	const request = prepareChatProofRequest(input, init, location.href);
	const url = new URL(request.url);
	if (
		url.protocol === "ipc:" ||
		url.hostname === "ipc.localhost" ||
		(url.origin === location.origin && !url.pathname.startsWith("/api/"))
	) {
		return nativeFetch(input, init);
	}

	const backgroundResponse = await background.respond(request);
	if (backgroundResponse) {
		return backgroundResponse;
	}
	const rejected = await rejectUnexpectedChatProofRequest(
		request,
		{
			backendUrl: BACKEND_URL,
			coreUrl: LOCAL_FALLBACK.url,
			conversationIds: [
				CONVERSATION_ID,
				EARLIER_THREAD_ID,
				LATEST_THREAD_ID,
				currentConversationId,
				"conversation-forked-fixture",
			],
			sharingConversationId: CONVERSATION_ID,
		},
		fixture.unexpectedRequests
	);
	if (rejected) {
		return rejected;
	}
	const path = `${url.pathname}${url.search}`;
	const method = request.method;
	const effectiveInit: RequestInit = {
		method,
		headers: request.headers,
		body:
			request.body === null
				? undefined
				: url.pathname === "/api/uploads"
					? await request.clone().blob()
					: await request.clone().text(),
	};
	if (url.pathname === "/api/conversations") {
		recordCall(path, effectiveInit);
		return Response.json({ conversations: conversationSummaries });
	}
	if (url.pathname === "/api/plugins/contributions") {
		recordCall(url.pathname, effectiveInit);
		return Response.json({
			composer_controls: composerControls,
			companions: pluginCompanions,
		});
	}
	if (url.pathname === "/api/ext/com.ryu.test-tools/current-run") {
		recordCall(url.pathname, effectiveInit);
		return Response.json({
			items: [{ id: "run-fixture-1", title: "Launch review in progress" }],
		});
	}
	if (url.pathname === "/api/plugins/com.ryu.test-tools/host") {
		recordCall(url.pathname, effectiveInit);
		return Response.json({ result: { ok: true } });
	}
	if (
		url.pathname.startsWith("/api/plugins/") &&
		url.pathname.endsWith("/ui-bundle")
	) {
		recordCall(url.pathname, effectiveInit);
		return Response.json(
			{ error: "fixture plugin bundle unavailable" },
			{ status: 404 }
		);
	}
	if (url.pathname === "/api/agents/agent-fixture") {
		recordCall(url.pathname, effectiveInit);
		return Response.json({
			agent: {
				id: "agent-fixture",
				name: "Fixture Agent",
				title: "Fixture agent",
				tools: ["search_web", "read_file"],
			},
		});
	}
	if (url.pathname === `/api/conversations/${CONVERSATION_ID}/access`) {
		recordCall(url.pathname, effectiveInit);
		if (method === "PUT") {
			const body = parseBody(effectiveInit);
			if (body && typeof body === "object") {
				Object.assign(fixture.access, body);
			}
		}
		return Response.json({ ...fixture.access, ok: method === "PUT" });
	}
	if (url.pathname === "/api/acl/principals") {
		recordCall(url.pathname, effectiveInit);
		return Response.json({
			members: [
				{
					email: "jiawei@example.test",
					id: OWNER_ID,
					name: "Jia Wei Ng",
				},
			],
			org_id: "org-share-toolbar-fixture",
			teams: [],
		});
	}
	if (
		url.pathname === `/api/conversations/${CONVERSATION_ID}/history-preview`
	) {
		recordCall(url.pathname, effectiveInit);
		return Response.json(historyPreview);
	}
	if (url.pathname === `/api/conversations/${EARLIER_THREAD_ID}`) {
		recordCall(path, effectiveInit);
		return Response.json({
			has_older_messages: false,
			messages: earlierThreadMessages,
		});
	}
	if (url.pathname === `/api/conversations/${LATEST_THREAD_ID}`) {
		recordCall(path, effectiveInit);
		return Response.json({
			has_older_messages: false,
			messages: latestThreadMessages,
		});
	}
	if (url.pathname === `/api/conversations/${currentConversationId}`) {
		recordCall(path, effectiveInit);
		return Response.json({
			has_older_messages: false,
			messages: messageRows,
		});
	}
	if (
		url.pathname === `/api/conversations/${CONVERSATION_ID}/fork` &&
		method === "POST"
	) {
		recordCall(url.pathname, effectiveInit);
		return Response.json({
			conversation: conversationSummary(
				"conversation-forked-fixture",
				"Forked launch plan",
				1_724_000_040_000
			),
		});
	}
	if (url.pathname === "/api/conversations/conversation-forked-fixture") {
		recordCall(path, effectiveInit);
		return Response.json({
			has_older_messages: false,
			messages: messageRows,
		});
	}
	if (url.pathname === "/api/workspace/list") {
		recordCall(path, effectiveInit);
		const requestedPath = url.searchParams.get("path") ?? "/tmp";
		return Response.json({
			entries: [],
			home: "/tmp",
			parent: "/tmp",
			path: requestedPath,
		});
	}
	if (url.pathname === "/api/uploads" && method === "POST") {
		const body = effectiveInit.body;
		// `uploadUserFile` sends the name as `?name=` (not a header).
		const filename = url.searchParams.get("name") ?? "upload";
		fixture.uploads.push({
			filename,
			size: body instanceof Blob ? body.size : 0,
			type: body instanceof Blob ? body.type : "",
		});
		recordCall(url.pathname, effectiveInit);
		return Response.json({
			content_type: "image/png",
			file_name: filename,
			id: "uploaded-chat-image",
			size: body instanceof Blob ? body.size : 0,
			space_id: "uploads-fixture",
			url: "/api/uploads/uploaded-chat-image",
		});
	}
	if (url.pathname === "/api/chat/stream") {
		recordCall(path, effectiveInit);
		return Response.json(
			{ error: "Chat stream fixture stops after capturing the request." },
			{ status: 503 }
		);
	}
	if (
		url.pathname === `/api/conversation-shares/conversation/${CONVERSATION_ID}`
	) {
		recordCall(url.pathname, effectiveInit);
		return Response.json({ ok: true, share: null });
	}
	if (url.pathname === "/api/auth/token") {
		return Response.json({});
	}
	// Retain failures independently of fetch rejection/query error handling.
	// An unknown route must fail the browser scenario even if the UI catches it.
	fixture.unexpectedRequests.push({
		method,
		url: request.url,
		body: request.body === null ? null : await request.clone().text(),
	});
	return Response.json(
		{ error: "Share toolbar proof fixture: endpoint is not implemented" },
		{ status: 503 }
	);
};

useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });
useNodeStore.setState({
	defaultNode: "local",
	nodes: [LOCAL_FALLBACK],
	tabOverrides: {},
});
if (scenario === "workspace-required") {
	useWorkspaceStore.setState({
		folder: null,
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

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const root = document.getElementById("root");
if (root) {
	const reactRoot = createRoot(root);
	fixture.unmount = () => reactRoot.unmount();
	// Like main.tsx, render once the sealed auth vault and sealed localStorage
	// values hydrate; synchronous readers would otherwise see a signed-out session.
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
