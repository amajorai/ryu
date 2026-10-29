// apps/desktop/src/components/chat/ThreadHierarchyBar.tsx
//
// The strip above a thread that places it in Projects › Bots/Groups › Sessions:
//   - a breadcrumb back up the chain (project → bot or group → session);
//   - Sessions: every session this main thread spawned, newest first, so the
//     work it delegated stays one click away even though sessions are not
//     sidebar rows;
//   - Defaults: the model cascade for this thread, editable per scope;
//   - on a group's main thread, the group's coordination strategy.
// It renders nothing for a plain chat outside the hierarchy.

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@ryu/ui/components/breadcrumb.tsx";
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
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchThreadSessions,
	type SessionSummary,
	setThreadCoordination,
} from "@/src/lib/api/hierarchy.ts";
import {
	hierarchyCrumbs,
	isGroupMainThread,
	isProjectMainThread,
} from "@/src/lib/thread-hierarchy.ts";
import type { Conversation } from "@/types/chat.ts";

function sessionStatusLabel(status: string | null): string {
	switch (status) {
		case "running":
			return "Running";
		case "failed":
			return "Failed";
		case "interrupted":
			return "Interrupted";
		case "completed":
			return "Done";
		default:
			return "Idle";
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
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [sessionsError, setSessionsError] = useState<string | null>(null);
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
		fetchThreadSessions(target, conversation.id)
			.then((rows) => {
				setSessions(rows);
				setSessionsError(null);
			})
			.catch((cause) =>
				setSessionsError(
					cause instanceof Error ? cause.message : "Couldn't load sessions."
				)
			);
	};

	if (crumbs.length === 0 && !isMain && localSessionCount === 0) {
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
			className="flex shrink-0 items-center justify-between gap-3 border-border/40 border-b px-4 py-1.5"
			data-testid="thread-hierarchy-bar"
		>
			<Breadcrumb className="min-w-0">
				<BreadcrumbList className="flex-nowrap">
					{crumbs.map((crumb, index) => (
						<BreadcrumbItem
							className="min-w-0"
							key={`${crumb.kind}:${crumb.conversationId ?? "current"}`}
						>
							{index > 0 ? <BreadcrumbSeparator /> : null}
							{crumb.conversationId ? (
								<BreadcrumbLink
									render={
										<button
											onClick={() =>
												crumb.conversationId &&
												onOpenConversation(crumb.conversationId, crumb.label)
											}
											type="button"
										/>
									}
								>
									{crumb.label}
								</BreadcrumbLink>
							) : (
								<BreadcrumbPage>
									<span className="truncate">{crumb.label}</span>
								</BreadcrumbPage>
							)}
						</BreadcrumbItem>
					))}
				</BreadcrumbList>
			</Breadcrumb>
			<div className="flex shrink-0 items-center gap-1.5">
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
				{isMain || localSessionCount > 0 ? (
					<Popover
						onOpenChange={(open) => {
							if (open) {
								loadSessions();
							}
						}}
					>
						<PopoverTrigger
							render={
								<Button size="xs" variant="ghost">
									{localSessionCount
										? tl("Sessions ({sessionCount})", {
												sessionCount: String(localSessionCount),
											})
										: "Sessions"}
								</Button>
							}
						/>
						<PopoverContent align="end" className="w-80">
							<div className="flex flex-col gap-1" data-testid="sessions-panel">
								<p className="px-1 font-medium text-sm">Sessions</p>
								{sessionsError ? (
									<p className="px-1 text-destructive text-xs" role="alert">
										{sessionsError}
									</p>
								) : null}
								{sessions.length === 0 && !sessionsError ? (
									<p className="px-1 text-muted-foreground text-xs">
										No sessions yet. When this thread delegates work, each
										activity appears here.
									</p>
								) : null}
								{sessions.map((session) => (
									<button
										className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
										key={session.id}
										onClick={() =>
											onOpenConversation(session.id, session.title ?? undefined)
										}
										type="button"
									>
										<span
											className="truncate"
											title={session.title ?? "Session"}
										>
											{session.title ?? "Session"}
										</span>
										<span className="shrink-0 text-muted-foreground text-xs">
											{sessionStatusLabel(session.run_status)}
										</span>
									</button>
								))}
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
