import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	askAriaLabel,
	blockerAriaLabel,
	type ClockOptions,
	type InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	CalendarX,
	Clock,
	Mail,
	Package,
	Pause,
	ScrollText,
	StickyNote,
} from "lucide-react";
import type { ReactNode } from "react";
import { LIMIT_TONE } from "./game3d-act-stage.tsx";
import { alarmTone } from "./game3d-alarm.tsx";
import { LifeBubbleTag } from "./game3d-life.tsx";
import { queuePlateText } from "./game3d-meters.tsx";
import {
	ActPlateButton,
	type ActTargetKind,
	openerLabel,
	overflowLabel,
} from "./game3d-signs.tsx";
import type { TownActEntry } from "./town-acts.tsx";

/** What the act props need to answer and open cards. */
export interface TownActHandlers {
	clock?: ClockOptions;
	iconOnly: boolean;
	nowMs: number;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	privacy: "full" | "redacted";
	snapshot: InterfaceSnapshot;
}

/** A point label in the town's DOM layer: hung above its anchor point. */
function Anchored({
	anchor,
	children,
	fixed = false,
	interactive,
	rank,
}: {
	anchor: string;
	children: ReactNode;
	/** Held in place: an obstacle the other labels settle round. */
	fixed?: boolean;
	/** False for plain plates (queue plates, status words): no pointer target. */
	interactive: boolean;
	rank: number;
}) {
	return (
		<span
			className={cn(
				"invisible absolute -translate-x-1/2 -translate-y-full",
				interactive ? "pointer-events-auto" : "pointer-events-none"
			)}
			data-anchor={anchor}
			data-fixed={fixed ? "true" : undefined}
			data-hang="above"
			data-rank={rank}
		>
			{children}
		</span>
	);
}

/** Settling rank: queue plates, then targets, then signs, then words. */
function entryRank(entry: TownActEntry): number {
	// An alarm settles first: it stays in its own column over its lot, and
	// the queue's plates slide or stack round it (never over a Tab stop).
	if (entry.kind === "alarm") {
		return 8;
	}
	if (entry.kind === "slot" || entry.kind === "notice") {
		return 7;
	}
	if (entry.kind === "old") {
		return 4;
	}
	if (entry.kind === "text") {
		return entry.overlay === "limit" ||
			entry.anchor.startsWith("act:text:next:")
			? 5
			: 4;
	}
	return 6;
}

/** Alarm plates in the game kit's tokens (no literal colours here). */
const ALARM_CLASS: Record<ReturnType<typeof alarmTone>, string> = {
	amber: LIMIT_TONE,
	calendar: "bg-(--gk-bad) text-(--gk-plate)",
	grey: "bg-(--gk-plate-sunk) text-(--gk-ink)",
	red: "bg-(--gk-bad) text-(--gk-plate)",
};

/** An alarm's icon by tone: a failure, a schedule that failed, a pause. */
const ALARM_ICON: Record<ReturnType<typeof alarmTone>, ReactNode> = {
	amber: <Clock aria-hidden="true" />,
	calendar: <CalendarX aria-hidden="true" />,
	grey: <Pause aria-hidden="true" />,
	red: <span aria-hidden="true">!</span>,
};

const OPENER_ICON: Record<
	"notice" | "suggestion" | "tray" | "unread",
	ReactNode
> = {
	notice: <Mail aria-hidden="true" />,
	suggestion: <StickyNote aria-hidden="true" />,
	tray: <Package aria-hidden="true" />,
	unread: <Mail aria-hidden="true" />,
};

/**
 * The act props as anchored buttons (and the villagers' queue plates as
 * plain plates) in the town's DOM layer, after the building buttons in
 * Tab order. Act props settle before name tags, so they are never the
 * ones hidden in a crowd.
 */
export function TownActProps({
	entries,
	handlers,
}: {
	entries: readonly TownActEntry[];
	handlers: TownActHandlers;
}) {
	const tl = useLiteralMessages();
	const { clock, iconOnly, nowMs, privacy } = handlers;
	return (
		<ul aria-label="What needs you" className="contents">
			{entries.map((entry) => {
				let body: ReactNode = null;
				if (entry.kind === "clock") {
					return (
						<li className="contents" key={entry.anchor}>
							<Anchored
								anchor={entry.anchor}
								fixed
								interactive={false}
								rank={entryRank(entry)}
							>
								<span aria-hidden="true" className="block h-12 w-9" />
							</Anchored>
						</li>
					);
				}
				if (entry.kind === "alarm") {
					const tone = alarmTone(entry.blocker);
					const threadId = entry.threadId;
					body = (
						<ActPlateButton
							className={ALARM_CLASS[tone]}
							focusable
							icon={ALARM_ICON[tone]}
							iconOnly={iconOnly}
							kind="alarm"
							label={blockerAriaLabel(
								entry.blocker,
								entry.agentName,
								nowMs,
								privacy,
								clock
							)}
							onActivate={() => {
								if (threadId) {
									handlers.onBlocker(threadId, entry.agentName);
								}
							}}
						>
							{entry.blocker.source === "estimate"
								? tl("Likely {title}", { title: entry.blocker.title })
								: entry.blocker.title}
						</ActPlateButton>
					);
				} else if (entry.kind === "old") {
					body = (
						<span
							aria-hidden="true"
							className="block size-3 rounded-full border-(--gk-edge) border-2 bg-(--gk-plate-sunk) opacity-70"
						/>
					);
				} else if (entry.kind === "slot") {
					const timer = {
						approx: entry.ask.sinceApprox,
						since: entry.ask.since,
						until: entry.ask.expiresAt ?? null,
						untilApprox: entry.ask.expiresApprox,
					};
					// A pointer target only (tabIndex -1): the building is its
					// keyboard target; a tap here answers too.
					const askId = entry.ask.id;
					body = (
						<button
							aria-hidden="true"
							className="gk-display relative flex h-7 items-center whitespace-nowrap rounded-full border-(--gk-edge) border-2 bg-(--gk-plate) px-2 text-(--gk-ink) text-[12px] shadow-[0_2px_0_var(--gk-edge)]"
							data-you-spot="slot"
							onClick={() => handlers.onAsk(askId)}
							tabIndex={-1}
							type="button"
						>
							{entry.bubble ? <LifeBubbleTag bubble={entry.bubble} /> : null}
							{queuePlateText(entry.agentName, timer, nowMs)}
						</button>
					);
				} else if (entry.kind === "text") {
					body = (
						<span
							aria-hidden="true"
							className={cn(
								"gk-display flex h-6 items-center whitespace-nowrap rounded-lg border-(--gk-edge) border-2 px-2 text-[12px]",
								entry.overlay === "limit"
									? LIMIT_TONE
									: "bg-(--gk-plate) text-(--gk-ink)"
							)}
							data-budgeted-overlay={entry.overlay}
						>
							{entry.text}
						</span>
					);
				} else if (entry.kind === "tally") {
					body = (
						<ActPlateButton
							budgeted="tally"
							focusable
							kind="tally"
							label={overflowLabel(entry.count)}
							onActivate={handlers.onQueue}
							tally="you"
							youSpot="tally"
						>
							{tl("+{count} more", { count: String(entry.count) })}
						</ActPlateButton>
					);
				} else if ("asks" in entry) {
					const first = entry.asks[0];
					if (!first) {
						return null;
					}
					const question =
						entry.kind === "suggestion" && first.kind === "question";
					const timer = {
						approx: first.sinceApprox,
						since: first.since,
						until: first.expiresAt ?? null,
						untilApprox: first.expiresApprox,
					};
					let text: ReactNode = String(entry.asks.length);
					if (entry.kind === "notice") {
						text = queuePlateText(entry.agentName ?? "Inbox", timer, nowMs);
					} else if (entry.kind === "tray") {
						text = entry.count ? (
							<span data-budgeted-overlay="count">{String(entry.count)}</span>
						) : null;
					}
					body = (
						<ActPlateButton
							focusable
							icon={
								question ? (
									<ScrollText aria-hidden="true" />
								) : (
									OPENER_ICON[entry.kind]
								)
							}
							iconOnly={entry.kind === "notice" ? false : iconOnly}
							kind={entry.kind satisfies ActTargetKind}
							label={
								entry.kind === "notice" || entry.kind === "tray"
									? askAriaLabel(first, entry.agentName, nowMs, privacy)
									: openerLabel(entry.asks, entry.agentName, nowMs, privacy)
							}
							onActivate={() => handlers.onAsk(first.id)}
							youSpot={
								entry.kind === "notice"
									? "slot"
									: entry.kind === "tray"
										? "tray"
										: undefined
							}
						>
							{text}
						</ActPlateButton>
					);
				}
				return (
					<li className="contents" key={entry.anchor}>
						<Anchored
							anchor={entry.anchor}
							interactive={!(entry.kind === "text" || entry.kind === "old")}
							// Targets and queue plates are exempt (rank 6+, never hidden);
							// status words and dim marks give way when crowded, the next
							// step and the limit last.
							rank={entryRank(entry)}
						>
							{body}
						</Anchored>
					</li>
				);
			})}
		</ul>
	);
}
