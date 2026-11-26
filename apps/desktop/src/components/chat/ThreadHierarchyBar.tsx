// apps/desktop/src/components/chat/ThreadHierarchyBar.tsx
//
// The strip above a thread that places it in Projects › Bots/Groups › Sessions:
//   - a breadcrumb back up the chain (project → bot or group → session), drawn
//     by ThreadHierarchyCrumbs: a long chain folds its middle into a menu, each
//     crumb shows its run status and opens the threads beside it;
//   - Sessions: the whole nest this thread sits in as an indented tree (the
//     root thread, the sessions it spawned, the sessions those spawned), so
//     delegated work stays one click away even though sessions are not sidebar
//     rows;
//   - Defaults: the model cascade for this thread, editable per scope;
//   - on a group's main thread, the group's coordination strategy.
// It renders nothing for a plain chat outside the hierarchy.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { COORDINATION_OPTIONS } from "@ryuhq/core-client/teams.ts";
import { useEffect, useMemo, useState } from "react";
import { PrimaryBotControl } from "@/src/components/chat/PrimaryBotControl.tsx";
import { ScopeDefaultsPanel } from "@/src/components/chat/ScopeDefaultsPanel.tsx";
import {
	ThreadHierarchyCrumbs,
	useNarrowElement,
} from "@/src/components/chat/ThreadHierarchyCrumbs.tsx";
import { ThreadTreeList } from "@/src/components/chat/ThreadTreeList.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchThreadSessions,
	fetchThreadTree,
	setThreadCoordination,
	type ThreadTree,
} from "@/src/lib/api/hierarchy.ts";
import {
	buildSubagentTree,
	treeFromSessions,
} from "@/src/lib/subagent-tree.ts";
import {
	COMPACT_CRUMB_LIMIT,
	CRUMB_LIMIT,
	hierarchyCrumbs,
	isGroupMainThread,
	isProjectMainThread,
} from "@/src/lib/thread-hierarchy.ts";
import type { Conversation } from "@/types/chat.ts";

/** Below this bar width only the parent and the current crumb stay visible. */
const NARROW_BAR_WIDTH = 520;

/**
 * The nest `conversation` sits in. A Core that predates the tree route (or
 * does not admit it yet) still lists the sessions the thread spawned, so the
 * answer falls back to that one level.
 */
async function loadThreadTree(
	target: ApiTarget,
	conversation: Conversation
): Promise<ThreadTree> {
	try {
		return await fetchThreadTree(target, conversation.id);
	} catch {
		const sessions = await fetchThreadSessions(target, conversation.id);
		const self = {
			agent_id: conversation.agentId ?? null,
			id: conversation.id,
			message_count: conversation.messages.length,
			run_status: conversation.runStatus ?? null,
			thread_role: conversation.hierarchy?.role,
			title: conversation.title,
			updated_at: conversation.updatedAt,
		};
		return { nodes: treeFromSessions(self, sessions), truncated: false };
	}
}

export function ThreadHierarchyBar({
	agentName,
	conversation,
	conversations,
	onOpenConversation,
	target,
}: {
	/** Resolve an agent id to its display name. */
	agentName: (id: string) => string | undefined;
	conversation: Conversation;
	conversations: readonly Conversation[];
	onOpenConversation: (conversationId: string, title?: string) => void;
	target: ApiTarget;
}) {
	const hierarchy = conversation.hierarchy;
	const tl = useLiteralMessages();
	const crumbs = useMemo(
		() => hierarchyCrumbs(conversation, conversations, agentName),
		[agentName, conversation, conversations]
	);
	const isMain = hierarchy?.role === "main";
	const isGroup = isGroupMainThread(conversation);
	const [barRef, narrow] = useNarrowElement(NARROW_BAR_WIDTH);
	const [tree, setTree] = useState<ThreadTree | null>(null);
	const [sessionsError, setSessionsError] = useState<string | null>(null);
	const treeRoots = useMemo(
		() => buildSubagentTree(tree?.nodes ?? [], agentName),
		[agentName, tree]
	);
	// Loaded, and it holds nothing but the thread itself.
	const treeIsEmpty = tree !== null && tree.nodes.length <= 1;
	const [coordination, setCoordination] = useState(
		hierarchy?.coordination ?? ""
	);

	useEffect(
		() => setCoordination(hierarchy?.coordination ?? ""),
		[hierarchy?.coordination]
	);

	const localSessionCount = useMemo(
		() =>
			conversations.filter(
				(item) => item.hierarchy?.spawnedByConversationId === conversation.id
			).length,
		[conversation.id, conversations]
	);

	const loadSessions = () => {
		loadThreadTree(target, conversation)
			.then((next) => {
				setTree(next);
				setSessionsError(null);
			})
			.catch((cause) =>
				setSessionsError(
					cause instanceof Error ? cause.message : "Couldn't load sessions."
				)
			);
	};

	// A session is part of a nest even when it spawned nothing itself.
	const inNest =
		localSessionCount > 0 || Boolean(hierarchy?.spawnedByConversationId);

	if (crumbs.length === 0 && !isMain && !inNest) {
		return null;
	}

	const projectId = hierarchy?.projectId;
	const projectMain = projectId
		? conversations.find(
				(item) =>
					isProjectMainThread(item) &&
					(item.hierarchy?.ownerId === projectId ||
						item.hierarchy?.projectId === projectId)
			)
		: undefined;
	const agentId =
		hierarchy?.ownerKind === "agent"
			? hierarchy.ownerId
			: (conversation.agentId ?? undefined);

	return (
		<div
			className="flex h-10 shrink-0 items-center justify-between gap-3 px-6"
			data-testid="thread-hierarchy-bar"
			ref={barRef}
		>
			<ThreadHierarchyCrumbs
				crumbs={crumbs}
				limit={narrow ? COMPACT_CRUMB_LIMIT : CRUMB_LIMIT}
				onOpenConversation={onOpenConversation}
			/>
			<div className="flex shrink-0 items-center gap-1">
				{isMain && hierarchy?.ownerKind === "agent" && !projectId && agentId ? (
					<PrimaryBotControl
						agentId={agentId}
						agentName={agentName(agentId) ?? agentId}
						target={target}
					/>
				) : null}
				{isGroup ? (
					<NativeSelect
						aria-label="Group coordination"
						onChange={(event) => {
							const next = event.target.value;
							setCoordination(next);
							void setThreadCoordination(
								target,
								conversation.id,
								next || null
							).catch(() => setCoordination(hierarchy?.coordination ?? ""));
						}}
						size="sm"
						value={coordination}
					>
						<NativeSelectOption value="">Council (default)</NativeSelectOption>
						{COORDINATION_OPTIONS.map((option) => (
							<NativeSelectOption key={option.value} value={option.value}>
								{option.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				) : null}
				{isMain || inNest ? (
					<Popover
						onOpenChange={(open) => {
							if (open) {
								loadSessions();
							}
						}}
					>
						<PopoverTrigger
							render={
								<Button
									data-testid="sessions-trigger"
									size="xs"
									variant="ghost"
								>
									{localSessionCount
										? tl("Sessions ({sessionCount})", {
												sessionCount: String(localSessionCount),
											})
										: "Sessions"}
								</Button>
							}
						/>
						<PopoverContent align="end" className="w-80">
							<div className="flex flex-col" data-testid="sessions-panel">
								<p className="flex h-7 items-center px-2 font-semibold text-sm">
									Sessions
								</p>
								{sessionsError ? (
									<p
										className="text-(length:--text-detail) px-2 text-status-destructive"
										role="alert"
									>
										{sessionsError}
									</p>
								) : null}
								{treeIsEmpty && !sessionsError ? (
									<p className="text-(length:--text-detail) px-2 text-muted-foreground">
										No sessions yet. Delegated work appears here.
									</p>
								) : null}
								{treeIsEmpty ? null : (
									<ThreadTreeList
										currentId={conversation.id}
										onOpenConversation={onOpenConversation}
										roots={treeRoots}
										truncated={tree?.truncated}
									/>
								)}
							</div>
						</PopoverContent>
					</Popover>
				) : null}
				<Popover>
					<PopoverTrigger
						render={
							<Button size="xs" variant="ghost">
								Defaults
							</Button>
						}
					/>
					<PopoverContent align="end">
						<ScopeDefaultsPanel
							agentId={isGroup ? undefined : agentId}
							agentName={agentId ? agentName(agentId) : undefined}
							isMainThread={isMain}
							projectId={projectId}
							projectName={projectMain?.title}
							target={target}
						/>
					</PopoverContent>
				</Popover>
			</div>
		</div>
	);
}
