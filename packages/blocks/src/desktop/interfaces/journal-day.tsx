import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceEvent,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import { agentById } from "./interface-renderer.ts";
import {
	countLabel,
	entryExcerpt,
	entryTitle,
	fullDateLabel,
	type JournalEntry,
	mediumDateLabel,
	monthLabel,
	type OnThisDayGroup,
	parseDayKey,
	timeLabel,
	weekdayLong,
} from "./journal-model.ts";
import {
	entryPlaceItems,
	JournalMetaLine,
	JournalStatusText,
} from "./journal-parts.tsx";

/** The reading column every Journal page shares. */
export const READING_COLUMN = "mx-auto w-full max-w-[44rem] px-6 sm:px-10";

/** Day One's day header: the big date, then what the day holds. */
function DayHeader({
	dayKey,
	entries,
	isToday,
	titleClass,
}: {
	dayKey: string;
	entries: JournalEntry[];
	isToday: boolean;
	titleClass: string;
}) {
	const messages = entries.reduce(
		(sum, entry) => sum + entry.thread.messageCount,
		0
	);
	const summary = [
		isToday ? "Today" : null,
		entries.length > 0 ? countLabel(entries.length, "entry", "entries") : null,
		messages > 0 ? countLabel(messages, "message") : null,
	].filter(Boolean);
	return (
		<header className="flex items-end gap-4 border-border border-b pb-6">
			<h1 className="flex min-w-0 items-end gap-4">
				<span className="sr-only">{fullDateLabel(dayKey)}</span>
				<span
					aria-hidden="true"
					className={cn(
						"font-medium text-7xl text-foreground tabular-nums leading-[0.85]",
						titleClass
					)}
				>
					{parseDayKey(dayKey).getDate()}
				</span>
				<span aria-hidden="true" className="flex min-w-0 flex-col pb-0.5">
					<span
						className={cn(
							"font-semibold text-foreground text-xl leading-7",
							titleClass
						)}
					>
						{weekdayLong(dayKey)}
					</span>
					<span className="text-base text-muted-foreground leading-6">
						{monthLabel(dayKey)}
					</span>
				</span>
			</h1>
			{summary.length > 0 ? (
				<p className="ms-auto shrink-0 pb-1 text-right text-muted-foreground text-sm leading-5 max-sm:hidden">
					{summary.join(" · ")}
				</p>
			) : null}
		</header>
	);
}

/** One entry as it reads on the day page: time in the margin, then the text. */
function DayEntry({
	entry,
	onOpen,
	titleClass,
}: {
	entry: JournalEntry;
	onOpen: (entry: JournalEntry) => void;
	titleClass: string;
}) {
	return (
		<article
			className="group relative grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 border-border/70 border-b py-6 last:border-b-0 max-sm:grid-cols-1"
			data-thread-id={entry.thread.id}
		>
			<time
				className="pt-1 text-muted-foreground text-sm tabular-nums leading-6 max-sm:pt-0 max-sm:text-xs"
				dateTime={entry.thread.updatedAt}
			>
				{timeLabel(entry.at)}
			</time>
			<div className="min-w-0">
				<h2
					className={cn(
						"font-semibold text-foreground text-xl leading-8",
						titleClass
					)}
				>
					<button
						className="rounded-sm text-left font-semibold decoration-foreground/30 underline-offset-4 outline-none after:absolute after:inset-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:underline"
						onClick={() => onOpen(entry)}
						type="button"
					>
						{entryTitle(entry.thread)}
					</button>
				</h2>
				<p className="mt-1 line-clamp-3 text-base text-foreground leading-7">
					{entryExcerpt(entry.thread)}
				</p>
				<JournalMetaLine
					agents={entry.agents}
					className="mt-3 text-xs leading-5"
					items={[
						...entryPlaceItems(entry.agents, entry.place),
						{
							key: "status",
							node: <JournalStatusText status={entry.status} />,
						},
					]}
				/>
			</div>
		</article>
	);
}

function SectionTitle({ children }: { children: ReactNode }) {
	return (
		<h2 className="font-medium text-muted-foreground text-xs uppercase leading-4 tracking-wide">
			{children}
		</h2>
	);
}

/** Earlier entries from this date, as a compact list. */
function OnThisDay({
	groups,
	onOpen,
	onSelectDay,
	titleClass,
}: {
	groups: OnThisDayGroup[];
	onOpen: (entry: JournalEntry) => void;
	onSelectDay: (key: string) => void;
	titleClass: string;
}) {
	return (
		<section
			aria-label="On this day"
			className="mt-12 border-border border-t pt-6"
		>
			<SectionTitle>On this day</SectionTitle>
			<div className="mt-4 flex flex-col gap-6">
				{groups.map((group) => (
					<div key={group.key}>
						<button
							className="rounded-sm text-muted-foreground text-sm leading-5 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
							onClick={() => onSelectDay(group.key)}
							type="button"
						>
							{group.label} · {mediumDateLabel(group.key)}
						</button>
						<ul className="mt-2 flex flex-col gap-1">
							{group.entries.map((entry) => (
								<li key={entry.thread.id}>
									<button
										className="-mx-3 flex w-[calc(100%+1.5rem)] flex-col rounded-md px-3 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
										onClick={() => onOpen(entry)}
										type="button"
									>
										<span
											className={cn(
												"truncate font-semibold text-base text-foreground leading-6",
												titleClass
											)}
										>
											{entryTitle(entry.thread)}
										</span>
										<span className="line-clamp-1 text-muted-foreground text-sm leading-5">
											{entryExcerpt(entry.thread)}
										</span>
									</button>
								</li>
							))}
						</ul>
					</div>
				))}
			</div>
		</section>
	);
}

function runState(event: InterfaceEvent): string {
	if (event.kind === "upcoming") {
		return event.count ? `${event.count} runs` : "Scheduled";
	}
	if (event.outcome === "failure") {
		return "Failed";
	}
	return event.outcome === "success" ? "Completed" : "Ran";
}

/** A blank day, set in the entries' column so the page keeps one edge. */
function DayBlank({
	action,
	description,
	title,
}: {
	action: ReactNode;
	description: string;
	title: string;
}) {
	return (
		<div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 py-8 max-sm:grid-cols-1">
			<span aria-hidden="true" />
			<div className="flex min-w-0 flex-col items-start gap-1">
				<p className="font-medium text-foreground text-sm leading-5">{title}</p>
				<p className="max-w-sm text-muted-foreground text-sm leading-5">
					{description}
				</p>
				{action ? <div className="mt-3">{action}</div> : null}
			</div>
		</div>
	);
}

/** The day's scheduled runs, as a plain agenda. */
function DayRuns({
	events,
	snapshot,
}: {
	events: InterfaceEvent[];
	snapshot: InterfaceSnapshot;
}) {
	return (
		<section
			aria-label="Scheduled runs"
			className="mt-12 border-border border-t pt-6"
		>
			<SectionTitle>Scheduled runs</SectionTitle>
			<ul className="mt-3">
				{events.map((event) => {
					const agent = agentById(snapshot, event.agentId);
					const recurring = Boolean(event.label);
					const detail = [event.label, agent?.name].filter(Boolean).join(" · ");
					return (
						<li
							className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-baseline gap-x-4 py-2 text-sm leading-5 max-sm:grid-cols-[minmax(0,1fr)_auto]"
							key={event.id}
						>
							{recurring ? (
								<span aria-hidden="true" className="max-sm:hidden" />
							) : (
								<time
									className="text-muted-foreground tabular-nums max-sm:hidden"
									dateTime={event.start}
								>
									{timeLabel(new Date(event.start))}
								</time>
							)}
							<span className="min-w-0 truncate">
								<span className="text-foreground">{event.title}</span>
								{detail ? (
									<span className="text-muted-foreground"> · {detail}</span>
								) : null}
							</span>
							<span
								className={cn(
									"text-sm tabular-nums",
									event.outcome === "failure"
										? "text-destructive"
										: "text-muted-foreground"
								)}
							>
								{runState(event)}
							</span>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

export function JournalDayPage({
	composer,
	dayKey,
	entries,
	events,
	isFuture,
	isToday,
	latestDay,
	loading,
	onNewEntry,
	onOpen,
	onSelectDay,
	onThisDayGroups,
	snapshot,
	titleClass,
}: {
	composer: ReactNode | null;
	dayKey: string;
	entries: JournalEntry[];
	events: InterfaceEvent[];
	/** The day is after today: nothing can have happened yet. */
	isFuture: boolean;
	isToday: boolean;
	/** Most recent day with an entry, offered when this day is blank. */
	latestDay: string | null;
	loading: boolean;
	onNewEntry: () => void;
	onOpen: (entry: JournalEntry) => void;
	onSelectDay: (key: string) => void;
	onThisDayGroups: OnThisDayGroup[];
	snapshot: InterfaceSnapshot;
	titleClass: string;
}) {
	const tl = useLiteralMessages();
	if (loading) {
		return (
			<div
				aria-busy="true"
				aria-label="Loading day"
				className={cn(READING_COLUMN, "pt-12")}
				role="status"
			>
				<div className="flex items-end gap-4 border-border border-b pb-6">
					<Skeleton className="h-16 w-16" radius="row" />
					<div className="flex flex-col gap-2 pb-1">
						<Skeleton className="h-5 w-32" radius="dense" />
						<Skeleton className="h-4 w-24" radius="dense" />
					</div>
				</div>
				{["a", "b"].map((row) => (
					<div
						className="flex flex-col gap-2 border-border/70 border-b py-6 ps-[5.5rem]"
						key={row}
					>
						<Skeleton className="h-5 w-1/2" radius="dense" />
						<Skeleton className="h-3.5 w-full" radius="dense" />
						<Skeleton className="h-3.5 w-4/5" radius="dense" />
					</div>
				))}
			</div>
		);
	}

	let blank: ReactNode = null;
	if (entries.length === 0 && !composer) {
		blank =
			isToday || isFuture ? (
				<DayBlank
					action={
						<Button onClick={onNewEntry} size="sm" variant="outline">
							New entry
						</Button>
					}
					description={
						isToday
							? "Start a conversation and it lands here as today's first entry."
							: "Entries land on the day their conversation was last active."
					}
					title={isToday ? "Nothing written today" : "Nothing written yet"}
				/>
			) : (
				<DayBlank
					action={
						latestDay && latestDay !== dayKey ? (
							<Button
								onClick={() => onSelectDay(latestDay)}
								size="sm"
								variant="outline"
							>
								{tl("Go to {date}", { date: mediumDateLabel(latestDay) })}
							</Button>
						) : null
					}
					description="No conversation was active on this day."
					title="No entries"
				/>
			);
	}

	return (
		<div className={cn(READING_COLUMN, "pt-12 pb-24")}>
			<DayHeader
				dayKey={dayKey}
				entries={entries}
				isToday={isToday}
				titleClass={titleClass}
			/>
			{composer ? <div className="pt-6">{composer}</div> : null}
			{blank}
			{entries.length > 0 ? (
				<section aria-label="Entries">
					{entries.map((entry) => (
						<DayEntry
							entry={entry}
							key={entry.thread.id}
							onOpen={onOpen}
							titleClass={titleClass}
						/>
					))}
				</section>
			) : null}
			{onThisDayGroups.length > 0 ? (
				<OnThisDay
					groups={onThisDayGroups}
					onOpen={onOpen}
					onSelectDay={onSelectDay}
					titleClass={titleClass}
				/>
			) : null}
			{events.length > 0 ? (
				<DayRuns events={events} snapshot={snapshot} />
			) : null}
		</div>
	);
}
