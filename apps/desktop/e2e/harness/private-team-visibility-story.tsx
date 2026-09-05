import {
	UserMultiple02Icon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ContextType, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	SidebarChatList,
	SidebarScopePicker,
	SpaceSidebarRow,
	SubSection,
} from "../../src/components/layout/AppSidebar.tsx";
import { ResourceVisibilityConfirmationDialog } from "../../src/components/layout/ResourceVisibilityConfirmationDialog.tsx";
import { ResourceVisibilityIndicator } from "../../src/components/layout/ResourceVisibilityIndicator.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import type { Space, SpaceDocument } from "../../src/lib/api/spaces.ts";
import {
	type ResourceVisibilityGroup,
	resourceVisibilityGroup,
	type VisibilityChangeRequest,
	type VisibilityDragPayload,
} from "../../src/lib/resource-visibility.ts";
import type { Conversation } from "../../src/types/chat.ts";
import "../../src/index.css";

const DAY_MS = 86_400_000;

function stamp(daysAgo: number) {
	return Date.now() - daysAgo * DAY_MS;
}

function conversation(
	id: string,
	title: string,
	visibility: "private" | "org",
	daysAgo: number
): Conversation {
	const time = stamp(daysAgo);
	return {
		agentId: null,
		branch: null,
		createdAt: time,
		folderPath: null,
		id,
		lastMessage: visibility === "org" ? "Ready for review" : "Working notes",
		participants: [],
		messages: [],
		runStatus: "idle",
		title,
		updatedAt: time,
		visibility,
		worktreePath: null,
	} as unknown as Conversation;
}

function spaceDocument(
	id: string,
	spaceId: string,
	title: string,
	daysAgo: number
): SpaceDocument {
	const time = stamp(daysAgo);
	return {
		byteSize: null,
		chunkCount: 1,
		createdAt: time,
		icon: null,
		id,
		indexMessage: null,
		indexState: null,
		indexWarnings: [],
		kind: "page",
		mime: null,
		rawKind: "page",
		spaceId,
		title,
		updatedAt: time,
	} as unknown as SpaceDocument;
}

const INITIAL_SPACES: Space[] = [
	{
		createdAt: stamp(4),
		description: "Only you can see these pages.",
		documentCount: 1,
		icon: null,
		id: "space-private",
		name: "Personal notes",
		retrievalMode: "vector",
		system: false,
		updatedAt: stamp(0),
		visibility: "private",
	},
	{
		createdAt: stamp(3),
		description: "Visible to everyone on this shared node.",
		documentCount: 2,
		icon: null,
		id: "space-team",
		name: "Team knowledge",
		retrievalMode: "vector",
		system: false,
		updatedAt: stamp(0),
		visibility: "org",
	},
];

const DOCUMENTS: Record<string, SpaceDocument[]> = {
	"space-private": [
		spaceDocument("doc-private", "space-private", "Private launch notes", 0),
	],
	"space-team": [
		spaceDocument("doc-team-brief", "space-team", "Launch brief", 0),
		spaceDocument("doc-team-meeting", "space-team", "Meeting notes", 1),
	],
};

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input.toString();
	if (url.includes("/api/plugins/contributions")) {
		return Promise.resolve(
			new Response(JSON.stringify({ context_menu_items: [] }), {
				headers: { "content-type": "application/json" },
				status: 200,
			})
		);
	}
	return realFetch(input as RequestInfo, init);
}) as typeof fetch;

const tabsStub = {
	openTab: () => undefined,
	updateTabsIconWhere: () => undefined,
} as unknown as NonNullable<ContextType<typeof TabsContext>>;

const dnd = {
	draggingKey: null,
	dragOverKey: null,
	onDragEnd: () => undefined,
	onDragOver: () => undefined,
	onDragStart: () => undefined,
	onDrop: () => undefined,
	order: ["private", "team"],
} as never;

const initialConversations = [
	conversation("chat-private", "Private prompt", "private", 0),
	conversation("chat-team", "Team roadmap", "org", 1),
];

const groupLabel = (group: ResourceVisibilityGroup) =>
	group === "private" ? "Private" : "Team";

const groupDescription = (group: ResourceVisibilityGroup) =>
	group === "private"
		? "Only you can access these spaces and chats."
		: "Shared with everyone on this node.";

function VisibilityGroup({
	children,
	count,
	group,
	onChatDrop,
}: {
	children: ReactNode;
	count: number;
	group: ResourceVisibilityGroup;
	onChatDrop: (payload: VisibilityDragPayload) => void;
}) {
	return (
		<SubSection
			collapsed={false}
			count={count}
			dnd={dnd}
			icon={group === "private" ? ViewOffSlashIcon : UserMultiple02Icon}
			label={groupLabel(group)}
			onToggleCollapsed={() => undefined}
			sectionKey={group}
			size="md"
			visibilityDrop={{
				accept: "chat",
				canDrop: () => true,
				onDrop: onChatDrop,
			}}
		>
			<div className="mb-2 px-2 text-[11px] text-muted-foreground">
				{groupDescription(group)}
			</div>
			{children}
		</SubSection>
	);
}

function Story() {
	const [spaces, setSpaces] = useState(INITIAL_SPACES);
	const [conversations, setConversations] = useState(initialConversations);
	const [pendingVisibility, setPendingVisibility] =
		useState<VisibilityChangeRequest | null>(null);
	const [status, setStatus] = useState(
		"Choose a scope to see its pages and chats."
	);

	const requestVisibilityChange = (request: VisibilityChangeRequest) => {
		setPendingVisibility(request);
	};

	const confirmVisibilityChange = () => {
		if (!pendingVisibility) {
			return;
		}
		if (pendingVisibility.resourceType === "space") {
			void setSpaceVisibility(
				pendingVisibility.id,
				pendingVisibility.to === "team" ? "org" : "private"
			);
		} else {
			setConversationVisibility(
				pendingVisibility.id,
				pendingVisibility.to === "team" ? "org" : "private"
			);
		}
		setPendingVisibility(null);
	};

	const setSpaceVisibility = async (
		id: string,
		visibility: "private" | "org"
	) => {
		setSpaces((current) =>
			current.map((space) =>
				space.id === id ? { ...space, visibility } : space
			)
		);
		setStatus(
			visibility === "org" ? "Space shared with the team" : "Space made private"
		);
	};

	const setConversationVisibility = (
		id: string,
		visibility: "private" | "org"
	) => {
		setConversations((current) =>
			current.map((item) => (item.id === id ? { ...item, visibility } : item))
		);
		setStatus(
			visibility === "org" ? "Chat shared with the team" : "Chat made private"
		);
	};

	const renderSpaces = (group: ResourceVisibilityGroup) =>
		spaces
			.filter(
				(space) =>
					resourceVisibilityGroup(space.visibility, space.system) === group
			)
			.map((space) => (
				<SpaceSidebarRow
					canMakePrivate
					key={space.id}
					listDocuments={(spaceId) => Promise.resolve(DOCUMENTS[spaceId] ?? [])}
					onAdd={() => undefined}
					onOpen={() => undefined}
					onOpenDoc={() => undefined}
					onOpenInNewTab={() => undefined}
					onRename={() => Promise.resolve()}
					onRequestDelete={() => undefined}
					onRequestVisibilityChange={requestVisibilityChange}
					setDocumentIcon={() => Promise.resolve()}
					setSpaceIcon={() => Promise.resolve()}
					space={space}
				/>
			));

	const renderChats = (group: ResourceVisibilityGroup) => (
		<SidebarChatList
			conversations={conversations.filter(
				(item) => resourceVisibilityGroup(item.visibility) === group
			)}
			handlers={{
				activeConversationId: null,
				agents: [],
				archivedIds: new Set<string>(),
				canMakePrivate: true,
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
				onRequestConversationVisibility: requestVisibilityChange,
				onSelectConversation: () => undefined,
				onSetConversationIcon: () => undefined,
				onToggleArchive: () => undefined,
				onTogglePin: () => undefined,
				pinnedIds: new Set<string>(),
				projectNameForFolder: (folderPath: string) =>
					folderPath.split("/").at(-1) ?? folderPath,
				target: { token: null, url: "http://127.0.0.1:8980" },
				unreadIds: new Set<string>(),
			}}
			scope={`visibility:${group}`}
		/>
	);

	return (
		<div className="min-h-screen bg-muted/30 p-10 text-foreground">
			<div className="mx-auto flex max-w-6xl gap-6">
				<aside className="w-[360px] shrink-0 rounded-2xl border bg-background p-4 shadow-sm">
					<div className="mb-5 border-b pb-4">
						<p className="font-semibold text-lg">Shared node</p>
						<p className="mt-1 text-muted-foreground text-xs">
							Spaces, pages, and chats stay private by default.
						</p>
					</div>
					<div className="space-y-4">
						{(["private", "team"] as ResourceVisibilityGroup[]).map((group) => {
							const groupSpaces = spaces.filter(
								(space) =>
									resourceVisibilityGroup(space.visibility, space.system) ===
									group
							);
							return (
								<VisibilityGroup
									count={groupSpaces.length}
									group={group}
									key={group}
									onChatDrop={(payload) =>
										requestVisibilityChange({ ...payload, to: group })
									}
								>
									<SidebarScopePicker
										allLabel={
											group === "private"
												? "All private spaces"
												: "All team spaces"
										}
										icon={
											group === "private"
												? ViewOffSlashIcon
												: UserMultiple02Icon
										}
										onValueChange={() => undefined}
										options={groupSpaces.map((space) => ({
											label: space.name,
											value: space.id,
										}))}
										value="all"
									/>
									<div className="space-y-1">{renderSpaces(group)}</div>
									<div className="mt-2 border-t pt-2">{renderChats(group)}</div>
								</VisibilityGroup>
							);
						})}
					</div>
					<div
						className="mt-5 rounded-lg bg-muted/60 px-3 py-2 text-muted-foreground text-xs"
						data-testid="status"
					>
						{status}
					</div>
				</aside>
				<section className="flex-1 rounded-2xl border bg-background p-8 shadow-sm">
					<p className="font-semibold text-xl">Team workspace</p>
					<p className="mt-2 max-w-xl text-muted-foreground text-sm leading-6">
						A shared node can hold durable team knowledge without making
						personal prompts or pages visible to everyone.
					</p>
					<div className="mt-8 grid gap-3 sm:grid-cols-2">
						<div className="rounded-xl border p-4">
							<div className="flex items-center gap-2 font-medium text-sm">
								<ResourceVisibilityIndicator visibility="private" /> Private by
								default
							</div>
							<p className="mt-2 text-muted-foreground text-xs leading-5">
								Personal pages and chats are scoped to the current user.
							</p>
						</div>
						<div className="rounded-xl border p-4">
							<div className="flex items-center gap-2 font-medium text-sm">
								<ResourceVisibilityIndicator visibility="org" /> Share with team
							</div>
							<p className="mt-2 text-muted-foreground text-xs leading-5">
								One action makes a space, its pages, or a chat available to
								teammates.
							</p>
						</div>
					</div>
				</section>
			</div>
			<ResourceVisibilityConfirmationDialog
				canMakePrivate
				onConfirm={confirmVisibilityChange}
				onOpenChange={(open) => {
					if (!open) {
						setPendingVisibility(null);
					}
				}}
				request={pendingVisibility}
			/>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	localStorage.setItem("ryu:sidebar-group-by-date", "false");
	createRoot(root).render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<TabsContext.Provider value={tabsStub}>
				<Story />
			</TabsContext.Provider>
		</QueryClientProvider>
	);
}
