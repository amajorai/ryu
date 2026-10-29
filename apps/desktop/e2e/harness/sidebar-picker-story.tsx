import { createTabsProofContext } from "./tabs-proof-context.ts";

declare const window: Window;

import { setTimezonePreference } from "@ryu/ui/lib/timezone.ts";
import proofStyles from "./sidebar-picker-story.module.css";
// Standalone browser story for the primitives the "Projects & Spaces as pickers"
// model is built out of: the REAL `SidebarScopePicker`, the REAL `SidebarChatList`
// (which is what routes any sidebar chat list through the "Group lists by date"
// preference) and the REAL `SpacesPickerBody` (the "All spaces" aggregate).
//
// Why a browser story rather than a unit test. The bucketing arithmetic itself is
// already pinned by `src/lib/sidebar/date-buckets.test.ts` — pure and fully
// covered. What that cannot see is everything this story is about:
//
//   - the picker is Base UI `Select`, which renders its list in a PORTAL. Whether
//     "All projects" is actually reachable, and whether picking an option swaps
//     the visible scope, are facts about popups and focus.
//   - `SidebarChatList` chooses between a bucketed body and a flat one by reading
//     localStorage through `useSyncExternalStore`. "The toggle actually changes
//     what renders" is a mount-time claim, not a type.
//   - the buckets are `SubSection`s holding their collapse state, and
//     `useNestedSections` reads its storage keys in `useState` INITIALIZERS only.
//     So "switching scope does not carry the previous scope's collapse set" is a
//     claim about remounting — invisible to a type-check, and wrong until the
//     `key` on `DateGroupedRows` was added.
//   - `SpacesPickerBody` fans out one `listDocuments` per space and flattens the
//     result. That the aggregate really is every space's documents, and that it
//     re-fetches for a narrowed scope, are facts about effects.
//
// Cases from one page, selected by query string:
//   (default)     projects picker, grouping ON  — chats under Today / Yesterday / …
//   ?group=off    projects picker, grouping OFF — one flat list, no bucket headers
//   ?view=spaces  the spaces picker body over two stubbed spaces
//
// Stubs are the two seams these components cannot supply themselves: `fetch`
// (Core's `/api/plugins/contributions`, which a chat row's menu reads) and a
// minimal `TabsContext` (a space document row opens tabs). Everything else is the
// shipping component.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	MessagingAgentRowBody,
	SidebarChatList,
	SidebarScopePicker,
	SpacesPickerBody,
} from "../../src/components/layout/AppSidebar.tsx";
import type { ChatRowHandlers } from "../../src/components/layout/sidebar-conversation-rows.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import { CHAT_DATE_GROUPING_KEY } from "../../src/hooks/useChatDateGrouping.ts";
import type { AgentSummary } from "../../src/lib/api/agents.ts";
import type { Space, SpaceDocument } from "../../src/lib/api/spaces.ts";
import type { Conversation } from "../../types/chat.ts";
import "../../src/index.css";

const DAY_MS = 86_400_000;

/** A chat `n` days old, so the story spans three different buckets rather than
 *  landing everything in "Today" and proving nothing. */
function conv(
	id: string,
	title: string,
	daysAgo: number,
	folderPath: string | null
): Conversation {
	const stamp = Date.now() - daysAgo * DAY_MS;
	return {
		id,
		title,
		runStatus: "idle",

		folderPath: folderPath ?? undefined,
		participants: [],

		messages: [],
		createdAt: stamp,
		updatedAt: stamp,
	};
}

const ALPHA = "/Users/dev/alpha";
const BETA = "/Users/dev/beta";

// BOTH projects own a "yesterday" chat on purpose: the collapse-leak case needs the
// same bucket to exist in both scopes, or "beta's Yesterday is still expanded" would
// pass for the trivial reason that beta has no Yesterday.
const DEFAULT_CONVERSATIONS = [
	conv("a1", "Alpha today", 0, ALPHA),
	conv("a2", "Alpha yesterday", 1, ALPHA),
	conv("b1", "Beta today", 0, BETA),
	conv("b2", "Beta yesterday", 1, BETA),
	conv("b3", "Beta last week", 4, BETA),
];

const rollover = new URLSearchParams(location.search).get("rollover");
const ROLLOVER_STAMPS =
	rollover === "spring"
		? [Date.parse("2026-03-08T05:30Z"), Date.parse("2026-03-09T03:30Z")]
		: [Date.parse("2026-11-01T04:30Z"), Date.parse("2026-11-02T04:30Z")];
const CONVERSATIONS = rollover
	? ROLLOVER_STAMPS.map((at, index) => ({
			...conv(`rollover-${index}`, `Stable midnight row ${index}`, 0, ALPHA),
			createdAt: at,
			updatedAt: at,
		}))
	: DEFAULT_CONVERSATIONS;

// The shipping messaging-row stamp is a second, independent day consumer: its
// label (clock time, "Yesterday", weekday, short date) comes from the same civil
// boundaries as the grouped rows, but the row receives no prop when midnight
// passes. It shares the latest rollover record so both consumers move together.
const MIDNIGHT_AGENT: AgentSummary = {
	avatarGlyph: null,
	avatarUrl: null,
	builtIn: true,
	createdAt: null,
	description: null,
	engine: "ryu",
	id: "midnight-agent",
	installHint: null,
	installed: true,
	latestVersion: null,
	lifecycleStatus: "active",
	locked: false,
	model: null,
	name: "Midnight agent",
	recommended: false,
	safetyProfile: "autonomous",
	systemPrompt: null,
	title: "",
	transport: "acp",
	version: null,
	versionStatus: "unknown",
};
const MIDNIGHT_AGENT_CONVERSATION = rollover
	? {
			...conv("midnight-agent-thread", "Midnight agent thread", 0, null),
			createdAt: ROLLOVER_STAMPS[1],
			lastMessage: "Retained agent preview",
			lastMessageAt: ROLLOVER_STAMPS[1],
			lastMessageRole: "assistant" as const,
			updatedAt: ROLLOVER_STAMPS[1],
		}
	: undefined;

const OPTIONS = [
	{ label: "alpha", value: ALPHA },
	{ label: "beta", value: BETA },
];

const handlers = {
	activeConversationId: null,
	agents: [],
	archivedIds: new Set<string>(),
	canMakePrivate: false,
	pinnedIds: new Set<string>(),
	unreadIds: new Set<string>(),
	loadMessages: () => Promise.resolve([]),
	onAddScheduledTask: () => undefined,
	onDeleteConversation: () => undefined,
	onForkConversation: () => undefined,
	onJumpToMessage: () => undefined,
	onMarkRead: () => undefined,
	onMarkUnread: () => undefined,
	onOpenQuickReply: () => undefined,
	onOpenInNewTab: () => undefined,
	onOpenInNewWindow: () => undefined,
	onOpenNewSideChat: () => undefined,
	onOpenSideChat: () => undefined,
	onMoveToProject: () => undefined,
	onRemoveFromProject: () => undefined,
	onRenameConversation: () => undefined,
	onRequestConversationVisibility: () => undefined,
	onSelectConversation: () => undefined,
	onSetConversationIcon: () => undefined,
	onToggleArchive: () => undefined,
	onTogglePin: () => undefined,
	projectTargets: [],
	projectNameForFolder: (folderPath: string) =>
		folderPath.split("/").at(-1) ?? folderPath,
	target: { url: "http://127.0.0.1:8980", token: null },
	// The fixture supplies the native row handler owner completely.
} satisfies ChatRowHandlers;

// ── The spaces case ──────────────────────────────────────────────────────────

const SPACES: Space[] = [
	{
		id: "sp-notes",
		name: "Notes",
		createdAt: 0,
		updatedAt: 0,
		description: null,
		retrievalMode: "vector",
		icon: null,
		system: false,
		documentCount: 2,
	},
	{
		id: "sp-uploads",
		name: "Uploads",
		createdAt: 0,
		updatedAt: 0,
		description: null,
		retrievalMode: "vector",
		icon: null,
		system: true,
		documentCount: 1,
	},
];

function doc(
	id: string,
	spaceId: string,
	title: string,
	daysAgo: number
): SpaceDocument {
	return {
		id,
		spaceId,
		title,
		kind: "page",
		rawKind: "page",
		icon: null,
		chunkCount: 1,
		createdAt: Date.now() - daysAgo * DAY_MS,
		updatedAt: Date.now() - daysAgo * DAY_MS,
		byteSize: null,
		mime: null,
		indexState: null,
		indexMessage: null,
		indexWarnings: [],
	};
}

const DOCS = new Map<string, SpaceDocument[]>(
	Object.entries({
		"sp-notes": [
			doc("d1", "sp-notes", "Note from today", 0),
			doc("d2", "sp-notes", "Note from yesterday", 1),
		],
		"sp-uploads": [doc("d3", "sp-uploads", "receipt.pdf", 0)],
	})
);

/** Records which spaces were actually asked for, so the spec can assert the
 *  aggregate fans out per space rather than reading one endpoint. */
const requested: string[] = [];

function listDocuments(spaceId: string): Promise<SpaceDocument[]> {
	requested.push(spaceId);
	const out = document.getElementById("requested");
	if (out) {
		out.textContent = requested.join(",");
	}
	return Promise.resolve(DOCS.get(spaceId) ?? []);
}

// Minimal TabsContext: a space document row reads `updateTabsIconWhere`, and
// `useTabsContext` throws without a provider.
const tabsStub = createTabsProofContext({
	updateTabsIconWhere: () => undefined,
	openTab: () => "sidebar-picker-proof-tab",
	// only the two members a document
	// row can reach are supplied; the context is 40+ members wide.
});

// Stand in for Core: the only read a chat row makes on mount.
const realFetch = window.fetch.bind(globalThis);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	if (url.includes("/api/plugins/contributions")) {
		return Promise.resolve(
			new Response(JSON.stringify({ context_menu_items: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		);
	}
	return realFetch(input, init);
};

const params = new URLSearchParams(location.search);
const groupOff = params.get("group") === "off";
const spacesView = params.get("view") === "spaces";

// Set BEFORE the first render: `useChatDateGrouping` reads localStorage in its
// `useSyncExternalStore` getter, so flipping it afterwards would be a second
// render rather than the initial state the spec means to assert.
localStorage.setItem(CHAT_DATE_GROUPING_KEY, groupOff ? "false" : "true");

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function ProjectsCase() {
	const [mounted, setMounted] = useState(true);
	const [selection, setSelection] = useState("all");
	const shown =
		selection === "all"
			? CONVERSATIONS
			: CONVERSATIONS.filter((c) => c.folderPath === selection);
	return (
		<>
			<SidebarScopePicker
				allLabel="All projects"
				onValueChange={setSelection}
				options={OPTIONS}
				value={selection}
			/>
			{rollover && (
				<>
					<button onClick={() => setMounted((value) => !value)} type="button">
						Toggle mounted rows
					</button>
					<button onClick={() => setTimezonePreference("UTC")} type="button">
						Use UTC
					</button>
					<button
						onClick={() => setTimezonePreference("America/New_York")}
						type="button"
					>
						Use New York
					</button>
					<pre data-testid="immutable-row-stamps">
						{JSON.stringify(
							CONVERSATIONS.map(({ id, createdAt, updatedAt }) => ({
								id,
								createdAt,
								updatedAt,
							}))
						)}
					</pre>
				</>
			)}
			{mounted && rollover && (
				<div
					className="group/row flex items-center gap-2"
					data-testid="midnight-agent-row"
				>
					<MessagingAgentRowBody
						agent={MIDNIGHT_AGENT}
						conversation={MIDNIGHT_AGENT_CONVERSATION}
						onEdit={() => undefined}
						onToggleThreads={() => undefined}
						showEdit={false}
						threadCount={0}
						threadsExpanded={false}
						usageBarVisible={false}
					/>
				</div>
			)}
			{mounted && (
				<SidebarChatList
					conversations={shown}
					handlers={handlers}
					scope={selection}
				/>
			)}
			<pre data-testid="selection">{selection}</pre>
		</>
	);
}

function SpacesCase() {
	const [selection, setSelection] = useState("all");
	const shown =
		selection === "all" ? SPACES : SPACES.filter((s) => s.id === selection);
	return (
		<>
			<SidebarScopePicker
				allLabel="All spaces"
				onValueChange={setSelection}
				options={SPACES.map((s) => ({ label: s.name, value: s.id }))}
				value={selection}
			/>
			<SpacesPickerBody
				listDocuments={listDocuments}
				onOpenDoc={() => undefined}
				pageSize={10}
				setDocumentIcon={() => Promise.resolve()}
				sort="default"
				spaces={shown}
			/>
			<pre data-testid="selection">{selection}</pre>
			<pre data-testid="requested" id="requested" />
		</>
	);
}

function Story() {
	return (
		<QueryClientProvider client={queryClient}>
			<TabsContext.Provider value={tabsStub}>
				<div className={proofStyles.fixture1}>
					<div className={proofStyles.fixture2} data-testid="section">
						{spacesView ? <SpacesCase /> : <ProjectsCase />}
					</div>
				</div>
			</TabsContext.Provider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
