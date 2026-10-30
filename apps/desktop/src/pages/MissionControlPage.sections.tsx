import {
	Alert02Icon,
	CheckmarkCircle02Icon,
	File01Icon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties } from "react";
import type {
	MissionConversationDigest,
	MissionDayBucket,
	MissionHotFile,
	MissionOpenItem,
	MissionOverview,
	MissionSyncResult,
} from "@/src/lib/api/mission-control.ts";
import { compactAge } from "@/src/lib/time.ts";
import { formatDate } from "@/src/lib/timezone.ts";
import styles from "./MissionControlPage.module.css";

/** The window the page opens on, and what a cleared select falls back to. */
export const DEFAULT_RANGE_DAYS = 7;

export const RANGE_OPTIONS = [
	{ value: "3", label: "Last 3 days" },
	{ value: "7", label: "Last 7 days" },
	{ value: "30", label: "Last 30 days" },
	{ value: "0", label: "All time" },
];

/** Which chats the page counts. The default is THIS PROJECT: the page answers a
 *  question about a body of work, and a hot-file row reading "3 chats touched
 *  this path" means much less when those chats span unrelated repos. "Everywhere"
 *  stays one click away, and is the only option when no folder is open. */
export type MissionScope = "everywhere" | "project";

/** The tallest bar in the activity strip, in pixels. */
export const BAR_MAX_PX = 44;

export function weekdayLabel(day: string): string {
	// `day` is "YYYY-MM-DD" in the node's local timezone; anchor at local
	// midnight so formatting cannot shift it into the previous day.
	const date = new Date(`${day}T00:00`);
	if (Number.isNaN(date.getTime())) {
		return day;
	}
	return formatDate(day, { weekday: "short" });
}

export function Stat({
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
		<div className="flex flex-col-reverse">
			<div
				className={cn(
					"font-medium text-xl tabular-nums",
					tone === "danger" && value > 0 && "text-status-destructive"
				)}
			>
				{formatCount(value)}
			</div>
			<div className="text-detail text-muted-foreground">
				{label}
				{hint ? (
					<span className="text-muted-foreground/70"> · {hint}</span>
				) : null}
			</div>
		</div>
	);
}

/** Per-day activity. Bars are scaled to the busiest day in the window, so the
 *  strip reads as relative shape rather than an absolute count nobody can size. */
export function ActivityStrip({ days }: { days: MissionDayBucket[] }) {
	const tl = useLiteralMessages();
	const busiest = Math.max(1, ...days.map((d) => d.turns));
	if (days.length === 0) {
		return null;
	}
	return (
		<section>
			<h2 className="mb-1 font-semibold text-sm">Activity</h2>
			<div className="flex items-end gap-1.5 overflow-x-auto py-2">
				{days.map((day) => {
					const activityStyle: CSSProperties & {
						"--mission-bar-height": string;
					} = {
						"--mission-bar-height": `${Math.max(2, (day.turns / busiest) * BAR_MAX_PX)}px`,
					};
					return (
						<Tooltip key={day.date}>
							<TooltipTrigger
								render={
									<div className="flex w-8 shrink-0 flex-col items-center gap-1" />
								}
							>
								<span
									className={cn(
										"w-full rounded-t bg-primary/70",
										styles.bar,
										day.failures > 0 && "bg-destructive/60"
									)}
									style={activityStyle}
								/>
								<span className="text-muted-foreground text-xs">
									{weekdayLabel(day.date)}
								</span>
							</TooltipTrigger>
							<TooltipContent>
								{day.failures > 0
									? tl(
											"{date} · {chats} chats, {turns} turns, {files} files, {errors} errors",
											{
												date: day.date,
												chats: formatCount(day.conversations),
												turns: formatCount(day.turns),
												files: formatCount(day.writes),
												errors: formatCount(day.failures),
											}
										)
									: tl("{date} · {chats} chats, {turns} turns, {files} files", {
											date: day.date,
											chats: formatCount(day.conversations),
											turns: formatCount(day.turns),
											files: formatCount(day.writes),
										})}
							</TooltipContent>
						</Tooltip>
					);
				})}
			</div>
		</section>
	);
}

export function OpenWorkSection({ items }: { items: MissionOpenItem[] }) {
	return (
		<section>
			<h2 className="mb-1 flex items-center gap-2 font-semibold text-sm">
				Still to do
				<Badge variant="secondary">{formatCount(items.length) ?? "—"}</Badge>
			</h2>
			{items.length === 0 ? (
				<p className="text-detail text-muted-foreground">
					Nothing outstanding in this window — every plan these chats wrote was
					finished.
				</p>
			) : (
				<ul className="divide-y divide-border">
					{items.map((item) => (
						<li
							className="flex items-start gap-2 py-2"
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
								<div className="truncate text-muted-foreground text-xs">
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

export function HotFilesSection({ files }: { files: MissionHotFile[] }) {
	const tl = useLiteralMessages();
	if (files.length === 0) {
		return null;
	}
	return (
		<section>
			<h2 className="mb-1 font-semibold text-sm">Files in play</h2>
			<ul className="divide-y divide-border">
				{files.map((file) => (
					<li className="flex h-10 items-center gap-2" key={file.path}>
						<HugeiconsIcon
							className="size-3.5 shrink-0 text-muted-foreground"
							icon={File01Icon}
						/>
						<Tooltip>
							<TooltipTrigger
								render={
									<span className="min-w-0 flex-1 truncate text-sm">
										{file.path}
									</span>
								}
							/>
							<TooltipContent>{file.path}</TooltipContent>
						</Tooltip>
						<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
							{file.conversations > 1
								? tl("{count} chats", {
										count: formatCount(file.conversations),
									})
								: `${formatCount(file.touches)}×`}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}

export function SessionRow({
	digest,
	onSummarize,
	summarizing,
}: {
	digest: MissionConversationDigest;
	onSummarize: (id: string) => void;
	summarizing: boolean;
}) {
	const tl = useLiteralMessages();
	const failed = digest.totals.failures > 0;
	return (
		<li className="py-3">
			<div className="flex items-start gap-2">
				<HugeiconsIcon
					className={cn(
						"mt-0.5 size-4 shrink-0",
						failed ? "text-status-destructive" : "text-status-success"
					)}
					icon={failed ? Alert02Icon : CheckmarkCircle02Icon}
				/>
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						<span className="min-w-0 flex-1 truncate font-medium text-sm">
							{digest.title ?? "Untitled chat"}
						</span>
						<span className="shrink-0 text-muted-foreground text-xs">
							{compactAge(digest.source_updated_at)}
						</span>
					</div>
					<div className="text-muted-foreground text-xs">
						{digest.open_count > 0
							? tl("{headline} · {turns} turns · {files} files · {open} open", {
									headline: digest.headline ?? "No work recorded",
									turns: formatCount(digest.totals.turns),
									files: formatCount(digest.totals.writes),
									open: formatCount(digest.open_count),
								})
							: tl("{headline} · {turns} turns · {files} files", {
									headline: digest.headline ?? "No work recorded",
									turns: formatCount(digest.totals.turns),
									files: formatCount(digest.totals.writes),
								})}
					</div>
					{digest.summary ? (
						<p className="mt-1 text-pretty text-detail text-muted-foreground">
							{digest.summary}
						</p>
					) : (
						<Button
							className="mt-1"
							loading={summarizing}
							onClick={() => onSummarize(digest.conversation_id)}
							size="tiny"
							typography="caption"
							variant="ghost"
						>
							{!summarizing && (
								<HugeiconsIcon className="size-3" icon={SparklesIcon} />
							)}
							{tl("Summarise this session")}
						</Button>
					)}
				</div>
			</div>
		</li>
	);
}

export function SessionsSection({
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
			<h2 className="mb-1 font-semibold text-sm">Recent sessions</h2>
			{conversations.length === 0 ? (
				<p className="text-detail text-muted-foreground">
					No chats did any work in this window.
				</p>
			) : (
				<ul className="divide-y divide-border">
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

export function OverviewBody({
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
		<div className="flex flex-col gap-8">
			<div className="grid grid-cols-3 gap-x-6 gap-y-4 lg:grid-cols-6">
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
export function SyncNotice({ sync }: { sync: MissionSyncResult | undefined }) {
	const tl = useLiteralMessages();
	if (!sync || sync.deferred === 0) {
		return null;
	}
	return (
		<p className="text-detail text-muted-foreground">
			{tl(
				"Indexed {indexed} chats this pass; {deferred} older ones are still queued. Refresh to keep filling in.",
				{ indexed: String(sync.indexed), deferred: String(sync.deferred) }
			)}
		</p>
	);
}
