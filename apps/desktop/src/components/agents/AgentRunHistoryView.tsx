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

import { Refresh01Icon, Time04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useDisplayDayRevision } from "@ryu/ui/lib/display-day.ts";
import { useCallback, useMemo } from "react";
import {
	groupHistoryByDay,
	useAgentHistory,
} from "@/src/components/agents/AgentRunHistoryView-entries.ts";
import { AgentRunOverview } from "@/src/components/agents/AgentRunHistoryView-overview.tsx";
import {
	CompactHistoryRow,
	HistorySection,
} from "@/src/components/agents/AgentRunHistoryView-rows.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useSchedules } from "@/src/hooks/useSchedules.ts";

interface AgentRunHistoryViewProps {
	/** Agent whose runs are shown. `null` in create-mode (never rendered then). */
	agentId: string | null;
	/** Compact day-grouped feed for an agent profile side panel. */
	compact?: boolean;
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
