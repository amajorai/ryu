import type { CSSProperties } from "react";
import styles from "./ReviewPage.module.css";
// apps/desktop/src/pages/ReviewPage.tsx
//
// Weekly Review: a Dayflow-inspired retrospective over Shadow's on-device
// activity. Folds the trailing N days into a focus-vs-distraction headline,
// per-day rollups, time allocation by category/app, and week highlights.
// Everything is derived locally from Shadow (:3030); when Shadow is unreachable
// the page shows an empty state.
//
// Questions about the week go to the global Ask Ryu assistant, not a chat pane
// of this page: the rollup is published as page context and the review lends the
// assistant a surface (starter prompts + `shadow.*` tools) while it is focused.

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { FocusSummary } from "@/src/components/review/FocusSummary.tsx";
import {
	WEEKLY_REVIEW_PREAMBLE,
	WEEKLY_REVIEW_PROMPTS,
	WEEKLY_REVIEW_TOOLS,
	weeklyReviewSnapshot,
} from "@/src/components/review/weekly-review-context.ts";
import { useAssistantSurface } from "@/src/hooks/useAssistantBuilder.ts";
import { useAssistantPageContext } from "@/src/hooks/useAssistantPageContext.ts";
import type {
	DailyRollup,
	JournalStat,
	WeeklyReview,
} from "@/src/lib/api/shadow.ts";
import {
	REVIEW_DEFAULT_DAYS,
	weeklyReviewQuery,
} from "@/src/lib/route-queries.ts";
import { formatDate } from "@/src/lib/timezone.ts";

const RANGE_OPTIONS = [
	{ value: "7", label: "Last 7 days" },
	{ value: "14", label: "Last 14 days" },
	{ value: "30", label: "Last 30 days" },
];

function weekdayLabel(day: string): string {
	// `day` is "YYYY-MM-DD" from Shadow; anchor at local midnight to format.
	const date = new Date(`${day}T00:00`);
	if (Number.isNaN(date.getTime())) {
		return day;
	}
	return formatDate(day, { weekday: "short" });
}

export default function ReviewPage() {
	const tl = useLiteralMessages();
	const [days, setDays] = useState(REVIEW_DEFAULT_DAYS);
	const query = useQuery({
		...weeklyReviewQuery(days),
		refetchInterval: 60_000,
	});
	const review = query.data;
	const snapshot = useMemo(
		() => (review ? weeklyReviewSnapshot(review, days) : ""),
		[review, days]
	);

	useAssistantPageContext(
		review
			? {
					id: `weekly-review:${days}`,
					title: tl("Weekly review · last {days} days", { days: String(days) }),
					text: snapshot,
				}
			: null
	);
	// A silent surface (`dock: false`): looking at the review is not a request
	// to open the assistant, but opening it here starts from the review's prompts.
	useAssistantSurface({
		kind: "weekly-review",
		dock: false,
		label: "Ask about your week",
		description:
			"Ask about your focus, time, and highlights. Ryu can search your on-device timeline for details.",
		preamble: WEEKLY_REVIEW_PREAMBLE,
		prompts: WEEKLY_REVIEW_PROMPTS,
		tools: WEEKLY_REVIEW_TOOLS,
		// The rollup travels only as the removable page context above, so removing
		// that chip really keeps it out of the turn.
		snapshot: "",
		targetId: "weekly-review",
		targetName: "Weekly review",
		resolveId: () => Promise.resolve("weekly-review"),
		onChanged: () => undefined,
	});

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
				<div>
					<h1 className="font-medium text-base">Weekly review</h1>
					<p className="text-muted-foreground text-xs">
						Your focus, time, and highlights — derived on-device.
					</p>
				</div>
				<Select
					items={RANGE_OPTIONS}
					onValueChange={(value) => {
						if (value !== null) {
							setDays(Number(value));
						}
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
			</header>

			<div className="scroll-fade min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
				{query.isLoading && (
					<SkeletonRows label="Loading your week…" spacing="comfortable" />
				)}
				{!(query.isLoading || review) && <ReviewEmptyState />}
				{review && <ReviewBody review={review} />}
			</div>
		</div>
	);
}

function ReviewEmptyState() {
	return (
		<div className="rounded-lg border border-dashed p-6 text-center">
			<p className="font-medium text-sm">No activity yet</p>
			<p className="mt-1 text-muted-foreground text-xs">
				Shadow needs to be running and capturing to build your weekly review.
			</p>
		</div>
	);
}

function ReviewBody(props: { review: WeeklyReview }) {
	const { review } = props;
	const hasActivity = review.focus.total_minutes > 0;

	if (!hasActivity) {
		return <ReviewEmptyState />;
	}

	return (
		<div className="space-y-4">
			<FocusSummary focus={review.focus} title="Focus this period" />
			<DailyBars days={review.days} />
			<div className="grid gap-3 sm:grid-cols-2">
				<AllocationList stats={review.categories} title="Time by category" />
				<AllocationList stats={review.apps} title="Time by app" />
			</div>
			<Highlights items={review.highlights} />
		</div>
	);
}

/** Per-day focus/distraction stacked columns. */
function DailyBars(props: { days: DailyRollup[] }) {
	const { days } = props;
	const tl = useLiteralMessages();
	if (days.length === 0) {
		return null;
	}
	const maxMinutes = Math.max(
		1,
		...days.map((d) => d.focus_minutes + d.distraction_minutes)
	);

	return (
		<div className="rounded-lg bg-muted/30 p-3">
			<div className="mb-3 font-medium text-xs">Daily focus</div>
			<div className="flex items-end justify-between gap-2">
				{days.map((day) => {
					const totalMin = day.focus_minutes + day.distraction_minutes;
					const heightPct = (totalMin / maxMinutes) * 100;
					const focusShare =
						totalMin === 0 ? 0 : (day.focus_minutes / totalMin) * 100;
					const totalStyle: CSSProperties & { "--review-height": string } = {
						"--review-height": `${Math.max(heightPct, 3)}%`,
					};
					const focusStyle: CSSProperties & { "--review-height": string } = {
						"--review-height": `${focusShare}%`,
					};
					const distractionStyle: CSSProperties & {
						"--review-height": string;
					} = {
						"--review-height": `${100 - focusShare}%`,
					};
					return (
						<div
							className="flex min-w-0 flex-1 flex-col items-center gap-1"
							key={day.day}
							title={tl(
								"{day}: {focusPercent}% focus, {totalMinutes}m tracked",
								{
									day: day.day,
									focusPercent: String(Math.round(day.focus_ratio * 100)),
									totalMinutes: String(totalMin),
								}
							)}
						>
							<div className="flex h-24 w-full items-end justify-center">
								<div
									className={`flex w-6 flex-col-reverse overflow-hidden rounded-t bg-muted ${styles.height}`}
									style={totalStyle}
								>
									<div
										className={`w-full bg-primary ${styles.height}`}
										style={focusStyle}
									/>
									<div
										className={`w-full bg-warning ${styles.height}`}
										style={distractionStyle}
									/>
								</div>
							</div>
							<span
								className="type-caption truncate text-muted-foreground"
								title={weekdayLabel(day.day)}
							>
								{weekdayLabel(day.day)}
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}

/** Proportional time-allocation bars for the top categories or apps. */
function AllocationList(props: { stats: JournalStat[]; title: string }) {
	const { stats, title } = props;
	const top = stats.slice(0, 6);
	const max = Math.max(1, ...top.map((s) => s.minutes));

	return (
		<div className="min-w-0 rounded-lg bg-muted/30 p-3">
			<div className="mb-2 font-medium text-xs">{title}</div>
			{top.length === 0 ? (
				<p className="text-muted-foreground text-xs">Nothing tracked yet.</p>
			) : (
				<div className="space-y-1.5">
					{top.map((stat) => {
						const allocationStyle: CSSProperties & {
							"--review-width": string;
						} = {
							"--review-width": `${(stat.minutes / max) * 100}%`,
						};
						return (
							<div className="min-w-0" key={stat.name}>
								<div className="mb-0.5 flex items-center justify-between gap-2 text-xs">
									<span className="truncate" title={stat.name}>
										{stat.name}
									</span>
									<span className="shrink-0 font-mono text-muted-foreground tabular-nums">
										{stat.minutes}m
									</span>
								</div>
								<div className="h-1.5 overflow-hidden rounded-full bg-muted">
									<div
										className={`h-full bg-primary/70 ${styles.width}`}
										style={allocationStyle}
									/>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

function Highlights(props: { items: string[] }) {
	const { items } = props;
	return (
		<div className="rounded-lg bg-muted/30 p-3">
			<div className="mb-2 font-medium text-xs">Highlights</div>
			<ul className="space-y-1.5">
				{items.map((item) => (
					<li className="flex gap-2 text-muted-foreground text-xs" key={item}>
						<span className="mt-1 inline-block size-1.5 shrink-0 rounded-full bg-primary" />
						<span className="min-w-0">{item}</span>
					</li>
				))}
			</ul>
		</div>
	);
}
