import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { SidebarMenu, SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { Fragment, useState } from "react";
import {
	conversationGroupKey,
	conversationParticipantIds,
} from "@/src/lib/agent-conversation-groups.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import { folderKey } from "@/src/lib/folder-path.ts";
import { compactAge } from "@/src/lib/time.ts";
import { workspaceProjectName } from "@/src/lib/workspace-projects.ts";
import type { WorkspaceProject } from "@/src/store/useWorkspaceStore.ts";
import type { Conversation } from "@/types/chat.ts";
import type { ChatRowHandlers } from "./sidebar-conversation-rows.tsx";
import {
	ChatRow,
	ParticipantOrbitAvatar,
} from "./sidebar-conversation-rows.tsx";
import { projectFolderLeaf } from "./sidebar-panel-state.tsx";
import { DEFAULT_PAGE_SIZE } from "./sidebar-scope-picker.tsx";
import { SectionPagingControls } from "./sidebar-section-overflow.tsx";
import { chatSearchText, usePaged } from "./sidebar-sort-paging.ts";

/** Shared callbacks/state threaded into every chat row, regardless of group. */

interface ConversationListEntry {
	conversation?: Conversation;
	groupKey?: string;
	threads?: Conversation[];
}

/** Collapse all conversations with the same participant set into one group
 *  header while preserving the original activity order. */
function groupConversationEntries(
	conversations: Conversation[]
): ConversationListEntry[] {
	const entries: ConversationListEntry[] = [];
	const groups = new Map<string, ConversationListEntry>();
	for (const conversation of conversations) {
		const groupKey = conversationGroupKey(conversation);
		if (!groupKey) {
			entries.push({ conversation });
			continue;
		}
		const existing = groups.get(groupKey);
		if (existing) {
			existing.threads?.push(conversation);
			continue;
		}
		const entry: ConversationListEntry = {
			groupKey,
			threads: [conversation],
		};
		groups.set(groupKey, entry);
		entries.push(entry);
	}
	return entries;
}

function groupParticipantLabel(
	conversation: Conversation,
	agents: AgentSummary[]
): string {
	const names = conversationParticipantIds(conversation).map(
		(id) => agents.find((agent) => agent.id === id)?.name ?? id
	);
	if (names.length === 0) {
		return "Multiple participants";
	}
	if (names.length <= 3) {
		return names.join(" · ");
	}
	return `${names.slice(0, 2).join(" · ")} +${names.length - 2}`;
}

/** One group-chat header with the same paginated child rows used by the rest of
 *  the sidebar. The child rows remain real ChatRows, so rename/archive/open and
 *  the existing Messages/Side chats accordions keep their behavior. */
function GroupChatRow({
	handlers,
	pageSize,
	threads,
}: {
	handlers: ChatRowHandlers;
	pageSize: number;
	threads: Conversation[];
}) {
	const tl = useLiteralMessages();
	const [expanded, setExpanded] = useState(false);
	const paged = usePaged(threads, pageSize);
	const latest = threads[0];
	if (!latest) {
		return null;
	}
	const participants = conversationParticipantIds(latest);
	const participantLabel = groupParticipantLabel(latest, handlers.agents);
	const preview = latest.lastMessage?.trim();
	const openLatest = () => handlers.onSelectConversation(latest.id);
	return (
		<SidebarMenuItem>
			{/* group header owns a disclosure button and a row-level open action */}
			<div
				className="group/group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted"
				onClick={openLatest}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						openLatest();
					}
				}}
				role="button"
				tabIndex={0}
			>
				<button
					aria-expanded={expanded}
					aria-label={
						expanded
							? tl("Collapse group chat threads")
							: tl("Expand group chat threads")
					}
					className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
					onClick={(event) => {
						event.stopPropagation();
						setExpanded((value) => !value);
					}}
					type="button"
				>
					<HugeiconsIcon
						className={`size-3 transition-transform ${expanded ? "" : "-rotate-90"}`}
						icon={ArrowDown01Icon}
					/>
				</button>
				<ParticipantOrbitAvatar
					agents={handlers.agents}
					participants={participants}
					size="md"
				/>
				<span className="min-w-0 flex-1">
					<span className="flex min-w-0 items-center gap-2">
						<span className="truncate font-medium text-sm">Group chat</span>
						<span className="type-compact shrink-0 text-muted-foreground/70 tabular-nums">
							{compactAge(latest.updatedAt)}
						</span>
					</span>
					<span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
						<span className="min-w-0 flex-1 truncate">{participantLabel}</span>
						{preview ? (
							<span className="max-w-[45%] truncate text-muted-foreground/70">
								{preview}
							</span>
						) : null}
					</span>
				</span>
				<span className="type-compact shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground tabular-nums">
					{formatCount(threads.length) ?? "—"}
				</span>
			</div>
			{expanded ? (
				<div className="relative ml-7 border-sidebar-border/70 border-l pl-2">
					<SidebarMenu>
						{paged.visible.map((conversation) => (
							<ChatRow
								conv={conversation}
								handlers={handlers}
								key={conversation.id}
							/>
						))}
					</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: chatSearchText,
							items: paged.items,
							label: "group threads",
							renderList: (list) => (
								<SidebarMenu>
									{list.map((conversation) => (
										<ChatRow
											conv={conversation}
											handlers={handlers}
											key={conversation.id}
										/>
									))}
								</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</div>
			) : null}
		</SidebarMenuItem>
	);
}

/** Renders chat rows, converging multi-participant conversations into group
 *  chats with expandable/paginated child threads. */
/**
 * Console's expandable sessions under a main-thread row. Bot mode hides
 * sessions behind their main thread (session cards and the Sessions panel);
 * Console keeps them one disclosure away in the sidebar itself.
 */
function SessionDisclosure({
	handlers,
	sessions,
}: {
	handlers: ChatRowHandlers;
	sessions: Conversation[];
}) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	if (sessions.length === 0) {
		return null;
	}
	return (
		<li className="list-none">
			<button
				aria-expanded={open}
				className="flex w-full items-center gap-1 rounded-md py-0.5 pr-2 pl-8 text-left text-muted-foreground text-xs hover:text-foreground"
				onClick={() => setOpen((current) => !current)}
				type="button"
			>
				<HugeiconsIcon
					className={open ? "rotate-0" : "-rotate-90"}
					icon={ArrowDown01Icon}
					size={12}
				/>
				{tl("{count, plural, one {# session} other {# sessions}}", {
					count: sessions.length,
				})}
			</button>
			{open ? (
				<SidebarMenu nestedIndent>
					{sessions.map((session) => (
						<ChatRow conv={session} handlers={handlers} key={session.id} />
					))}
				</SidebarMenu>
			) : null}
		</li>
	);
}

export function ChatRowList({
	className,
	conversations,
	handlers,
	groupMultiParticipant = true,
	pageSize = DEFAULT_PAGE_SIZE,
	sessionsFor,
}: {
	className?: string;
	conversations: Conversation[];
	groupMultiParticipant?: boolean;
	handlers: ChatRowHandlers;
	pageSize?: number;
	/** Console: the sessions to list (collapsed) beneath each main thread. */
	sessionsFor?: (conversationId: string) => Conversation[];
}) {
	const entries: ConversationListEntry[] = groupMultiParticipant
		? groupConversationEntries(conversations)
		: conversations.map((conversation) => ({ conversation }));
	return (
		<SidebarMenu className={className}>
			{entries.map((entry) =>
				entry.threads ? (
					<GroupChatRow
						handlers={handlers}
						key={entry.groupKey}
						pageSize={pageSize}
						threads={entry.threads}
					/>
				) : entry.conversation ? (
					<Fragment key={entry.conversation.id}>
						<ChatRow conv={entry.conversation} handlers={handlers} />
						{sessionsFor ? (
							<SessionDisclosure
								handlers={handlers}
								sessions={sessionsFor(entry.conversation.id)}
							/>
						) : null}
					</Fragment>
				) : null
			)}
		</SidebarMenu>
	);
}

/** The production conversation-list seam, exported for browser stories that
 *  need to exercise grouping without mounting the whole desktop shell. */
export function SidebarConversationList({
	conversations,
	groupMultiParticipant = true,
	handlers,
	pageSize = DEFAULT_PAGE_SIZE,
}: {
	conversations: Conversation[];
	groupMultiParticipant?: boolean;
	handlers: ChatRowHandlers;
	pageSize?: number;
}) {
	return (
		<ChatRowList
			conversations={conversations}
			groupMultiParticipant={groupMultiParticipant}
			handlers={handlers}
			pageSize={pageSize}
		/>
	);
}

export interface ProjectBucket {
	conversations: Conversation[];
	name: string;
	path: string;
	sourceFolders: string[];
}

/** Group conversations by their workspace folder (Codex-style projects). */
export function groupByProject(
	convs: Conversation[],
	workspaceProjects: readonly WorkspaceProject[] = []
) {
	// Keyed by `folderKey`, not the raw string: an imported thread's cwd and a
	// native run's folder are produced by different writers and differ by
	// punctuation often enough that raw equality split one project in two.
	const projects = new Map<string, ProjectBucket>();
	const projectByFolder = new Map<string, WorkspaceProject>();
	for (const project of workspaceProjects) {
		for (const folder of project.folders) {
			projectByFolder.set(folderKey(folder), project);
		}
	}
	const loose: Conversation[] = [];
	for (const conv of convs) {
		if (!conv.folderPath) {
			loose.push(conv);
			continue;
		}
		const workspaceProject = projectByFolder.get(folderKey(conv.folderPath));
		const projectPath = workspaceProject?.folders[0] ?? conv.folderPath;
		const existing = projects.get(folderKey(projectPath));
		if (existing) {
			existing.conversations.push(conv);
		} else {
			projects.set(folderKey(projectPath), {
				name: workspaceProject
					? workspaceProjectName(workspaceProject)
					: projectFolderLeaf(projectPath),
				path: projectPath,
				sourceFolders: workspaceProject?.folders ?? [conv.folderPath],
				conversations: [conv],
			});
		}
	}
	return { projects: [...projects.values()], loose };
}
