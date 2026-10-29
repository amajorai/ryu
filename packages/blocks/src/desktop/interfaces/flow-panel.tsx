import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import {
	activityPerHour,
	type FlowLogEntry,
	type FlowScope,
	flowLogs,
	flowMetrics,
	logClock,
	logDay,
	scopeThreads,
} from "./flow-model.ts";
import {
	ConversationGlyph,
	FlowDot,
	OriginGlyph,
	TeamGlyph,
} from "./flow-parts.tsx";

function PanelHeader({
	actions,
	glyph,
	subtitle,
	title,
}: {
	actions: ReactNode;
	glyph: ReactNode;
	subtitle?: ReactNode;
	title: string;
}) {
	return (
		<header className="flex h-12 shrink-0 items-center gap-2.5 border-border border-b ps-4 pe-2">
			{glyph}
			<div className="flex min-w-0 flex-1 items-baseline gap-2">
				<h2 className="max-w-full shrink-0 truncate font-medium text-foreground text-sm">
					{title}
				</h2>
				{subtitle ? (
					<span className="hidden min-w-0 flex-1 truncate text-[13px] text-muted-foreground sm:inline">
						{subtitle}
					</span>
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-0.5">{actions}</div>
		</header>
	);
}

function CloseButton({ onClose }: { onClose: () => void }) {
	return (
		<Button
			aria-label="Close panel"
			onClick={onClose}
			size="icon-sm"
			title="Close (Esc)"
			variant="ghost-muted"
		>
			<X aria-hidden="true" className="size-4 stroke-[1.75]" />
		</Button>
	);
}

function SectionTitle({
	aside,
	children,
}: {
	aside?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex h-5 items-center justify-between">
			<h3 className="font-medium text-[13px] text-foreground">{children}</h3>
			{aside ? (
				<span className="text-[13px] text-muted-foreground tabular-nums">
					{aside}
				</span>
			) : null}
		</div>
	);
}

function Metric({
	emphasis,
	label,
	value,
}: {
	emphasis?: boolean;
	label: string;
	value: number;
}) {
	return (
		<div className="flex flex-col gap-1 px-3 py-2.5">
			<dt className="text-[13px] text-muted-foreground">{label}</dt>
			<dd
				className={cn(
					"font-semibold text-base text-foreground tabular-nums leading-6",
					emphasis && value > 0 && "text-destructive"
				)}
			>
				{value.toLocaleString()}
			</dd>
		</div>
	);
}

const CHART_W = 320;
const CHART_H = 72;

/**
 * A monotone cubic (Fritsch-Carlson) through the points, so sparse hours read
 * as a smooth line that never overshoots below zero or above the peak.
 */
export function monotonePath(points: readonly [number, number][]): string {
	const count = points.length;
	const fmt = (value: number) => value.toFixed(1);
	const [firstX, firstY] = points[0] ?? [0, 0];
	if (count === 0) {
		return "";
	}
	let path = `M ${fmt(firstX)} ${fmt(firstY)}`;
	if (count === 1) {
		return path;
	}
	const slopes: number[] = [];
	for (let index = 0; index < count - 1; index += 1) {
		const [x0, y0] = points[index] ?? [0, 0];
		const [x1, y1] = points[index + 1] ?? [0, 0];
		slopes.push((y1 - y0) / (x1 - x0 || 1));
	}
	const tangents: number[] = [];
	for (let index = 0; index < count; index += 1) {
		const before = slopes[index - 1];
		const after = slopes[index];
		if (before === undefined || after === undefined) {
			tangents.push(before ?? after ?? 0);
		} else if (before * after <= 0) {
			tangents.push(0);
		} else {
			tangents.push((2 * before * after) / (before + after));
		}
	}
	for (let index = 0; index < count - 1; index += 1) {
		const [x0, y0] = points[index] ?? [0, 0];
		const [x1, y1] = points[index + 1] ?? [0, 0];
		const third = (x1 - x0) / 3;
		const t0 = tangents[index] ?? 0;
		const t1 = tangents[index + 1] ?? 0;
		path += ` C ${fmt(x0 + third)} ${fmt(y0 + t0 * third)} ${fmt(x1 - third)} ${fmt(y1 - t1 * third)} ${fmt(x1)} ${fmt(y1)}`;
	}
	return path;
}

function peakSummary(tl: LiteralMessage, buckets: number[], peak: number) {
	const total = buckets.reduce((sum, value) => sum + value, 0);
	if (total === 0) {
		return "No activity in the last 24 hours";
	}
	const hoursAgo = buckets.length - 1 - buckets.indexOf(peak);
	return tl(
		"{total, plural, one {{total} update} other {{total} updates}} in the last 24 hours, peak {peak} {hoursAgo, plural, =0 {in the last hour} one {# hour ago} other {# hours ago}}",
		{ hoursAgo, peak, total }
	);
}

/** Per-hour activity as a smooth area, oldest hour on the left. */
export function ActivityChart({ buckets }: { buckets: number[] }) {
	const peak = Math.max(1, ...buckets);
	const step = CHART_W / Math.max(1, buckets.length - 1);
	const top = 8;
	const yFor = (value: number) => CHART_H - (value / peak) * (CHART_H - top);
	const points = buckets.map((value, index): [number, number] => [
		index * step,
		yFor(value),
	]);
	const line = monotonePath(points);
	const area = `${line} L ${CHART_W} ${CHART_H} L 0 ${CHART_H} Z`;
	const active = buckets.some((value) => value > 0);
	const tl = useLiteralMessages();
	const summary = peakSummary(tl, buckets, peak);
	return (
		<figure className="flex flex-col gap-1.5">
			<div className="relative" title={summary}>
				<svg
					aria-label={summary}
					className="h-18 w-full overflow-visible"
					preserveAspectRatio="none"
					role="img"
					viewBox={`0 0 ${CHART_W} ${CHART_H}`}
				>
					<line
						className="stroke-border"
						strokeDasharray="2 3"
						vectorEffect="non-scaling-stroke"
						x1="0"
						x2={CHART_W}
						y1={top}
						y2={top}
					/>
					{active ? (
						<>
							<path className="fill-primary/15" d={area} />
							<path
								className="stroke-primary"
								d={line}
								fill="none"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth="1.5"
								vectorEffect="non-scaling-stroke"
							/>
						</>
					) : null}
					<line
						className="stroke-border"
						vectorEffect="non-scaling-stroke"
						x1="0"
						x2={CHART_W}
						y1={CHART_H}
						y2={CHART_H}
					/>
				</svg>
				{active ? (
					// The y max sits on its own gridline, inside the plot's top-left.
					<span
						aria-hidden="true"
						className="absolute top-0 left-0 bg-background pe-1 text-[13px] text-muted-foreground tabular-nums leading-4"
					>
						{peak}
					</span>
				) : (
					<span className="absolute inset-x-0 bottom-3 text-center text-[13px] text-muted-foreground">
						No activity in the last 24 hours
					</span>
				)}
			</div>
			<figcaption className="flex justify-between text-[13px] text-muted-foreground tabular-nums">
				<span>24h ago</span>
				<span>12h ago</span>
				<span>Now</span>
			</figcaption>
		</figure>
	);
}

function LogRow({
	entry,
	onOpenThread,
}: {
	entry: FlowLogEntry;
	onOpenThread: (threadId: string) => void;
}) {
	const cells = (
		<>
			<time
				className="font-mono text-[13px] text-muted-foreground tabular-nums"
				dateTime={entry.at}
			>
				{logClock(entry.at)}
			</time>
			<FlowDot className="justify-self-center" tone={entry.tone} />
			<span className="text-[13px] text-foreground">{entry.verb}</span>
			<span className="truncate text-[13px] text-foreground">
				{entry.title}
			</span>
		</>
	);
	const grid =
		"grid h-8 w-full grid-cols-[2.5rem_0.625rem_3.5rem_minmax(0,1fr)] items-center gap-x-2 rounded-md px-2 text-left";
	const { threadId } = entry;
	if (threadId) {
		return (
			<li>
				<button
					className={cn(
						grid,
						"outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30"
					)}
					onClick={() => onOpenThread(threadId)}
					type="button"
				>
					{cells}
				</button>
			</li>
		);
	}
	return <li className={grid}>{cells}</li>;
}

/** Log entries grouped under day headings, newest day first. */
function LogList({
	logs,
	now,
	onOpenThread,
}: {
	logs: FlowLogEntry[];
	now: number;
	onOpenThread: (threadId: string) => void;
}) {
	const days: { entries: FlowLogEntry[]; label: string }[] = [];
	for (const entry of logs) {
		const label = logDay(entry.at, now);
		const last = days.at(-1);
		if (last && last.label === label) {
			last.entries.push(entry);
		} else {
			days.push({ entries: [entry], label });
		}
	}
	return (
		<div className="-mx-2 flex flex-col gap-1">
			{days.map((day) => (
				<section aria-label={day.label} key={day.label}>
					<h4 className="flex h-7 items-center px-2 text-[13px] text-muted-foreground">
						{day.label}
					</h4>
					<ol className="flex flex-col">
						{day.entries.map((entry) => (
							<LogRow
								entry={entry}
								key={entry.id}
								onOpenThread={onOpenThread}
							/>
						))}
					</ol>
				</section>
			))}
		</div>
	);
}

export interface FlowPanelSubject {
	description: string;
	glyph: "agent" | "lane" | "origin" | "team";
	name: string;
	scope: FlowScope;
}

/** Overview for an agent, a team, or the whole workspace (the "You" node). */
export function FlowOverviewPanel({
	now,
	onClose,
	onNew,
	onOpenThread,
	snapshot,
	subject,
}: {
	now: number;
	onClose: () => void;
	onNew: (() => void) | null;
	onOpenThread: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
	subject: FlowPanelSubject;
}) {
	const tl = useLiteralMessages();
	const name = subject.name;
	const newLabel = tl("New conversation with {name}", { name });
	const threads = scopeThreads(snapshot, subject.scope);
	const metrics = flowMetrics(threads);
	const buckets = activityPerHour(snapshot, subject.scope, now);
	const logs = flowLogs(snapshot, subject.scope, now);
	const agent =
		subject.scope.kind === "agent"
			? snapshot.agents.find(
					(item) =>
						subject.scope.kind === "agent" && item.id === subject.scope.agentId
				)
			: undefined;
	let glyph: ReactNode;
	if (subject.glyph === "agent") {
		glyph = (
			<BoardAvatar
				agent={agent}
				className="size-6 rounded-md"
				name={subject.name}
				size={24}
			/>
		);
	} else if (subject.glyph === "lane") {
		glyph = (
			<span className="size-6 rounded-md border border-[var(--flow-line)] border-dashed" />
		);
	} else if (subject.glyph === "team") {
		glyph = (
			<span className="flex size-6 items-center justify-center rounded-md bg-muted">
				<TeamGlyph className="text-foreground/70" />
			</span>
		);
	} else {
		glyph = (
			<span className="flex size-6 items-center justify-center rounded-full border border-border">
				<OriginGlyph className="size-3.5" />
			</span>
		);
	}
	return (
		<section
			aria-label={tl("{name} overview", { name })}
			className="flex h-full min-h-0 flex-col"
		>
			<PanelHeader
				actions={
					<>
						{onNew ? (
							<Button
								aria-label={newLabel}
								onClick={onNew}
								size="icon-sm"
								title={newLabel}
								variant="ghost-muted"
							>
								<Plus aria-hidden="true" className="size-4 stroke-[1.75]" />
							</Button>
						) : null}
						<CloseButton onClose={onClose} />
					</>
				}
				glyph={glyph}
				title={subject.name}
			/>
			<div
				className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-4 pb-6"
				data-flow-scroll=""
			>
				<section aria-label="Metrics" className="flex flex-col gap-3">
					<SectionTitle>Metrics</SectionTitle>
					<dl className="grid grid-cols-2 overflow-hidden rounded-lg border border-border [&>div:nth-child(-n+2)]:border-border [&>div:nth-child(-n+2)]:border-b [&>div:nth-child(odd)]:border-border [&>div:nth-child(odd)]:border-r">
						<Metric label="Conversations" value={metrics.conversations} />
						<Metric label="Working" value={metrics.working} />
						<Metric emphasis label="Needs you" value={metrics.needsYou} />
						<Metric label="Messages" value={metrics.messages} />
					</dl>
				</section>
				<section aria-label="Activity per hour" className="flex flex-col gap-2">
					<SectionTitle aside="Last 24 hours">Activity per hour</SectionTitle>
					<ActivityChart buckets={buckets} />
				</section>
				<section aria-label="Logs" className="flex flex-col gap-2">
					<SectionTitle aside={logs.length > 0 ? `${logs.length}` : undefined}>
						Logs
					</SectionTitle>
					{logs.length > 0 ? (
						<LogList logs={logs} now={now} onOpenThread={onOpenThread} />
					) : (
						<p className="py-2 text-[13px] text-muted-foreground">
							No activity yet. New conversations and runs appear here.
						</p>
					)}
				</section>
			</div>
		</section>
	);
}

/** The open conversation: a slim header over the host's own chat surface. */
export function FlowThreadPanel({
	onClose,
	thread,
	threadView,
}: {
	onClose: () => void;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const status = thread ? threadStatus(thread) : null;
	return (
		<section
			aria-label={thread?.title.trim() || "Conversation"}
			className="flex h-full min-h-0 flex-col"
		>
			<PanelHeader
				actions={<CloseButton onClose={onClose} />}
				glyph={<ConversationGlyph className="text-foreground/70" />}
				subtitle={
					status ? (
						<span className="inline-flex items-center gap-1.5">
							<FlowDot tone={status} />
							{THREAD_STATUS_LABELS[status]}
						</span>
					) : undefined
				}
				title={thread?.title.trim() || "New conversation"}
			/>
			<div className="min-h-0 flex-1" data-flow-scroll="">
				{threadView}
			</div>
		</section>
	);
}
