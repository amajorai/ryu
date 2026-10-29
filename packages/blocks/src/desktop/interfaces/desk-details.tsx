import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ChevronRight, FolderKanban, UsersRound, X } from "lucide-react";
import type { ReactNode } from "react";
import { DeskAvatar } from "./desk-avatar.tsx";
import { DESK_FOCUS_RING } from "./desk-list.tsx";
import {
	type DeskRow,
	deskFullTimestamp,
	deskRelatedThreads,
	deskStatusExplanation,
	deskThreadTitle,
} from "./desk-model.ts";
import { DeskStatusIcon } from "./desk-status.tsx";
import { compactAge } from "./interface-renderer.ts";

function DetailsSection({
	children,
	id,
	title,
}: {
	children: ReactNode;
	id: string;
	title: string;
}) {
	return (
		<section
			aria-labelledby={id}
			className="flex flex-col gap-2 border-border border-b p-4 last:border-b-0"
		>
			<h3 className="font-medium text-muted-foreground text-xs" id={id}>
				{title}
			</h3>
			{children}
		</section>
	);
}

const LINK_ROW_CLASS = `group/link flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted ${DESK_FOCUS_RING}`;

/**
 * The collapsible details sidebar for the open conversation: status and why,
 * the agents on it, counts and timestamps, where it is filed, and the same
 * agents' other recent conversations.
 */
export function DeskDetails({
	className,
	floating = false,
	now,
	onClose,
	onOpenThread,
	onSelectView,
	row,
	snapshot,
}: {
	className?: string;
	/** Floating over the chat below its header: a slimmer header of its own. */
	floating?: boolean;
	now: number;
	onClose: () => void;
	onOpenThread: (threadId: string) => void;
	onSelectView: (viewId: string) => void;
	row: DeskRow;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const { thread } = row;
	const related = deskRelatedThreads(snapshot, row);
	const relatedTitle =
		row.agents.length === 1 && row.lead
			? tl("More with {name}", { name: row.lead.name })
			: "More with these agents";
	const age = compactAge(thread.updatedAt, now);
	let lastActivity = age ? `${age} ago` : deskFullTimestamp(thread.updatedAt);
	if (age === "now") {
		lastActivity = "Just now";
	}
	const team = thread.teamId
		? snapshot.groups.find((group) => group.id === thread.teamId)
		: undefined;
	const project = thread.projectId
		? snapshot.groups.find((group) => group.id === thread.projectId)
		: undefined;

	return (
		<aside
			aria-label="Conversation details"
			className={cn(
				"flex w-[300px] shrink-0 flex-col border-border border-l bg-background outline-none",
				className
			)}
			data-testid="desk-details"
			id="desk-details"
			tabIndex={-1}
		>
			<header
				className={cn(
					"flex shrink-0 items-center gap-2 border-border border-b pr-2 pl-4",
					floating ? "h-11" : "h-14"
				)}
			>
				<h2 className="min-w-0 flex-1 truncate text-foreground text-sm">
					<span className="font-semibold">Details</span>
				</h2>
				<Button
					aria-label="Hide details"
					data-testid="desk-details-close"
					onClick={onClose}
					size="icon-sm"
					variant="ghost-muted"
				>
					<X aria-hidden="true" />
				</Button>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
				{/* The header pill already names the status; only a failed or
				    interrupted run needs words on what happened and what to do. */}
				{row.status === "attention" ? (
					<DetailsSection id="desk-details-status" title="Status">
						<p className="flex items-center gap-2 font-medium text-foreground text-sm">
							<DeskStatusIcon status={row.status} />
							{THREAD_STATUS_LABELS[row.status]}
						</p>
						<p className="text-pretty text-muted-foreground text-sm">
							{deskStatusExplanation(row)}
						</p>
					</DetailsSection>
				) : null}
				<DetailsSection
					id="desk-details-agents"
					title={row.agents.length === 1 ? "Agent" : "Agents"}
				>
					{row.agents.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							No agent is on this conversation.
						</p>
					) : (
						<ul className="-mx-2 flex flex-col">
							{row.agents.map((agent) => (
								<li key={agent.id}>
									<button
										aria-label={tl("Open {name}'s inbox", { name: agent.name })}
										className={cn(LINK_ROW_CLASS, "items-start gap-3")}
										onClick={() => onSelectView(`agent:${agent.id}`)}
										type="button"
									>
										<DeskAvatar agent={agent} presence size={32} />
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="truncate font-medium text-foreground">
												{agent.name}
											</span>
											{agent.description ? (
												<span className="line-clamp-2 text-pretty text-muted-foreground text-xs">
													{agent.description}
												</span>
											) : null}
										</span>
										<ChevronRight
											aria-hidden="true"
											className="mt-1 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/link:opacity-100 group-focus-visible/link:opacity-100"
										/>
									</button>
								</li>
							))}
						</ul>
					)}
				</DetailsSection>
				<DetailsSection id="desk-details-conversation" title="Conversation">
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
						<dt className="text-muted-foreground">Messages</dt>
						<dd className="text-right text-foreground tabular-nums">
							{thread.messageCount}
						</dd>
						<dt className="text-muted-foreground">Last activity</dt>
						<dd className="text-right text-foreground">
							<time
								dateTime={thread.updatedAt}
								title={deskFullTimestamp(thread.updatedAt)}
							>
								{lastActivity}
							</time>
						</dd>
					</dl>
				</DetailsSection>
				{team || project ? (
					<DetailsSection id="desk-details-filed" title="Filed under">
						<ul className="-mx-2 flex flex-col">
							{[team, project].map((group) =>
								group ? (
									<li key={group.id}>
										<button
											aria-label={tl(
												"{kind, select, team {Show team {name}} project {Show project {name}} other {Show {kind} {name}}}",
												{ kind: group.kind, name: group.name }
											)}
											className={LINK_ROW_CLASS}
											onClick={() => onSelectView(`${group.kind}:${group.id}`)}
											type="button"
										>
											{group.kind === "team" ? (
												<UsersRound
													aria-hidden="true"
													className="size-4 shrink-0 text-muted-foreground"
												/>
											) : (
												<FolderKanban
													aria-hidden="true"
													className="size-4 shrink-0 text-muted-foreground"
												/>
											)}
											<span className="min-w-0 flex-1 truncate text-foreground">
												{group.name}
											</span>
										</button>
									</li>
								) : null
							)}
						</ul>
					</DetailsSection>
				) : null}
				{related.length > 0 ? (
					<DetailsSection id="desk-details-related" title={relatedTitle}>
						<ul className="-mx-2 flex flex-col">
							{related.map((other) => {
								const status = threadStatus(other);
								const otherTitle = deskThreadTitle(other);
								const otherAge = compactAge(other.updatedAt, now);
								return (
									<li key={other.id}>
										<button
											aria-label={tl("Open {title}, {status}", {
												status: THREAD_STATUS_LABELS[status],
												title: otherTitle,
											})}
											className={LINK_ROW_CLASS}
											data-testid={`desk-related-${other.id}`}
											onClick={() => onOpenThread(other.id)}
											type="button"
										>
											<DeskStatusIcon status={status} />
											<span className="min-w-0 flex-1 truncate text-foreground">
												{otherTitle}
											</span>
											<time
												className="shrink-0 text-muted-foreground text-xs tabular-nums"
												dateTime={other.updatedAt}
											>
												{otherAge}
											</time>
										</button>
									</li>
								);
							})}
						</ul>
					</DetailsSection>
				) : null}
			</div>
		</aside>
	);
}
