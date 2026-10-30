import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { ChevronRight, MessageSquarePlus } from "lucide-react";
import { type ReactNode, type RefObject, useId } from "react";
import { agentById, compactAge } from "./interface-renderer.ts";
import { TIME_TEXT, WholeRowList } from "./mission-control-alerts-list.tsx";
import type { MissionAlert } from "./mission-control-model.ts";
import { Lamp, MissionPanel, SUBTLE_LABEL } from "./mission-control-parts.tsx";

export { TIME_TEXT } from "./mission-control-alerts-list.tsx";
export { UpcomingPanel } from "./mission-control-alerts-runs.tsx";

/**
 * Lamp, the alert text, then its age. On a panel wide enough the title and
 * its detail share one line, Grafana alert-list style; on a narrow one the
 * detail drops below the title. The row action sits over the age and swaps in
 * on hover or focus, so ages stay flush with the panel's right edge.
 */
const ALERT_ROW =
	"grid w-full min-w-0 grid-cols-[0.625rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-md px-2 py-1.5 text-left";

/**
 * The age gives way to the row action at once: no crossfade, so a focus ring
 * never circles half-faded text. Opacity (not visibility) keeps the action
 * reachable by keyboard.
 */
const ROW_AGE =
	"group-focus-within/alert:opacity-0 group-hover/alert:opacity-0";
const ROW_ACTION =
	"opacity-0 focus-visible:opacity-100 group-focus-within/alert:opacity-100 group-hover/alert:opacity-100";

function ageText(iso: string, now: number): string {
	return compactAge(iso, now) || "—";
}

/** A hairline sub-header inside a panel: label, count, rule. */
function SubHeader({
	count,
	id,
	label,
}: {
	count?: number;
	id: string;
	label: string;
}) {
	return (
		<h3
			className={cn("flex items-center gap-2 px-2 pt-3 pb-1", SUBTLE_LABEL)}
			data-row="header"
			id={id}
		>
			<span>{label}</span>
			{count === undefined ? null : (
				<span className="text-foreground tabular-nums">{count}</span>
			)}
			<span aria-hidden="true" className="h-px flex-1 bg-border" />
		</h3>
	);
}

/** "Scheduled run failed · Every Monday" → the outcome, then the context. */
function splitDetail(detail: string): [string, string | null] {
	const at = detail.indexOf(" · ");
	return at === -1
		? [detail, null]
		: [detail.slice(0, at), detail.slice(at + 3)];
}

function AlertBody({
	action,
	alert,
	agentName,
	now,
}: {
	action: ReactNode;
	agentName: string | null;
	alert: MissionAlert;
	now: number;
}) {
	const warning = alert.severity === "warning";
	let detail: ReactNode;
	if (warning) {
		const [outcome, context] = splitDetail(alert.detail);
		const rest = [context, agentName].filter(Boolean).join(" · ");
		detail = (
			<>
				<span className="text-status-destructive">{outcome}</span>
				{rest ? ` · ${rest}` : ""}
			</>
		);
	} else {
		// Waiting on you: who, then the last thing they said.
		detail = [agentName, alert.detail].filter(Boolean).join(" · ");
	}
	return (
		<>
			<span className="flex h-5 items-center justify-center">
				<Lamp state={warning ? "failure" : "your-turn"} />
			</span>
			<span className="flex min-w-0 @min-[420px]/alerts:flex-row flex-col @min-[420px]/alerts:items-baseline @min-[420px]/alerts:gap-3 gap-0.5">
				<span className="@min-[420px]/alerts:max-w-[55%] shrink-0 truncate font-medium text-[13px] text-foreground leading-5">
					{alert.title}
				</span>
				<span className="min-w-0 truncate text-muted-foreground text-xs leading-4">
					{detail}
				</span>
			</span>
			<span className="relative flex h-5 items-center justify-end">
				<span className={cn(TIME_TEXT, action ? ROW_AGE : undefined)}>
					{ageText(alert.at, now)}
				</span>
				{action ? (
					<span className="absolute inset-y-0 right-0 flex items-center">
						{action}
					</span>
				) : null}
			</span>
		</>
	);
}

function AlertRow({
	activeThreadId,
	alert,
	flash,
	now,
	onMessage,
	onOpen,
	snapshot,
}: {
	activeThreadId: string | null;
	alert: MissionAlert;
	flash: boolean;
	now: number;
	onMessage: (agentId: string) => void;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const agent = agentById(snapshot, alert.agentId);
	const threadId = alert.threadId;
	let action: ReactNode = null;
	if (threadId) {
		action = (
			<span
				aria-hidden="true"
				className={cn(
					"flex size-5 items-center justify-center text-muted-foreground",
					ROW_ACTION
				)}
			>
				<ChevronRight className="size-3.5" />
			</span>
		);
	} else if (agent) {
		action = (
			<Button
				aria-label={tl("Follow up with {name} on {title}", {
					name: agent.name,
					title: alert.title,
				})}
				className={cn("text-muted-foreground", ROW_ACTION)}
				onClick={() => onMessage(agent.id)}
				size="icon-xs"
				title={tl("New thread with {name}", { name: agent.name })}
				type="button"
				variant="ghost"
			>
				<MessageSquarePlus aria-hidden="true" />
			</Button>
		);
	}
	const body = (
		<AlertBody
			action={action}
			agentName={agent?.name ?? null}
			alert={alert}
			now={now}
		/>
	);
	return (
		<li
			className={cn(
				"group/alert min-w-0 rounded-md",
				flash && "bg-muted ring-2 ring-ring ring-inset"
			)}
			data-alert={alert.id}
			data-flash={flash ? "true" : undefined}
			data-row="item"
			data-severity={alert.severity}
		>
			{threadId ? (
				<button
					aria-current={threadId === activeThreadId ? "true" : undefined}
					aria-label={tl("Open {title}: {detail}", {
						detail: alert.detail,
						title: alert.title,
					})}
					className={cn(
						ALERT_ROW,
						"outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=true]:bg-muted"
					)}
					onClick={() => onOpen(threadId)}
					type="button"
				>
					{body}
				</button>
			) : (
				<div className={cn(ALERT_ROW, "transition-colors hover:bg-muted")}>
					{body}
				</div>
			)}
		</li>
	);
}

/**
 * Failures first (failed or interrupted threads and failed scheduled runs),
 * then everything waiting on you. The list scrolls in place with a fade when
 * it outgrows the panel. Threads open in place; a failed run offers a fresh
 * thread with its agent. `flash` marks the first failure after the banner's
 * "Review alerts" jumps here, until focus moves on.
 */
export function AlertsPanel({
	activeThreadId,
	alerts,
	flash = false,
	listRef,
	now,
	onMessage,
	onOpen,
	snapshot,
}: {
	activeThreadId: string | null;
	alerts: MissionAlert[];
	flash?: boolean;
	listRef: RefObject<HTMLDivElement | null>;
	now: number;
	onMessage: (agentId: string) => void;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const groupId = useId();
	const warnings = alerts.filter((alert) => alert.severity === "warning");
	const advisories = alerts.filter((alert) => alert.severity === "advisory");
	const failuresId = `${groupId}-failures`;
	const advisoriesId = `${groupId}-advisories`;
	const row = (alert: MissionAlert, index: number) => (
		<AlertRow
			activeThreadId={activeThreadId}
			alert={alert}
			flash={flash && alert.severity === "warning" && index === 0}
			key={alert.id}
			now={now}
			onMessage={onMessage}
			onOpen={onOpen}
			snapshot={snapshot}
		/>
	);
	return (
		<MissionPanel title="Alerts" titleId="mission-alerts-title">
			{alerts.length === 0 ? (
				<div className="m-auto flex flex-col items-center gap-1 px-6 py-8 text-center">
					<p className="font-medium text-[13px] text-foreground">No alerts</p>
					<p className="text-muted-foreground text-xs">
						No failed runs or replies waiting.
					</p>
				</div>
			) : (
				<WholeRowList
					className="@container/alerts"
					contentKey={alerts.map((alert) => alert.id).join("|")}
					listRef={listRef}
				>
					{warnings.length > 0 ? (
						<section aria-labelledby={failuresId}>
							<SubHeader
								count={warnings.length}
								id={failuresId}
								label="Failures"
							/>
							<ul className="flex flex-col">{warnings.map(row)}</ul>
						</section>
					) : null}
					{advisories.length > 0 ? (
						<section aria-labelledby={advisoriesId}>
							<SubHeader
								count={advisories.length}
								id={advisoriesId}
								label="Waiting on you"
							/>
							<ul className="flex flex-col">{advisories.map(row)}</ul>
						</section>
					) : null}
				</WholeRowList>
			)}
		</MissionPanel>
	);
}
