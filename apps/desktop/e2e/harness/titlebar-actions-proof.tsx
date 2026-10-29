// The shipping Layout/TitleBar and TabsProvider run in Chromium. Only OS
// commands and unavailable Core APIs are supplied by deterministic fixtures.
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { z } from "zod";
import { AuthProvider } from "../../contexts/auth-context.tsx";
import { LanguagePackBridge } from "../../src/components/LanguagePackBridge.tsx";
import Layout from "../../src/components/layout/Layout.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { useArtifactStore } from "../../src/store/useArtifactStore.ts";
import { LOCAL_FALLBACK, useNodeStore } from "../../src/store/useNodeStore.ts";
import { useSidePanelRouteStore } from "../../src/store/useSidePanelRouteStore.ts";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";
import type {
	TitlebarFixtureHooks,
	TitlebarHost,
} from "../titlebar-fixture-contract.ts";
import "@fontsource-variable/geist";
import "../../src/index.css";

const host: TitlebarHost = {
	calls: [],
	fullscreen: false,
	failFullscreen: new URLSearchParams(location.search).has("fullscreen-error"),
	renameRequests: [],
};
const fixtureHooks: TitlebarFixtureHooks = {
	__titlebarHost: host,
	__getPendingSidePanelRoute: () => useSidePanelRouteStore.getState().pending,
	__getNodeTabOverrides: () => useNodeStore.getState().tabOverrides,
	__getNodeTabFixtureState: () => {
		const { defaultNode, nodes, tabOverrides } = useNodeStore.getState();
		return { defaultNode, nodes: nodes.map((node) => node.name), tabOverrides };
	},
	__getRenameRequests: () => host.renameRequests,
};
for (const [key, value] of Object.entries(fixtureHooks)) {
	Object.defineProperty(window, key, { value });
}
Object.defineProperty(window, "__TAURI_INTERNALS__", {
	value: {
		metadata: {
			currentWindow: { label: "main" },
			currentWebview: { label: "main" },
		},
		transformCallback: () => 1,
		unregisterCallback: () => undefined,
		invoke: (command: string, args: ProofJsonValue | undefined) => {
			const parsedArgs =
				args === undefined ? undefined : parseProofJson(JSON.stringify(args));
			host.calls.push({ command, args: parsedArgs });
			if (command === "is_fullscreen") {
				return Promise.resolve(host.fullscreen);
			}
			if (command === "open_tab_window") {
				return Promise.resolve(true);
			}
			if (command === "toggle_fullscreen") {
				if (host.failFullscreen) {
					return Promise.reject(new Error("Native fullscreen denied"));
				}
				host.fullscreen = !host.fullscreen;
				return Promise.resolve(host.fullscreen);
			}
			return Promise.resolve(null);
		},
	},
});

const nativeFetch = globalThis.fetch.bind(globalThis);
const renameFixture = new URLSearchParams(location.search).has("rename");
const RENAME_FIXTURE_TITLE_KEY =
	"titlebar-proof:conversation-rename-fixture-title";
globalThis.fetch = Object.assign((...args: Parameters<typeof fetch>) => {
	const [input, init] = args;
	const url = new URL(
		input instanceof Request ? input.url : String(input),
		location.href
	);
	if (
		url.protocol === "ipc:" ||
		url.hostname === "ipc.localhost" ||
		(url.origin === location.origin && !url.pathname.startsWith("/api/"))
	) {
		return nativeFetch(input, init);
	}
	if (renameFixture && url.pathname === "/api/conversations") {
		return Promise.resolve(
			Response.json({
				conversations: [
					{
						agent_id: null,
						archived: false,
						branch: null,
						created_at: 1,
						folder_path: null,
						id: "conversation-rename-fixture",
						message_count: 0,
						run_status: null,
						title:
							localStorage.getItem(RENAME_FIXTURE_TITLE_KEY) ??
							"Original discussion",
						updated_at: 1,
						worktree_path: null,
					},
				],
			})
		);
	}
	if (
		url.pathname === "/api/conversations/conversation-rename-fixture/title" &&
		init?.method === "POST"
	) {
		const bodyString = z.string().safeParse(init.body);
		const body = bodyString.success ? parseProofJson(bodyString.data) : null;
		const rename = z.object({ title: z.string() }).safeParse(body);
		if (rename.success) {
			localStorage.setItem(RENAME_FIXTURE_TITLE_KEY, rename.data.title);
		}
		host.renameRequests.push({ method: init.method, path: url.pathname, body });
		return Promise.resolve(Response.json({ ok: true }));
	}
	return Promise.resolve(
		Response.json(
			{ error: "TitleBar proof fixture: Core is not running" },
			{ status: 503 }
		)
	);
}, globalThis.fetch);

const artifacts = [
	{ id: "overview", path: "/artifact/overview", title: "Workspace overview" },
	{ id: "notes", path: "/artifact/notes", title: "Tab tear-out notes" },
	{ id: "checklist", path: "/artifact/checklist", title: "Release checklist" },
	{ id: "brief", path: "/artifact/brief", title: "Draft brief" },
];
const initialTabs = [
	...artifacts.map((tab, index) => ({
		path: tab.path,
		title: tab.title,
		pinned: index === 0,
	})),
	...(renameFixture
		? [
				{
					conversationId: "conversation-rename-fixture",
					path: "/chat",
					title: "Original discussion",
				},
			]
		: []),
];
if (sessionStorage.getItem("titlebar-actions-seeded") !== "true") {
	localStorage.setItem("ryu_startup_behavior", "restore");
	localStorage.setItem("ryu:tab-dropdown", "false");
	localStorage.setItem("ryu_node_tab_override_enabled", "true");
	localStorage.setItem(
		"ryu_session_tabs",
		JSON.stringify({
			tabs: initialTabs,
			activeIndex: 1,
		})
	);
	sessionStorage.setItem("titlebar-actions-seeded", "true");
}
if (renameFixture && localStorage.getItem(RENAME_FIXTURE_TITLE_KEY) === null) {
	localStorage.setItem(RENAME_FIXTURE_TITLE_KEY, "Original discussion");
}
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });
useNodeStore.setState({
	defaultNode: "local",
	nodes: [
		LOCAL_FALLBACK,
		{ name: "remote", url: "http://remote.invalid", token: null },
	],
	tabOverrides: {},
});
for (const tab of artifacts) {
	useArtifactStore.getState().put({
		id: tab.id,
		title: tab.title,
		kind: "html",
		sourceMessageId: "titlebar-actions-fixture",
		content: `<html><body style="margin:0;background:#131315;color:#e7e7e8;font:16px system-ui;line-height:1.8;padding:48px"><p style="color:#aaa;font-size:13px">LOCAL TITLEBAR FIXTURE</p><h1>${tab.title}</h1><p>TitleBar state verification content.</p><p>Fixture reference: TITLEBAR-ACTIONS-01</p></body></html>`,
	});
}

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
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
