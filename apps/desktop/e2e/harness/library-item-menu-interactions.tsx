import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { SkillDistributionProvider } from "../../src/components/skills/SkillDistributionProvider.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { ChatHistoryProvider } from "../../src/contexts/ChatHistoryContext.tsx";
import { SpacesProvider } from "../../src/contexts/SpacesContext.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import { queryClient } from "../../src/lib/query-client.ts";
import LibraryPage from "../../src/pages/LibraryPage.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { type ProofJsonValue, parseProofJsonRecord } from "../fixture-json.ts";
import { EntitlementProvider } from "./app-sidebar-entitlement.mock.tsx";
import { createTabsProofContext } from "./tabs-proof-context.ts";
import "../../src/index.css";

const SERVER_STATE_KEY = "ryu:e2e:library-item-menu-core-state";
const CHAT_ID = "conversation-library-menu";
const SPACE_ID = "space-system-uploads";
const CORE_URL = "http://127.0.0.1:5200";

interface ConversationWire {
	agent_id: string | null;
	archived?: boolean;
	branch: string | null;
	created_at: number;
	folder_path: string | null;
	id: string;
	message_count: number;
	pinned?: boolean;
	run_status: string | null;
	title: string | null;
	updated_at: number;
	worktree_path: string | null;
}

interface CoreState {
	conversations: ConversationWire[];
	spaces: Array<{
		created_at: number;
		description: string;
		document_count: number;
		id: string;
		name: string;
		retrieval_mode: string;
		system: boolean;
		updated_at: number;
		visibility: string;
	}>;
}

interface RecordedRequest {
	body: unknown;
	method: string;
	path: string;
}

interface OpenedTab {
	options: NonNullable<
		Parameters<ReturnType<typeof createTabsProofContext>["openTab"]>[1]
	>;
	path: string;
}

interface LibraryMenuFixture {
	clipboardText: string | null;
	failNextDelete: boolean;
	failNextRename: boolean;
	openedTabs: OpenedTab[];
	readonly requests: RecordedRequest[];
}

declare global {
	interface Window {
		__libraryMenuFixture?: LibraryMenuFixture;
	}
}

function seedCoreState(): CoreState {
	const stored = localStorage.getItem(SERVER_STATE_KEY);
	if (stored) {
		try {
			return JSON.parse(stored);
		} catch {
			localStorage.removeItem(SERVER_STATE_KEY);
		}
	}
	const now = Date.now();
	const state: CoreState = {
		conversations: [
			{
				agent_id: null,
				archived: false,
				branch: null,
				created_at: now - 30_000,
				folder_path: null,
				id: CHAT_ID,
				message_count: 2,
				pinned: false,
				run_status: null,
				title: "Fixture conversation",
				updated_at: now - 10_000,
				worktree_path: null,
			},
		],
		spaces: [
			{
				created_at: now - 90_000,
				description: "Ryu maintained uploads",
				document_count: 0,
				id: SPACE_ID,
				name: "System Uploads",
				retrieval_mode: "vector",
				system: true,
				updated_at: now - 20_000,
				visibility: "private",
			},
		],
	};
	localStorage.setItem(SERVER_STATE_KEY, JSON.stringify(state));
	return state;
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

function installFixture(): LibraryMenuFixture {
	const state = seedCoreState();
	const fixture: LibraryMenuFixture = {
		clipboardText: null,
		failNextDelete: false,
		failNextRename: false,
		openedTabs: [],
		requests: [],
	};
	window.__libraryMenuFixture = fixture;
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: async (text: string) => {
				if (fixture.failNextClipboard) {
					fixture.failNextClipboard = false;
					throw new Error("Clipboard write was rejected.");
				}
				fixture.clipboardText = text;
			},
		},
	});

	window.fetch = async (input, init) => {
		const requestUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(requestUrl, window.location.href);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		let body: ProofJsonValue = null;
		if (isNativeText(init?.body)) {
			body = parseProofJsonRecord(init.body);
		}
		fixture.requests.push({ body, method, path: url.pathname });

		if (url.pathname === "/api/conversations" && method === "GET") {
			return json({ conversations: state.conversations });
		}
		if (url.pathname === `/api/conversations/${CHAT_ID}` && method === "GET") {
			return json({
				messages: [
					{
						content: "Found a useful regression case.",
						created_at: 0,
						id: "message-user",
						role: "user",
					},
					{
						content: "I will add a focused check.",
						created_at: 0,
						id: "message-assistant",
						role: "assistant",
					},
				],
			});
		}
		if (
			url.pathname === `/api/conversations/${CHAT_ID}/title` &&
			method === "POST"
		) {
			if (fixture.failNextRename) {
				fixture.failNextRename = false;
				return json({ error: "Core rejected this title." }, 503);
			}
			const title = body && "title" in body ? String(body.title) : "";
			state.conversations = state.conversations.map((conversation) =>
				conversation.id === CHAT_ID
					? { ...conversation, title, updated_at: Date.now() }
					: conversation
			);
			localStorage.setItem(SERVER_STATE_KEY, JSON.stringify(state));
			return json({ ok: true });
		}
		if (
			url.pathname === `/api/conversations/${CHAT_ID}` &&
			method === "DELETE"
		) {
			if (fixture.failNextDelete) {
				fixture.failNextDelete = false;
				return json({ error: "Core rejected this deletion." }, 503);
			}
			state.conversations = state.conversations.filter(
				(conversation) => conversation.id !== CHAT_ID
			);
			localStorage.setItem(SERVER_STATE_KEY, JSON.stringify(state));
			return json({ ok: true });
		}
		for (const flag of ["pinned", "archived"] as const) {
			if (
				url.pathname === `/api/conversations/${CHAT_ID}/${flag}` &&
				method === "POST"
			) {
				const value = body && "value" in body ? body.value === true : false;
				state.conversations = state.conversations.map((conversation) =>
					conversation.id === CHAT_ID
						? { ...conversation, [flag]: value }
						: conversation
				);
				localStorage.setItem(SERVER_STATE_KEY, JSON.stringify(state));
				return json({ ok: true });
			}
		}
		if (url.pathname === "/api/spaces" && method === "GET") {
			return json({ spaces: state.spaces });
		}
		if (url.pathname === "/api/plugins/contributions" && method === "GET") {
			return json({
				context_menu_items: [
					{
						anchor: "conversation",
						args: { source: "library" },
						capability: "library.review",
						id: "review-conversation",
						label: "Run library review",
						order: 5,
						plugin: "com.ryu.fixture-review",
					},
				],
			});
		}
		if (
			url.pathname === "/api/plugins/com.ryu.fixture-review/host" &&
			method === "POST"
		) {
			return json({ ok: true });
		}
		return json({});
	};
	return fixture;
}

function Harness() {
	const initialSection =
		new URLSearchParams(window.location.search).get("section") ?? "recents";
	const tabsValue = createTabsProofContext({
		activateTab: () => undefined,
		openTab: (
			path: string,
			options: NonNullable<
				Parameters<ReturnType<typeof createTabsProofContext>["openTab"]>[1]
			> = {}
		) => {
			window.__libraryMenuFixture?.openedTabs.push({ options, path });
			return "proof-opened-tab";
		},
		tabs: [],
	});
	return (
		<TabsContext.Provider value={tabsValue}>
			<LibraryPage initialSection={initialSection} />
		</TabsContext.Provider>
	);
}

const now = Date.now();
useNodeStore.setState({
	autoSelect: false,
	defaultNode: "Library menu fixture node",
	nodes: [
		{
			name: "Library menu fixture node",
			url: CORE_URL,
			token: "library-menu-fixture-token",
			userJwt: null,
		},
	],
});
localStorage.setItem(
	"ryu:library-recents",
	JSON.stringify([
		{ id: CHAT_ID, ts: now, type: "chat" },
		{ id: SPACE_ID, ts: now - 1, type: "space" },
	])
);
queryClient.clear();
installFixture();

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Library menu fixture root is missing.");
}
createRoot(rootElement).render(
	<I18nProvider>
		<ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
			<AppSurfaceProvider surface="desktop">
				<QueryClientProvider client={queryClient}>
					<TooltipProvider delay={0}>
						<EntitlementProvider>
							<ChatHistoryProvider>
								<SpacesProvider>
									<SkillDistributionProvider>
										<Harness />
										<Toaster position="bottom-right" theme="dark" />
									</SkillDistributionProvider>
								</SpacesProvider>
							</ChatHistoryProvider>
						</EntitlementProvider>
					</TooltipProvider>
				</QueryClientProvider>
			</AppSurfaceProvider>
		</ThemeProvider>
	</I18nProvider>
);
