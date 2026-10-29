import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type InterfaceSnapshot,
	THREAD_STATUS_LABELS,
} from "@ryuhq/protocol/interfaces";
import { Clock3 } from "lucide-react";
import type { ReactNode } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { agentById } from "./interface-renderer.ts";
import { PersonaAvatar } from "./persona-avatar.tsx";
import {
	type ActivityEntry,
	agoLabel,
	clockTime,
	fullTime,
	type PersonaActivity as PersonaActivityModel,
	untilLabel,
} from "./persona-model.ts";
import {
	EmptyNote,
	PageColumn,
	PageIntro,
	SectionLabel,
} from "./persona-parts.tsx";

const TIME_COLUMN = "w-16 shrink-0 text-muted-foreground text-xs tabular-nums";

function agentName(snapshot: InterfaceSnapshot, agentId: string | null) {
	return agentById(snapshot, agentId)?.name ?? "Unassigned";
}

/**
 * Every mark in the log sits in one fixed slot so titles line up whether the
 * row is a conversation (status dot) or a scheduled run (clock).
 */
function MarkSlot({ children }: { children: ReactNode }) {
	return (
		<span className="flex w-3.5 shrink-0 items-center justify-center">
			{children}
		</span>
	);
}

/**
 * A scheduled run, upcoming or past: the same clock in both groups, so runs
 * are told apart from conversations by shape. A failed run turns destructive.
 */
function RunMark({ failed = false }: { failed?: boolean }) {
	return (
		<MarkSlot>
			<Clock3
				aria-hidden="true"
				className={cn(
					"size-3.5",
					failed ? "text-destructive" : "text-muted-foreground"
				)}
			/>
		</MarkSlot>
	);
}

function LogRow({
	entry,
	onOpen,
	snapshot,
}: {
	entry: ActivityEntry;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const time = (
		<time
			className={TIME_COLUMN}
			dateTime={entry.at}
			title={fullTime(entry.at)}
		>
			{clockTime(entry.at)}
		</time>
	);
	if (entry.kind === "run") {
		const { event } = entry;
		const failed = event.outcome === "failure";
		return (
			<li className="flex h-9 items-center gap-3 text-sm">
				{time}
				<RunMark failed={failed} />
				<span className="min-w-0 flex-1 truncate">
					<span className="font-medium">{event.title}</span>
					<span className="text-muted-foreground">
						{" "}
						· {agentName(snapshot, event.agentId)}
						{event.label ? ` · ${event.label}` : ""}
					</span>
				</span>
				<span
					className={cn(
						"shrink-0 text-xs",
						failed ? "text-destructive" : "text-muted-foreground"
					)}
				>
					{failed ? "Run failed" : "Ran"}
				</span>
			</li>
		);
	}
	const { thread, status } = entry;
	const owner = thread.agentIds[0];
	return (
		<li>
			<button
				className="-mx-2 flex h-9 w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
				onClick={() => onOpen(thread.id)}
				type="button"
			>
				{time}
				<MarkSlot>
					<BoardStatusDot status={status} />
				</MarkSlot>
				<span className="min-w-0 flex-1 truncate">
					<span className="font-medium">{thread.title || "Untitled"}</span>
					<span className="text-muted-foreground">
						{" "}
						· {owner ? agentName(snapshot, owner) : "You"}
					</span>
				</span>
				<span
					className={cn(
						"shrink-0 text-xs",
						status === "attention"
							? "text-destructive"
							: "text-muted-foreground"
					)}
				>
					{THREAD_STATUS_LABELS[status]}
				</span>
			</button>
		</li>
	);
}

/**
 * Activity: what needs you first (failed or stopped runs), then upcoming
 * scheduled runs, then a timestamped log of conversation updates and past
 * runs.
 */
export function PersonaActivity({
	activity,
	onOpen,
	snapshot,
}: {
	activity: PersonaActivityModel;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const { log, stopped, upcoming } = activity;
	const tl = useLiteralMessages();
	return (
		<PageColumn>
			<PageIntro id="persona-activity-title" title="Activity" />
			<section aria-labelledby="persona-stopped">
				<SectionLabel count={stopped.length} id="persona-stopped">
					Needs attention
				</SectionLabel>
				{stopped.length === 0 ? (
					<EmptyNote>No stopped runs.</EmptyNote>
				) : (
					<ul className="flex flex-col divide-y divide-border">
						{stopped.map((thread) => {
							const owner = agentById(snapshot, thread.agentIds[0]);
							return (
								<li
									className="flex items-center gap-3 py-3 first:pt-1"
									key={thread.id}
								>
									<PersonaAvatar agent={owner} name="No agent" size={32} />
									<div className="flex min-w-0 flex-1 flex-col">
										<p className="truncate font-medium text-sm">
											{thread.title || "Untitled"}
										</p>
										<p className="truncate text-muted-foreground text-xs">
											<span className="text-destructive">Run stopped</span> ·{" "}
											{owner?.name ?? "No agent"} · {agoLabel(thread.updatedAt)}
										</p>
									</div>
									<Button
										aria-label={tl("Review {threadTitle}", {
											threadTitle: thread.title || "Untitled",
										})}
										onClick={() => onOpen(thread.id)}
										size="sm"
										type="button"
										variant="outline"
									>
										Review
									</Button>
								</li>
							);
						})}
					</ul>
				)}
			</section>
			{upcoming.length > 0 ? (
				<section aria-labelledby="persona-upcoming">
					<SectionLabel count={upcoming.length} id="persona-upcoming">
						Scheduled
					</SectionLabel>
					<ul className="flex flex-col">
						{upcoming.map((event) => (
							<li
								className="flex h-9 items-center gap-3 text-sm"
								key={event.id}
							>
								<time
									className={TIME_COLUMN}
									dateTime={event.start}
									title={fullTime(event.start)}
								>
									{untilLabel(event.start)}
								</time>
								<RunMark />
								<span className="min-w-0 flex-1 truncate">
									<span className="font-medium">{event.title}</span>
									<span className="text-muted-foreground">
										{" "}
										· {agentName(snapshot, event.agentId)}
									</span>
								</span>
								<span className="@max-[639px]:hidden shrink-0 text-muted-foreground text-xs">
									{event.count
										? tl("{count} runs · ", { count: String(event.count) })
										: ""}
									{event.label}
								</span>
							</li>
						))}
					</ul>
				</section>
			) : null}
			{log.length === 0 ? (
				<section aria-labelledby="persona-log-empty">
					<SectionLabel id="persona-log-empty">History</SectionLabel>
					<EmptyNote>No activity yet.</EmptyNote>
				</section>
			) : null}
			{log.map((day) => (
				<section aria-labelledby={`persona-log-${day.key}`} key={day.key}>
					<SectionLabel id={`persona-log-${day.key}`}>{day.label}</SectionLabel>
					<ul className="flex flex-col">
						{day.entries.map((entry) => (
							<LogRow
								entry={entry}
								key={entry.id}
								onOpen={onOpen}
								snapshot={snapshot}
							/>
						))}
					</ul>
				</section>
			))}
		</PageColumn>
	);
}
