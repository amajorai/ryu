import { activeLocale, numberFormatter } from "@ryu/i18n/lite";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
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
import { ActivityChart } from "./flow-panel-chart.tsx";
import {
	ConversationGlyph,
	FlowDot,
	OriginGlyph,
	TeamGlyph,
} from "./flow-parts.tsx";
import { threadStatusLabel } from "./interface-renderer.ts";

export {
	ActivityChart,
	monotonePath,
} from "./flow-panel-chart.tsx";

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
				{numberFormatter(activeLocale()).format(value)}
			</dd>
		</div>
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
			<span
				className="truncate text-[13px] text-foreground"
				data-ryu-i18n="off"
			>
				{entry.title}
			</span>
		</>
	);
	const grid =
		"grid h-8 w-full grid-cols-[2.5rem_0.625rem_3.5rem_minmax(0,1fr)] items-center gap-x-2 rounded-md px-2 text-start";
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
					<dl className="grid grid-cols-2 overflow-hidden rounded-lg border border-border [&>div:nth-child(-n+2)]:border-border [&>div:nth-child(-n+2)]:border-b [&>div:nth-child(odd)]:border-border [&>div:nth-child(odd)]:border-e">
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
							{threadStatusLabel(status)}
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
