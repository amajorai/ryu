import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { Fragment, type ReactNode } from "react";
import { compactAge } from "./interface-renderer.ts";
import type {
	IncidentSeverity,
	StatusHistoryDay,
	StatusIncident,
	StatusMaintenance,
} from "./status-model.ts";

export const SEVERITY_TEXT: Record<IncidentSeverity, string> = {
	degraded: "text-status-warning",
	outage: "text-status-destructive",
};

const timeFormat = new Intl.DateTimeFormat("en-US", {
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	month: "short",
});
const scheduleFormat = new Intl.DateTimeFormat("en-US", {
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	month: "short",
	weekday: "short",
});
const dayHeadingFormat = new Intl.DateTimeFormat("en-US", {
	day: "numeric",
	month: "short",
	year: "numeric",
});

function formatAt(iso: string, format: Intl.DateTimeFormat): string {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? "" : format.format(time);
}

/** "in 20h", "in 3d": the distance to an upcoming start. */
function untilLabel(iso: string, now: number, tl: LiteralMessage): string {
	const start = Date.parse(iso);
	if (Number.isNaN(start)) {
		return "";
	}
	const minutes = Math.round((start - now) / 60_000);
	if (minutes < 1) {
		return "starting now";
	}
	if (minutes < 60) {
		return tl("in {minutes}m", { minutes: String(minutes) });
	}
	const hours = Math.round(minutes / 60);
	return hours < 48
		? tl("in {hours}h", { hours: String(hours) })
		: tl("in {days}d", { days: String(Math.round(hours / 24)) });
}

function ago(iso: string, now: number): string {
	const age = compactAge(iso, now);
	if (!age) {
		return "";
	}
	return age === "now" ? "just now" : `${age} ago`;
}

function affectsLabel(names: readonly string[]): string {
	return names.length > 0 ? `Affects ${names.join(", ")}` : "No agent assigned";
}

/** A ruled section with a heading, the shape every list below shares. */
export function StatusSectionFrame({
	children,
	headingId,
	title,
	trailing,
}: {
	children: ReactNode;
	headingId: string;
	title: string;
	trailing?: ReactNode;
}) {
	return (
		<section aria-labelledby={headingId}>
			<div className="mb-3 flex items-baseline justify-between gap-4">
				<h2 className="text-base text-foreground leading-6" id={headingId}>
					<span className="font-semibold">{title}</span>
				</h2>
				{trailing}
			</div>
			{children}
		</section>
	);
}

/** A muted metadata line: parts joined by evenly spaced middots. */
function Meta({
	parts,
}: {
	parts: readonly (readonly [key: string, node: ReactNode] | null)[];
}) {
	const shown = parts.filter((part) => part !== null);
	return (
		<span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs leading-5">
			{shown.map(([key, node], index) => (
				<Fragment key={key}>
					{index > 0 ? <span aria-hidden="true">·</span> : null}
					{node}
				</Fragment>
			))}
		</span>
	);
}

/** The update line Statuspage leads every incident with: stage, then words. */
function Update({
	body,
	stage,
	stageClassName,
}: {
	body: string;
	stage: string;
	stageClassName?: string;
}) {
	return (
		<span className="line-clamp-2 block text-foreground/90 text-sm leading-6">
			<span className={cn("font-semibold", stageClassName)}>{stage}</span>
			<span className="text-muted-foreground"> – </span>
			{body}
		</span>
	);
}

function IncidentBody({
	incident,
	now,
	showAge,
}: {
	incident: StatusIncident;
	now: number;
	showAge: boolean;
}) {
	const when = incident.resolvedAt ?? incident.at;
	return (
		<>
			<span
				className={cn(
					"block truncate font-semibold text-sm",
					SEVERITY_TEXT[incident.severity],
					incident.threadId && "group-hover:underline"
				)}
			>
				{incident.title}
			</span>
			<span className="mt-1 block">
				<Update
					body={incident.body}
					stage={incident.stage}
					stageClassName={incident.resolvedAt ? undefined : "text-foreground"}
				/>
			</span>
			<Meta
				parts={[
					["at", <time dateTime={when}>{formatAt(when, timeFormat)}</time>],
					showAge && !incident.resolvedAt
						? ["ago", ago(incident.at, now)]
						: null,
					incident.schedule ? ["schedule", incident.schedule] : null,
					["affects", affectsLabel(incident.affected)],
				]}
			/>
		</>
	);
}

function IncidentItem({
	activeThreadId,
	className,
	incident,
	now,
	onOpen,
	showAge = true,
}: {
	activeThreadId: string | null;
	className: string;
	incident: StatusIncident;
	now: number;
	onOpen: (threadId: string) => void;
	showAge?: boolean;
}) {
	const body = <IncidentBody incident={incident} now={now} showAge={showAge} />;
	const { threadId } = incident;
	if (!threadId) {
		return (
			<li className={className} data-testid="status-incident">
				{body}
			</li>
		);
	}
	const open = threadId === activeThreadId;
	return (
		<li data-testid="status-incident">
			<button
				aria-current={open ? "true" : undefined}
				className={cn(
					"group block w-full min-w-0 text-start outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
					open && "bg-muted/60 hover:bg-muted/60",
					className
				)}
				data-thread-id={threadId}
				onClick={() => onOpen(threadId)}
				type="button"
			>
				{body}
			</button>
		</li>
	);
}

/** Open incidents, newest first, right under the banner. */
export function StatusOpenIncidents({
	activeThreadId,
	incidents,
	now,
	onOpen,
}: {
	activeThreadId: string | null;
	incidents: readonly StatusIncident[];
	now: number;
	onOpen: (threadId: string) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<StatusSectionFrame
			headingId="status-incidents-heading"
			title="Incidents"
			trailing={
				<p className="text-muted-foreground text-xs">
					{tl("{count} open", { count: String(incidents.length) })}
				</p>
			}
		>
			<ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
				{incidents.map((incident) => (
					<IncidentItem
						activeThreadId={activeThreadId}
						className="px-5 py-4 max-sm:px-4"
						incident={incident}
						key={incident.id}
						now={now}
						onOpen={onOpen}
					/>
				))}
			</ul>
		</StatusSectionFrame>
	);
}

/** Upcoming scheduled runs, soonest first. */
export function StatusMaintenanceList({
	items,
	now,
}: {
	items: readonly StatusMaintenance[];
	now: number;
}) {
	const tl = useLiteralMessages();
	return (
		<StatusSectionFrame
			headingId="status-maintenance-heading"
			title="Scheduled maintenance"
		>
			{items.length === 0 ? (
				<p className="border-border border-y py-4 text-muted-foreground text-sm">
					No runs scheduled.
				</p>
			) : (
				<ul className="divide-y divide-border rounded-md border border-border bg-card">
					{items.map((item) => {
						const volume = item.count
							? ` ${item.count} runs expected that day.`
							: "";
						return (
							<li
								className="px-5 py-4 max-sm:px-4"
								data-testid="status-maintenance"
								key={item.id}
							>
								<p className="truncate font-semibold text-foreground text-sm">
									{item.title}
								</p>
								<div className="mt-1">
									<Update
										body={`${item.schedule ?? "One-off run"}.${volume}`}
										stage="Scheduled"
										stageClassName="text-status-info"
									/>
								</div>
								<Meta
									parts={[
										[
											"at",
											<time dateTime={item.start}>
												{formatAt(item.start, scheduleFormat)}
											</time>,
										],
										["until", untilLabel(item.start, now, tl)],
										[
											"affects",
											item.affected
												? `Affects ${item.affected}`
												: "Workspace-wide",
										],
									]}
								/>
							</li>
						);
					})}
				</ul>
			)}
		</StatusSectionFrame>
	);
}

/** Day-by-day history, newest first, "No incidents reported." on calm days. */
export function StatusHistory({
	activeThreadId,
	days,
	now,
	onOpen,
}: {
	activeThreadId: string | null;
	days: readonly StatusHistoryDay[];
	now: number;
	onOpen: (threadId: string) => void;
}) {
	return (
		<StatusSectionFrame
			headingId="status-history-heading"
			title="Past incidents"
		>
			<ol className="flex flex-col gap-6">
				{days.map((day, index) => (
					<li data-testid="status-history-day" key={day.key}>
						<h3 className="border-border border-b pb-2 font-medium text-foreground text-sm">
							<time dateTime={day.key}>
								{dayHeadingFormat.format(day.start)}
							</time>
						</h3>
						{day.incidents.length === 0 ? (
							<p className="pt-3 text-muted-foreground text-sm">
								{index === 0
									? "No incidents reported today."
									: "No incidents reported."}
							</p>
						) : (
							<ul className="flex flex-col pt-1">
								{day.incidents.map((incident) => (
									<IncidentItem
										activeThreadId={activeThreadId}
										className="-mx-3 rounded-md px-3 py-2"
										incident={incident}
										key={incident.id}
										now={now}
										onOpen={onOpen}
										showAge={false}
									/>
								))}
							</ul>
						)}
					</li>
				))}
			</ol>
		</StatusSectionFrame>
	);
}
