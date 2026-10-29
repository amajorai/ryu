// apps/desktop/src/components/agents/AgentRunHistoryView.tsx
//
// The agent-scoped run-history surface, rendered as the "History" tab of the
// agent edit page. It answers "trace back every run this agent did" — both the
// interactive chats a user had with the agent and the automated/scheduled runs
// it performed on its own (workflow `wfrun-*` runs + background worker runs).
//
// Every run persists as a conversation in Core (`GET /api/conversations`,
// surfaced app-wide by ChatHistoryContext), and automated runs additionally
// carry a live `run_status` streamed over `GET /api/runs/stream` (useRuns).
// This view merges both agent-filtered sources by conversation id and lets the
// user click any entry to open its full transcript — the chat history of that
// run — in a chat tab. Placement rationale: this only *reads* and *displays*
// run records (a Core observability concern); it enforces no policy.

import {
	AlertCircleIcon,
	ArrowRight01Icon,
	CheckmarkCircle02Icon,
	Loading03Icon,
	Message01Icon,
	Refresh01Icon,
	RoboticIcon,
	Time04Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import {
	RunStatusTimeline,
	RunStatusTimelineLegend,
} from "@ryu/ui/components/run-status-timeline.tsx";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useDisplayDayRevision } from "@ryu/ui/lib/display-day.ts";
import {
	formatDate,
	formatDateTime,
	formatTime,
	startOfDisplayDayMs,
} from "@ryu/ui/lib/timezone.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { formatDistanceToNow } from "date-fns";
import { useCallback, useMemo } from "react";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useRuns } from "@/src/hooks/useRuns.ts";
import { useSchedules } from "@/src/hooks/useSchedules.ts";
import type { ScheduledJob } from "@/src/lib/api/schedules.ts";
import {
	buildCalendarEvents,
	buildRunStatusTimelineEntries,
	describeSchedule,
	groupEventsByJob,
} from "@/src/lib/calendar/events.ts";
import { conversationRunStatusMeta } from "@/src/lib/conversation-run-status.ts";

/** Prefix Core uses for the ephemeral conversation id of a workflow node run. */
const WORKFLOW_RUN_PREFIX = "wfrun-";
/** Prefix Core uses for a new persistent conversation created by a routine. */
const AGENT_RUN_PREFIX = "agentrun_";

/** A unified history entry, whether it originated as a chat or an automated run. */
interface HistoryEntry {
	/** True for automated/scheduled runs; false for interactive chats. */
	automated: boolean;
	id: string;
	/** Message count when known (only automated runs carry it in the stream). */
	messageCount?: number;
	/** Latest assistant message preview, when Core returned one for the chat list. */
	preview?: string;
	/** Lifecycle status from Core, including awaiting_input and interrupted. */
	runStatus?: string;
	title: string;
	/** Unix ms of the last activity — used for ordering and the relative label. */
	updatedAt: number;
}

/** An automated run is one Core drove on its own: it either carries a run
 *  lifecycle status, or it is a workflow node's ephemeral conversation. */
function isAutomated(id: string, runStatus?: string): boolean {
	return (
		Boolean(runStatus) ||
		id.startsWith(WORKFLOW_RUN_PREFIX) ||
		id.startsWith(AGENT_RUN_PREFIX)
	);
}

function statusMeta(status: string | undefined): {
	icon: typeof CheckmarkCircle02Icon;
	label: string;
	variant: "default" | "secondary" | "destructive" | "outline";
	spin?: boolean;
} | null {
	switch (status) {
		case "running":
			return {
				icon: Loading03Icon,
				label: "Running",
				variant: "default",
				spin: true,
			};
		case "completed":
			return {
				icon: CheckmarkCircle02Icon,
				label: "Completed",
				variant: "secondary",
			};
		case "failed":
			return { icon: AlertCircleIcon, label: "Failed", variant: "destructive" };
		case "awaiting_input":
			return {
				icon: AlertCircleIcon,
				label: "Needs input",
				variant: "outline",
			};
		case "interrupted":
			return {
				icon: AlertCircleIcon,
				label: "Interrupted",
				variant: "outline",
			};
		default:
			return null;
	}
}

function relativeTime(ms: number): string {
	try {
		return formatDistanceToNow(new Date(ms), { addSuffix: true });
	} catch {
		return "";
	}
}

interface AgentRunHistoryViewProps {
	/** Agent whose runs are shown. `null` in create-mode (never rendered then). */
	agentId: string | null;
	/** Compact day-grouped feed for an agent profile side panel. */
	compact?: boolean;
}

/**
 * Merge the two agent-filtered run sources into one ordered, de-duplicated list.
 * Conversations (warm, app-level) are the base; the runs stream overlays live
 * `run_status` and can surface a freshly-started background run before the
 * conversation list has refreshed.
 */
function useAgentHistory(agentId: string | null): HistoryEntry[] {
	const { conversations } = useChatHistoryContext();
	const { runs } = useRuns();

	return useMemo(() => {
		if (!agentId) {
			return [];
		}
		const byId = new Map<string, HistoryEntry>();

		for (const conv of conversations) {
			if (conv.agentId !== agentId) {
				continue;
			}
			byId.set(conv.id, {
				id: conv.id,
				title: conv.title,
				updatedAt: conv.updatedAt,
				runStatus: conv.runStatus,
				automated: isAutomated(conv.id, conv.runStatus),
				preview:
					conv.lastMessageRole === "assistant" && conv.lastMessage
						? compactPreview(conv.lastMessage)
						: undefined,
			});
		}

		for (const run of runs) {
			if (run.agent_id !== agentId) {
				continue;
			}
			const existing = byId.get(run.id);
			byId.set(run.id, {
				id: run.id,
				title: run.title ?? existing?.title ?? "Untitled run",
				updatedAt: run.updated_at || existing?.updatedAt || 0,
				preview: existing?.preview,
				runStatus: run.run_status ?? existing?.runStatus,
				messageCount: run.message_count,
				automated: true,
			});
		}

		return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
	}, [agentId, conversations, runs]);
}

function compactPreview(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
}

function HistoryRow({
	entry,
	onOpen,
}: {
	entry: HistoryEntry;
	onOpen: (id: string) => void;
}) {
	const status = statusMeta(entry.runStatus);
	return (
		<button
			className={cn(
				"group flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors",
				"hover:border-border hover:bg-muted/50"
			)}
			onClick={() => onOpen(entry.id)}
			type="button"
		>
			<HugeiconsIcon
				className="size-4 shrink-0 text-muted-foreground"
				icon={entry.automated ? RoboticIcon : Message01Icon}
			/>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="truncate font-medium text-sm" title={entry.title}>
					{entry.title}
				</span>
				<span className="text-muted-foreground text-xs">
					{relativeTime(entry.updatedAt)}
					{entry.messageCount == null
						? ""
						: ` · ${entry.messageCount} messages`}
				</span>
			</div>
			{status ? (
				<Badge
					title={conversationRunStatusMeta(entry.runStatus)?.description}
					variant={status.variant}
				>
					<HugeiconsIcon
						className={cn("size-3", status.spin && "animate-spin")}
						icon={status.icon}
					/>
					{status.label}
				</Badge>
			) : null}
			<HugeiconsIcon
				className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
				icon={ArrowRight01Icon}
			/>
		</button>
	);
}

function HistorySection({
	title,
	entries,
	onOpen,
}: {
	title: string;
	entries: HistoryEntry[];
	onOpen: (id: string) => void;
}) {
	if (entries.length === 0) {
		return null;
	}
	return (
		<section className="flex flex-col gap-1">
			<h4 className="px-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{title} · {entries.length}
			</h4>
			{entries.map((entry) => (
				<HistoryRow entry={entry} key={entry.id} onOpen={onOpen} />
			))}
		</section>
	);
}

interface ActivityDay {
	entries: HistoryEntry[];
	key: string;
	label: string;
}

/**
 * Consecutive runs of entries sharing a civil day in the selected display
 * zone (not the machine zone), labelled relative to that zone's today.
 */
function groupHistoryByDay(
	entries: HistoryEntry[],
	now: number = Date.now()
): ActivityDay[] {
	const today = startOfDisplayDayMs(now);
	const yesterday = startOfDisplayDayMs(now, 1);
	const groups: ActivityDay[] = [];
	for (const entry of entries) {
		const dayStart = startOfDisplayDayMs(entry.updatedAt);
		const key = String(dayStart);
		// Only today's own civil day is "Today": a run stamped on a later day (a
		// node whose clock runs ahead) keeps its real date rather than joining it.
		const label =
			dayStart === today
				? "Today"
				: dayStart === yesterday
					? "Yesterday"
					: formatDate(entry.updatedAt, { month: "short", day: "numeric" });
		const current = groups.at(-1);
		if (current?.key === key) {
			current.entries.push(entry);
		} else {
			groups.push({ entries: [entry], key, label });
		}
	}
	return groups;
}

function CompactHistoryRow({
	entry,
	onOpen,
}: {
	entry: HistoryEntry;
	onOpen: (id: string) => void;
}) {
	const status = statusMeta(entry.runStatus);
	return (
		<button
			aria-label={`Open ${entry.title}`}
			className="group flex w-full items-start gap-3 border-b px-1 py-3 text-left last:border-b-0 hover:bg-muted/30"
			onClick={() => onOpen(entry.id)}
			type="button"
		>
			<span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
				<HugeiconsIcon
					className="size-4"
					icon={status?.icon ?? (entry.automated ? RoboticIcon : Message01Icon)}
				/>
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex items-center justify-between gap-2">
					<span className="truncate font-medium text-sm" title={entry.title}>
						{entry.title}
					</span>
					<span className="shrink-0 text-muted-foreground text-xs">
						{formatTime(entry.updatedAt, {
							hour: "numeric",
							minute: "2-digit",
						})}
					</span>
				</span>
				{entry.preview ? (
					<span className="mt-1 line-clamp-2 block text-muted-foreground text-xs">
						{entry.preview}
					</span>
				) : null}
				{status ? (
					<span className="type-caption mt-1 block text-muted-foreground">
						{status.label}
					</span>
				) : null}
			</span>
		</button>
	);
}

function AgentRunOverview({ jobs }: { jobs: ScheduledJob[] }) {
	const now = new Date();
	const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	const events = buildCalendarEvents(jobs, start, now);
	const eventsByJob = groupEventsByJob(events);
	const failed = events.filter(
		(event) => event.kind === "past" && event.outcome === "failure"
	).length;
	const completed = events.filter(
		(event) => event.kind === "past" && event.outcome === "success"
	).length;

	return (
		<section
			className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3.5"
			data-testid="agent-run-overview"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h3 className="font-medium text-sm">Run status · last 24 hours</h3>
					<p className="mt-1 text-muted-foreground text-xs">
						{completed} completed · {failed} failed · {jobs.length}{" "}
						{jobs.length === 1 ? "routine" : "routines"}
					</p>
				</div>
				<RunStatusTimelineLegend />
			</div>
			<RunStatusTimeline
				ariaLabel={`All ${jobs.length} agent routine statuses for the last 24 hours`}
				endAt={now.getTime()}
				entries={buildRunStatusTimelineEntries(start, now, events)}
				nowAt={now.getTime()}
				showScale
				startAt={start.getTime()}
			/>
			<div className="grid gap-2 border-t pt-3 sm:grid-cols-2">
				{jobs.map((job) => {
					const jobEvents = eventsByJob.get(job.id) ?? [];
					const last = [...job.history].sort(
						(a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)
					)[0];
					return (
						<div className="min-w-0" key={job.id}>
							<div className="flex items-center justify-between gap-2 text-xs">
								<span className="truncate font-medium" title={job.name}>
									{job.name}
								</span>
								<span className="shrink-0 text-muted-foreground">
									{job.enabled ? describeSchedule(job.schedule) : "Paused"}
								</span>
							</div>
							<RunStatusTimeline
								ariaLabel={`${job.name} status for the last 24 hours`}
								className="mt-1"
								endAt={now.getTime()}
								entries={buildRunStatusTimelineEntries(start, now, jobEvents)}
								startAt={start.getTime()}
							/>
							<p className="type-caption mt-1 truncate text-muted-foreground">
								{last
									? `${last.outcome === "success" ? "Succeeded" : "Failed"} ${formatDistanceToNow(new Date(last.startedAt), { addSuffix: true })}`
									: "No runs yet"}
							</p>
						</div>
					);
				})}
			</div>
			<p className="type-caption text-muted-foreground">
				Window ending{" "}
				{formatDateTime(now, {
					month: "short",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
					hourCycle: "h23",
				})}
				. Open an automated run below to inspect its full persistent transcript.
			</p>
		</section>
	);
}

export function AgentRunHistoryView({
	agentId,
	compact = false,
}: AgentRunHistoryViewProps) {
	const { conversationsLoading, refresh, setActiveConversationId } =
		useChatHistoryContext();
	const openTab = useTabSelector((state) => state.openTab);
	const history = useAgentHistory(agentId);
	const { jobs } = useSchedules();
	const routines = useMemo(
		() =>
			jobs.filter(
				(job) =>
					!job.system &&
					job.target.type === "agent" &&
					job.target.agentId === agentId
			),
		[agentId, jobs]
	);

	const openRun = useCallback(
		(id: string) => {
			// Mirror Layout's canonical select-conversation handler so ChatPage
			// resolves the transcript and the sidebar highlights the right row.
			setActiveConversationId(id);
			openTab("/chat", { conversationId: id });
		},
		[openTab, setActiveConversationId]
	);

	const chats = useMemo(() => history.filter((e) => !e.automated), [history]);
	const automated = useMemo(
		() => history.filter((e) => e.automated),
		[history]
	);
	// The day revision changes at each display-zone midnight and on zone
	// changes, so a mounted feed moves "Today" rows to "Yesterday" in place.
	const dayRevision = useDisplayDayRevision();
	const activityDays = useMemo(
		() => groupHistoryByDay(history),
		[history, dayRevision]
	);

	if (compact) {
		if (conversationsLoading && history.length === 0) {
			return <SkeletonRows inset="panel" label="Loading agent activity…" />;
		}
		return history.length === 0 ? (
			<Empty className="min-h-64">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Time04Icon} />
					</EmptyMedia>
					<EmptyTitle>No activity yet</EmptyTitle>
					<EmptyDescription>
						Chats and automated runs for this agent will appear here.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		) : (
			<div
				className="flex min-h-0 flex-col gap-5"
				data-testid="agent-activity-feed"
			>
				{activityDays.map((day) => (
					<section className="flex flex-col" key={day.key}>
						<h3 className="px-1 pb-1 font-medium text-muted-foreground text-xs">
							{day.label}
						</h3>
						{day.entries.map((entry) => (
							<CompactHistoryRow
								entry={entry}
								key={entry.id}
								onOpen={openRun}
							/>
						))}
					</section>
				))}
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between px-1">
				<div className="flex flex-col gap-0.5">
					<h3 className="font-medium text-sm">Run history</h3>
					<p className="text-muted-foreground text-xs">
						Every chat and automated run this agent has performed. Open any
						entry to trace its full transcript.
					</p>
				</div>
				<Button onClick={refresh} size="sm" variant="ghost">
					<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
					Refresh
				</Button>
			</div>

			{routines.length > 0 ? <AgentRunOverview jobs={routines} /> : null}

			{history.length === 0 ? (
				<Empty className="min-h-64">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={Time04Icon} />
						</EmptyMedia>
						<EmptyTitle>No runs yet</EmptyTitle>
						<EmptyDescription>
							Chat with this agent or schedule an automation, and every run will
							appear here so you can trace back its output.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button
							onClick={() =>
								openTab("/chat", {
									forceNew: true,
									initialAgent: agentId ?? undefined,
								})
							}
							size="sm"
						>
							Chat with this agent
						</Button>
					</EmptyContent>
				</Empty>
			) : (
				<ScrollArea className="max-h-[60vh]">
					<div className="flex flex-col gap-5 pr-2">
						<HistorySection
							entries={automated}
							onOpen={openRun}
							title="Automated runs"
						/>
						<HistorySection entries={chats} onOpen={openRun} title="Chats" />
					</div>
				</ScrollArea>
			)}
		</div>
	);
}
