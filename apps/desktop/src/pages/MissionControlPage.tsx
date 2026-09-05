// apps/desktop/src/pages/MissionControlPage.tsx
//
// Mission Control: the project-level view over many chats.
//
// The chat's own Mission Control dock panel answers "what did THIS chat do". This
// page answers what neither a transcript nor a single panel can — what has been
// happening across every chat, over days and weeks. Recent sessions and what each
// accomplished, per-day activity, the files several chats keep returning to, and
// the to-dos left outstanding in threads nobody reopened.
//
// A SHELL page owned by an APP: the component ships here, but the feature belongs
// to `@ryu/mission-control`, which declares where it lives via
// `contributes.sidebar_buttons[].target` and owns the store behind
// `/api/mission-control/*`. See `contributions/app-shell-routes.ts`.
//
// The page also drives indexing (`syncMissionIndex`), because the sidecar cannot
// read a conversation — see `lib/api/mission-control.ts` for why that is forced
// rather than chosen. Opening the page brings the index up to date; everything
// rendered below is then a stored fact.

import {
	Alert02Icon,
	CheckmarkCircle02Icon,
	File01Icon,
	Radar01Icon,
	RefreshIcon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	getMissionOverview,
	type MissionConversationDigest,
	type MissionDayBucket,
	type MissionHotFile,
	type MissionOpenItem,
	type MissionOverview,
	type MissionSyncResult,
	summarizeMissionConversation,
	syncMissionIndex,
} from "@/src/lib/api/mission-control.ts";
import { compactAge } from "@/src/lib/time.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

/** The window the page opens on, and what a cleared select falls back to. */
const DEFAULT_RANGE_DAYS = 7;

const RANGE_OPTIONS = [
	{ value: "3", label: "Last 3 days" },
	{ value: "7", label: "Last 7 days" },
	{ value: "30", label: "Last 30 days" },
	{ value: "0", label: "All time" },
];

/** Which chats the page counts. The default is THIS PROJECT: the page answers a
 *  question about a body of work, and a hot-file row reading "3 chats touched
 *  this path" means much less when those chats span unrelated repos. "Everywhere"
 *  stays one click away, and is the only option when no folder is open. */
type MissionScope = "everywhere" | "project";

/** The tallest bar in the activity strip, in pixels. */
const BAR_MAX_PX = 44;

function weekdayLabel(day: string): string {
	// `day` is "YYYY-MM-DD" in the node's local timezone; anchor at local
	// midnight so formatting cannot shift it into the previous day.
	const date = new Date(`${day}T00:00`);
	if (Number.isNaN(date.getTime())) {
		return day;
	}
	return date.toLocaleDateString(undefined, { weekday: "short" });
}

function Stat({
	hint,
	label,
	tone,
	value,
}: {
	hint?: string;
	label: string;
	tone?: "danger";
	value: number;
}) {
	return (
		<div className="rounded-lg border bg-card/40 px-3 py-2">
			<div
				className={cn(
					"font-medium text-xl tabular-nums",
					tone === "danger" && value > 0 && "text-destructive"
				)}
			>
				{formatCount(value)}
			</div>
			<div className="text-[11px] text-muted-foreground">{label}</div>
			{hint && (
				<div className="text-[10px] text-muted-foreground/70">{hint}</div>
			)}
		</div>
	);
}

/** Per-day activity. Bars are scaled to the busiest day in the window, so the
 *  strip reads as relative shape rather than an absolute count nobody can size. */
function ActivityStrip({ days }: { days: MissionDayBucket[] }) {
	const busiest = Math.max(1, ...days.map((d) => d.turns));
	if (days.length === 0) {
		return null;
	}
	return (
		<section>
			<h2 className="mb-2 font-medium text-sm">Activity</h2>
			<div className="flex items-end gap-1.5 overflow-x-auto rounded-lg border bg-card/40 p-3">
				{days.map((day) => (
					<Tooltip key={day.date}>
						<TooltipTrigger
							className="flex w-8 shrink-0 flex-col items-center gap-1"
							render={<div />}
						>
							<span
								className={cn(
									"w-full rounded-t bg-primary/70",
									day.failures > 0 && "bg-destructive/60"
								)}
								style={{
									height: `${Math.max(2, (day.turns / busiest) * BAR_MAX_PX)}px`,
								}}
							/>
							<span className="text-[10px] text-muted-foreground">
								{weekdayLabel(day.date)}
							</span>
						</TooltipTrigger>
						<TooltipContent className="text-xs">
							{day.date} · {formatCount(day.conversations)} chats,{" "}
							{formatCount(day.turns)} turns, {formatCount(day.writes)} files
							{day.failures > 0 ? `, ${formatCount(day.failures)} errors` : ""}
						</TooltipContent>
					</Tooltip>
				))}
			</div>
		</section>
	);
}

function OpenWorkSection({ items }: { items: MissionOpenItem[] }) {
	return (
		<section>
			<h2 className="mb-2 flex items-center gap-2 font-medium text-sm">
				Still to do
				<Badge variant="secondary">{formatCount(items.length) ?? "—"}</Badge>
			</h2>
			{items.length === 0 ? (
				<p className="rounded-lg border bg-card/40 p-3 text-muted-foreground text-xs">
					Nothing outstanding in this window — every plan these chats wrote was
					finished.
				</p>
			) : (
				<ul className="divide-y rounded-lg border bg-card/40">
					{items.map((item) => (
						<li
							className="flex items-start gap-2 px-3 py-2"
							key={`${item.conversation_id}-${item.content}`}
						>
							<span
								aria-hidden="true"
								className={cn(
									"mt-1.5 size-1.5 shrink-0 rounded-full",
									item.status === "in_progress" ? "bg-primary" : "bg-border"
								)}
							/>
							<div className="min-w-0 flex-1">
								<div className="text-sm">{item.content}</div>
								<div className="truncate text-[11px] text-muted-foreground">
									{item.conversation_title ?? "Untitled chat"} ·{" "}
									{compactAge(item.source_updated_at)}
								</div>
							</div>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function HotFilesSection({ files }: { files: MissionHotFile[] }) {
	if (files.length === 0) {
		return null;
	}
	return (
		<section>
			<h2 className="mb-2 font-medium text-sm">Files in play</h2>
			<ul className="divide-y rounded-lg border bg-card/40">
				{files.map((file) => (
					<li className="flex items-center gap-2 px-3 py-1.5" key={file.path}>
						<HugeiconsIcon
							className="size-3.5 shrink-0 text-muted-foreground"
							icon={File01Icon}
						/>
						<Tooltip>
							<TooltipTrigger
								render={
									<span className="min-w-0 flex-1 truncate text-xs">
										{file.path}
									</span>
								}
							/>
							<TooltipContent>{file.path}</TooltipContent>
						</Tooltip>
						<span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
							{file.conversations > 1
								? `${formatCount(file.conversations)} chats`
								: `${formatCount(file.touches)}×`}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}

function SessionRow({
	digest,
	onSummarize,
	summarizing,
}: {
	digest: MissionConversationDigest;
	onSummarize: (id: string) => void;
	summarizing: boolean;
}) {
	const failed = digest.totals.failures > 0;
	return (
		<li className="px-3 py-2.5">
			<div className="flex items-start gap-2">
				<HugeiconsIcon
					className={cn(
						"mt-0.5 size-4 shrink-0",
						failed ? "text-destructive" : "text-emerald-500"
					)}
					icon={failed ? Alert02Icon : CheckmarkCircle02Icon}
				/>
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						<span className="min-w-0 flex-1 truncate font-medium text-sm">
							{digest.title ?? "Untitled chat"}
						</span>
						<span className="shrink-0 text-[11px] text-muted-foreground">
							{compactAge(digest.source_updated_at)}
						</span>
					</div>
					<div className="text-[11px] text-muted-foreground">
						{digest.headline ?? "No work recorded"} ·{" "}
						{formatCount(digest.totals.turns)} turns ·{" "}
						{formatCount(digest.totals.writes)} files
						{digest.open_count > 0
							? ` · ${formatCount(digest.open_count)} open`
							: ""}
					</div>
					{digest.summary ? (
						<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
							{digest.summary}
						</p>
					) : (
						<Button
							className="mt-1 h-6 px-2 text-[11px]"
							loading={summarizing}
							onClick={() => onSummarize(digest.conversation_id)}
							size="sm"
							variant="ghost"
						>
							{!summarizing && (
								<HugeiconsIcon className="size-3" icon={SparklesIcon} />
							)}
							Summarise this session
						</Button>
					)}
				</div>
			</div>
		</li>
	);
}

function SessionsSection({
	conversations,
	onSummarize,
	summarizingId,
}: {
	conversations: MissionConversationDigest[];
	onSummarize: (id: string) => void;
	summarizingId: string | null;
}) {
	return (
		<section>
			<h2 className="mb-2 font-medium text-sm">Recent sessions</h2>
			{conversations.length === 0 ? (
				<p className="rounded-lg border bg-card/40 p-3 text-muted-foreground text-xs">
					No chats did any work in this window.
				</p>
			) : (
				<ul className="divide-y rounded-lg border bg-card/40">
					{conversations.map((digest) => (
						<SessionRow
							digest={digest}
							key={digest.conversation_id}
							onSummarize={onSummarize}
							summarizing={summarizingId === digest.conversation_id}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

function OverviewBody({
	overview,
	onSummarize,
	summarizingId,
}: {
	onSummarize: (id: string) => void;
	overview: MissionOverview;
	summarizingId: string | null;
}) {
	const t = overview.totals;
	return (
		<div className="space-y-5">
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
				<Stat label="Sessions" value={t.conversations} />
				<Stat label="Turns" value={t.turns} />
				<Stat label="Files changed" value={t.writes} />
				<Stat label="Commands" value={t.commands} />
				<Stat label="Open items" value={t.open_items} />
				<Stat label="Errors" tone="danger" value={t.failures} />
			</div>
			<ActivityStrip days={overview.days} />
			<OpenWorkSection items={overview.open_items} />
			<SessionsSection
				conversations={overview.conversations}
				onSummarize={onSummarize}
				summarizingId={summarizingId}
			/>
			<HotFilesSection files={overview.files} />
		</div>
	);
}

/** What the last index pass did. Shown only when it left something behind, so a
 *  capped first run reads as "still filling in" rather than as the whole truth. */
function SyncNotice({ sync }: { sync: MissionSyncResult | undefined }) {
	if (!sync || sync.deferred === 0) {
		return null;
	}
	return (
		<p className="rounded-lg border border-dashed px-3 py-2 text-muted-foreground text-xs">
			Indexed {sync.indexed} chats this pass; {sync.deferred} older ones are
			still queued. Refresh to keep filling in.
		</p>
	);
}

export default function MissionControlPage() {
	const [days, setDays] = useState(DEFAULT_RANGE_DAYS);
	const [scope, setScope] = useState<MissionScope>("project");
	const folder = useWorkspaceStore((s) => s.folder);
	// No folder open means there is no project to scope TO, so the choice
	// collapses rather than silently filtering everything out.
	const folderPath = scope === "project" ? folder : null;
	const projectLabel = useMemo(
		() => folder?.split("/").filter(Boolean).at(-1) ?? "This project",
		[folder]
	);
	// Derived, not a module constant: Base UI resolves the TRIGGER's text from
	// `items`, so a static label would read "This project" on the trigger while the
	// dropdown row read the folder name.
	const scopeOptions = useMemo(
		() => [
			{ value: "project", label: projectLabel },
			{ value: "everywhere", label: "All projects" },
		],
		[projectLabel]
	);
	const [summarizingId, setSummarizingId] = useState<string | null>(null);
	const activeNode = useActiveNode();
	const target: ApiTarget = useMemo(() => toTarget(activeNode), [activeNode]);
	const queryClient = useQueryClient();

	// Indexing runs first and the overview depends on it, so opening the page
	// cannot show a stale window: the sync's result is part of the query key.
	const sync = useQuery({
		queryKey: ["mission-control-sync", target.url],
		queryFn: ({ signal }) => syncMissionIndex(target, signal),
		refetchOnWindowFocus: false,
	});

	const overview = useQuery({
		queryKey: [
			"mission-control-overview",
			target.url,
			days,
			folderPath,
			// Both stamps: `dataUpdatedAt` alone never moves on a FAILED refetch, so
			// clicking Refresh after a transient error would look like nothing happened.
			sync.dataUpdatedAt,
			sync.errorUpdatedAt,
		],
		queryFn: ({ signal }) =>
			getMissionOverview(
				target,
				{ days: days || undefined, folderPath },
				signal
			),
		enabled: sync.isSuccess || sync.isError,
	});

	const summarize = useMutation({
		mutationFn: (id: string) => summarizeMissionConversation(target, id),
		onMutate: (id: string) => setSummarizingId(id),
		onSettled: () => {
			setSummarizingId(null);
			queryClient.invalidateQueries({ queryKey: ["mission-control-overview"] });
		},
	});

	const refresh = () => {
		sync.refetch();
	};

	const loading = sync.isLoading || overview.isLoading;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
				<div className="flex items-center gap-2">
					<HugeiconsIcon className="size-5" icon={Radar01Icon} />
					<div>
						<h1 className="font-medium text-base">Mission Control</h1>
						<p className="text-muted-foreground text-xs">
							{folderPath
								? `What every chat in ${projectLabel} did, and what is still open.`
								: "What every chat did, and what is still open."}
						</p>
					</div>
				</div>
				<div className="flex items-center gap-2">
					{folder && (
						<Select
							items={scopeOptions}
							onValueChange={(value: string | null) =>
								setScope(value === "everywhere" ? "everywhere" : "project")
							}
							value={scope}
						>
							<SelectTrigger className="w-[160px]" size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{scopeOptions.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
					<Select
						items={RANGE_OPTIONS}
						onValueChange={(value: string | null) => {
							setDays(Number(value ?? DEFAULT_RANGE_DAYS));
						}}
						value={String(days)}
					>
						<SelectTrigger className="w-[150px]" size="sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{RANGE_OPTIONS.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button
						loading={sync.isFetching}
						onClick={refresh}
						size="sm"
						variant="ghost"
					>
						{!sync.isFetching && (
							<HugeiconsIcon className="size-3.5" icon={RefreshIcon} />
						)}
						Refresh
					</Button>
				</div>
			</header>

			<div className="scroll-fade min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
				{loading && (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Spinner className="size-4" /> Reading your chats…
					</div>
				)}
				{overview.isError && (
					<p className="rounded-lg border border-destructive/40 p-3 text-destructive text-xs">
						Mission Control's sidecar did not answer. Check the app is enabled
						in the Store.
					</p>
				)}
				{summarize.isError && (
					<p className="rounded-lg border border-destructive/40 p-3 text-destructive text-xs">
						That summary needs a model this node can reach — the dashboard's own
						numbers are unaffected.
					</p>
				)}
				<SyncNotice sync={sync.data} />
				{overview.data && (
					<OverviewBody
						onSummarize={(id) => summarize.mutate(id)}
						overview={overview.data}
						summarizingId={summarizingId}
					/>
				)}
			</div>
		</div>
	);
}
