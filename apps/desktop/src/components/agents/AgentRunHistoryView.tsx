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
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { ScrollArea } from "@ryu/ui/components/scroll-area";
import { cn } from "@ryu/ui/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { useCallback, useMemo } from "react";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { type RunSummary, useRuns } from "@/src/hooks/useRuns.ts";

/** Prefix Core uses for the ephemeral conversation id of a workflow node run. */
const WORKFLOW_RUN_PREFIX = "wfrun-";

/** A unified history entry, whether it originated as a chat or an automated run. */
interface HistoryEntry {
	/** True for automated/scheduled runs; false for interactive chats. */
	automated: boolean;
	id: string;
	/** Message count when known (only automated runs carry it in the stream). */
	messageCount?: number;
	/** "running" | "completed" | "failed" | undefined. */
	runStatus?: string;
	title: string;
	/** Unix ms of the last activity — used for ordering and the relative label. */
	updatedAt: number;
}

/** An automated run is one Core drove on its own: it either carries a run
 *  lifecycle status, or it is a workflow node's ephemeral conversation. */
function isAutomated(id: string, runStatus?: string): boolean {
	return Boolean(runStatus) || id.startsWith(WORKFLOW_RUN_PREFIX);
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
			});
		}

		for (const run of runs as RunSummary[]) {
			if (run.agent_id !== agentId) {
				continue;
			}
			const existing = byId.get(run.id);
			byId.set(run.id, {
				id: run.id,
				title: run.title ?? existing?.title ?? "Untitled run",
				updatedAt: run.updated_at || existing?.updatedAt || 0,
				runStatus: run.run_status ?? existing?.runStatus,
				messageCount: run.message_count,
				automated: true,
			});
		}

		return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
	}, [agentId, conversations, runs]);
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
				<span className="truncate font-medium text-sm">{entry.title}</span>
				<span className="text-muted-foreground text-xs">
					{relativeTime(entry.updatedAt)}
					{entry.messageCount == null
						? ""
						: ` · ${entry.messageCount} messages`}
				</span>
			</div>
			{status ? (
				<Badge variant={status.variant}>
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

export function AgentRunHistoryView({ agentId }: AgentRunHistoryViewProps) {
	const { refresh, setActiveConversationId } = useChatHistoryContext();
	const { openTab } = useTabsContext();
	const history = useAgentHistory(agentId);

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
