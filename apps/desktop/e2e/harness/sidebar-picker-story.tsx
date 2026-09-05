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
	SidebarChatList,
	SidebarScopePicker,
	SpacesPickerBody,
} from "../../src/components/layout/AppSidebar.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import { CHAT_DATE_GROUPING_KEY } from "../../src/hooks/useChatDateGrouping.ts";
import type { Space, SpaceDocument } from "../../src/lib/api/spaces.ts";
import type { Conversation } from "../../src/types/chat.ts";
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
		folderPath,
		worktreePath: null,
		branch: null,
		participants: [],
		agentId: null,
		messages: [],
		createdAt: stamp,
		updatedAt: stamp,
	} as unknown as Conversation;
}

const ALPHA = "/Users/dev/alpha";
const BETA = "/Users/dev/beta";

// BOTH projects own a "yesterday" chat on purpose: the collapse-leak case needs the
// same bucket to exist in both scopes, or "beta's Yesterday is still expanded" would
// pass for the trivial reason that beta has no Yesterday.
const CONVERSATIONS = [
	conv("a1", "Alpha today", 0, ALPHA),
	conv("a2", "Alpha yesterday", 1, ALPHA),
	conv("b1", "Beta today", 0, BETA),
	conv("b2", "Beta yesterday", 1, BETA),
	conv("b3", "Beta last week", 4, BETA),
];

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
	onOpenInNewTab: () => undefined,
	onOpenInNewWindow: () => undefined,
	onOpenNewSideChat: () => undefined,
	onOpenSideChat: () => undefined,
	onRemoveFromProject: () => undefined,
	onRenameConversation: () => undefined,
	onRequestConversationVisibility: () => undefined,
	onSelectConversation: () => undefined,
	onSetConversationIcon: () => undefined,
	onToggleArchive: () => undefined,
	onTogglePin: () => undefined,
	projectNameForFolder: (folderPath: string) =>
		folderPath.split("/").at(-1) ?? folderPath,
	target: { url: "http://127.0.0.1:8980", token: null },
	// biome-ignore lint/suspicious/noExplicitAny: the story supplies only the
	// handlers a row can reach; the rest of the bundle is unused here.
} as any;

// ── The spaces case ──────────────────────────────────────────────────────────

const SPACES = [
	{
		id: "sp-notes",
		name: "Notes",
		icon: null,
		system: false,
		documentCount: 2,
	},
	{
		id: "sp-uploads",
		name: "Uploads",
		icon: null,
		system: true,
		documentCount: 1,
	},
] as unknown as Space[];

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
	} as unknown as SpaceDocument;
}

const DOCS: Record<string, SpaceDocument[]> = {
	"sp-notes": [
		doc("d1", "sp-notes", "Note from today", 0),
		doc("d2", "sp-notes", "Note from yesterday", 1),
	],
	"sp-uploads": [doc("d3", "sp-uploads", "receipt.pdf", 0)],
};

/** Records which spaces were actually asked for, so the spec can assert the
 *  aggregate fans out per space rather than reading one endpoint. */
const requested: string[] = [];

function listDocuments(spaceId: string): Promise<SpaceDocument[]> {
	requested.push(spaceId);
	const out = document.getElementById("requested");
	if (out) {
		out.textContent = requested.join(",");
	}
	return Promise.resolve(DOCS[spaceId] ?? []);
}

// Minimal TabsContext: a space document row reads `updateTabsIconWhere`, and
// `useTabsContext` throws without a provider.
const tabsStub = {
	updateTabsIconWhere: () => undefined,
	openTab: () => undefined,
	// biome-ignore lint/suspicious/noExplicitAny: only the two members a document
	// row can reach are supplied; the context is 40+ members wide.
} as any;

// Stand in for Core: the only read a chat row makes on mount.
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input.toString();
	if (url.includes("/api/plugins/contributions")) {
		return Promise.resolve(
			new Response(JSON.stringify({ context_menu_items: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		);
	}
	return realFetch(input as RequestInfo, init);
}) as typeof fetch;

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
			<SidebarChatList
				conversations={shown}
				handlers={handlers}
				scope={selection}
			/>
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
				<div style={{ padding: 40 }}>
					<div data-testid="section" style={{ width: 260 }}>
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
