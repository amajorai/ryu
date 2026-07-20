// apps/desktop/src/pages/ReviewPage.tsx
//
// Weekly Review: a Dayflow-inspired retrospective over Shadow's on-device
// activity. Folds the trailing N days into a focus-vs-distraction headline,
// per-day rollups, time allocation by category/app, and week highlights, with a
// chat-over-your-activity panel alongside. Everything is derived locally from
// Shadow (:3030); when Shadow is unreachable the page shows an empty state.

import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityChat } from "@/src/components/review/ActivityChat.tsx";
import { FocusSummary } from "@/src/components/review/FocusSummary.tsx";
import {
	type DailyRollup,
	getWeeklyReview,
	type JournalStat,
	type WeeklyReview,
} from "@/src/lib/api/shadow.ts";

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
	return date.toLocaleDateString(undefined, { weekday: "short" });
}

export default function ReviewPage() {
	const [days, setDays] = useState(7);
	const query = useQuery({
		queryKey: ["shadow-weekly-review", days],
		queryFn: ({ signal }) => getWeeklyReview(days, signal),
		refetchInterval: 60_000,
	});
	const review = query.data;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
				<div>
					<h1 className="font-semibold text-base">Weekly review</h1>
					<p className="text-muted-foreground text-xs">
						Your focus, time, and highlights — derived on-device.
					</p>
				</div>
				<Select
					items={RANGE_OPTIONS}
					onValueChange={(value: string) => setDays(Number(value))}
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

			<div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(320px,26rem)]">
				<div className="min-w-0 overflow-y-auto p-4">
					{query.isLoading && (
						<div className="flex items-center gap-2 text-muted-foreground text-sm">
							<Spinner className="size-4" /> Loading your week…
						</div>
					)}
					{!(query.isLoading || review) && <ReviewEmptyState />}
					{review && <ReviewBody review={review} />}
				</div>
				<div className="min-h-0 border-t lg:border-t-0 lg:border-l">
					<ActivityChat className="h-full" />
				</div>
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
	if (days.length === 0) {
		return null;
	}
	const maxMinutes = Math.max(
		1,
		...days.map((d) => d.focus_minutes + d.distraction_minutes)
	);

	return (
		<div className="rounded-lg bg-muted/30 p-3">
			<div className="mb-3 font-semibold text-xs">Daily focus</div>
			<div className="flex items-end justify-between gap-2">
				{days.map((day) => {
					const totalMin = day.focus_minutes + day.distraction_minutes;
					const heightPct = (totalMin / maxMinutes) * 100;
					const focusShare =
						totalMin === 0 ? 0 : (day.focus_minutes / totalMin) * 100;
					return (
						<div
							className="flex min-w-0 flex-1 flex-col items-center gap-1"
							key={day.day}
							title={`${day.day}: ${Math.round(day.focus_ratio * 100)}% focus, ${totalMin}m tracked`}
						>
							<div className="flex h-24 w-full items-end justify-center">
								<div
									className="flex w-6 flex-col-reverse overflow-hidden rounded-t bg-muted"
									style={{ height: `${Math.max(heightPct, 3)}%` }}
								>
									<div
										className="w-full bg-primary"
										style={{ height: `${focusShare}%` }}
									/>
									<div
										className="w-full bg-warning"
										style={{ height: `${100 - focusShare}%` }}
									/>
								</div>
							</div>
							<span className="truncate text-[11px] text-muted-foreground">
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
			<div className="mb-2 font-semibold text-xs">{title}</div>
			{top.length === 0 ? (
				<p className="text-muted-foreground text-xs">Nothing tracked yet.</p>
			) : (
				<div className="space-y-1.5">
					{top.map((stat) => (
						<div className="min-w-0" key={stat.name}>
							<div className="mb-0.5 flex items-center justify-between gap-2 text-xs">
								<span className="truncate">{stat.name}</span>
								<span className="shrink-0 font-mono text-muted-foreground tabular-nums">
									{stat.minutes}m
								</span>
							</div>
							<div className="h-1.5 overflow-hidden rounded-full bg-muted">
								<div
									className="h-full bg-primary/70"
									style={{ width: `${(stat.minutes / max) * 100}%` }}
								/>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function Highlights(props: { items: string[] }) {
	const { items } = props;
	return (
		<div className="rounded-lg bg-muted/30 p-3">
			<div className="mb-2 font-semibold text-xs">Highlights</div>
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
