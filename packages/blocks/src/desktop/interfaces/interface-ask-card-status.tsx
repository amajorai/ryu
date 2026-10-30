import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	askAriaLabel,
	askBubble,
	blockerAriaLabel,
	type ClockOptions,
	clockLabel,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceSnapshot,
	waitLabel,
} from "@ryuhq/protocol/interfaces";
import { type ReactNode, useId, useMemo } from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import { type BlockerEntry, blockerEntries } from "./game3d-acts.ts";
import { isolateKeys, plural } from "./interface-ask-card-core.ts";

// ---------------------------------------------------------------------------
// Per-agent status
// ---------------------------------------------------------------------------

const STATUS_BUTTON = cn(
	GAME_FOCUS,
	"inline-flex min-h-6 items-center rounded-full border border-current/40 px-2 font-semibold text-[12px]"
);

/** One counted blocker of an agent, resolved to its thread. */
function useAgentBlockers(
	act: InterfaceAgentAct,
	snapshot: Pick<InterfaceSnapshot, "threads">
): BlockerEntry[] {
	return useMemo(
		() => blockerEntries(snapshot, new Map([[act.agentId, act]])),
		[act, snapshot]
	);
}

/**
 * One agent's short status line, from its act alone: the ask and its wait
 * (with Answer), the step and progress, why it stopped, when its limit
 * resets, its answer (with Open answer); a Details button per stopped run,
 * and what is next.
 */
export function ActStatus({
	act,
	clock,
	nowMs,
	onAsk,
	onBlocker,
	snapshot,
}: {
	act: InterfaceAgentAct;
	clock?: ClockOptions;
	nowMs: number;
	onAsk: (askId: string, opener: HTMLElement) => void;
	onBlocker: (threadId: string, agentName: string, opener: HTMLElement) => void;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const privacy = snapshot.privacy ?? "full";
	const blockers = useAgentBlockers(act, snapshot);
	const parts: ReactNode[] = [];
	const answer = (ask: InterfaceAsk, text: string) => (
		<button
			aria-label={askAriaLabel(ask, act.agentName, nowMs, privacy)}
			className={STATUS_BUTTON}
			key={ask.id}
			onClick={(event) => onAsk(ask.id, event.currentTarget)}
			type="button"
		>
			{text}
		</button>
	);
	switch (act.act) {
		case "asking":
			if (act.ask) {
				const wait = waitLabel(act.ask.since, nowMs, {
					approx: act.ask.sinceApprox,
				});
				parts.push(
					<span key="ask">
						{[askBubble(act.ask, privacy), wait].filter(Boolean).join(" · ")}
					</span>,
					answer(act.ask, "Answer")
				);
			}
			break;
		case "working": {
			const progress = act.progress;
			let count: string | null = null;
			if (progress?.kind === "estimate") {
				count = "~";
			} else if (progress) {
				count = `${progress.done}/${progress.total}`;
			}
			// A stalled act has no bubble: its thread's activity label stands in.
			const label =
				act.bubble?.text ??
				snapshot.threads.find((thread) => thread.id === act.threadId)?.activity
					?.label ??
				null;
			const words = [
				label,
				count,
				act.elapsed,
				act.stalled ? "stalled?" : null,
			].filter(Boolean);
			parts.push(<span key="work">{words.join(" · ")}</span>);
			break;
		}
		case "blocked": {
			const focus = act.blockers[0];
			if (focus) {
				parts.push(
					<span key="stop">
						{[focus.title, privacy === "redacted" ? null : focus.detail]
							.filter(Boolean)
							.join(": ")}
					</span>
				);
			}
			break;
		}
		case "limited": {
			const clears = act.blockers[0]?.clearsAt ?? act.timer?.until ?? null;
			parts.push(
				<span key="limit">
					{clears
						? tl("back {time}", { time: clockLabel(clears, nowMs, clock) })
						: "Limit hit"}
				</span>
			);
			break;
		}
		case "delivering":
			if (act.ask) {
				parts.push(
					<span key="answer">
						{act.bubble?.text ?? askBubble(act.ask, privacy)}
					</span>,
					answer(act.ask, "Open answer")
				);
			}
			break;
		case "waiting":
			parts.push(<span key="wait">Picking this up</span>);
			break;
		default: {
			const pending = act.pending;
			const notes = [
				pending.unread > 0
					? plural(pending.unread, "unread answer", "unread answers")
					: null,
				pending.suggestions > 0
					? plural(pending.suggestions, "suggestion", "suggestions")
					: null,
				pending.old > 0
					? plural(pending.old, "older failure", "older failures")
					: null,
			].filter(Boolean);
			if (notes.length > 0) {
				parts.push(<span key="idle">{notes.join(" · ")}</span>);
			}
			break;
		}
	}
	for (const ask of act.parkedAsks) {
		parts.push(
			<span className="inline-flex items-center gap-1" key={`parked:${ask.id}`}>
				{tl("Ask waiting")}
				{answer(ask, "Answer")}
			</span>
		);
	}
	for (const entry of blockers) {
		parts.push(
			<button
				aria-label={blockerAriaLabel(
					entry.blocker,
					act.agentName,
					nowMs,
					privacy,
					clock
				)}
				className={STATUS_BUTTON}
				data-blocker-thread={entry.threadId}
				key={`blocker:${entry.threadId}`}
				onClick={(event) =>
					onBlocker(entry.threadId, act.agentName, event.currentTarget)
				}
				type="button"
			>
				Details
			</button>
		);
	}
	if (act.next) {
		parts.push(<span key="next">{act.next}</span>);
	}
	if (parts.length === 0) {
		return null;
	}
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: key isolation only.
		<span
			className="flex flex-wrap items-center gap-1.5 text-[12px]"
			data-act-status={act.act}
			onKeyDown={isolateKeys}
		>
			{parts}
		</span>
	);
}

/**
 * One row per agent: the agent's name as its control (described by its
 * act sentence) and its status line. Activating the name answers its ask,
 * opens its stopped run, or opens its thread; with none of those the name
 * is plain text. `revealOnFocus` hides it until a control inside it has
 * focus (beside a canvas with no DOM targets).
 */
export function ActAgentList({
	acts,
	clock,
	nowMs,
	onAsk,
	onBlocker,
	onOpenThread,
	revealOnFocus = false,
	snapshot,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	nowMs: number;
	onAsk: (askId: string, opener: HTMLElement) => void;
	onBlocker: (threadId: string, agentName: string, opener: HTMLElement) => void;
	onOpenThread: (threadId: string) => void;
	revealOnFocus?: boolean;
	snapshot: InterfaceSnapshot;
}) {
	const baseId = useId();
	const entries = useMemo(
		() => blockerEntries(snapshot, acts),
		[acts, snapshot]
	);
	return (
		<ul
			aria-label="Agents"
			className={cn(
				"flex flex-col gap-1.5",
				revealOnFocus &&
					cn(
						GAME_PLATE,
						"pointer-events-auto absolute inset-x-2 top-2 z-40 max-h-[60%] overflow-y-auto p-2.5 [&:not(:focus-within)]:sr-only"
					)
			)}
			data-act-agent-list=""
			data-agent-list=""
			onKeyDown={isolateKeys}
		>
			{[...acts.values()].map((act, index) => {
				const describedBy = `${baseId}-${index}`;
				// The act's focus blocker (act.blockers[0]), not merely the newest.
				const focusBlocker = act.blockers[0];
				const focus =
					entries.find(
						(entry) =>
							entry.agentId === act.agentId && entry.blocker === focusBlocker
					) ?? entries.find((entry) => entry.agentId === act.agentId);
				let activate: ((opener: HTMLElement) => void) | null = null;
				if (act.act === "asking" && act.ask) {
					const askId = act.ask.id;
					activate = (opener) => onAsk(askId, opener);
				} else if ((act.act === "blocked" || act.act === "limited") && focus) {
					activate = (opener) =>
						onBlocker(focus.threadId, act.agentName, opener);
				} else if (act.threadId) {
					const threadId = act.threadId;
					activate = () => onOpenThread(threadId);
				}
				return (
					<li className="flex flex-wrap items-center gap-2" key={act.agentId}>
						<span className="sr-only" id={describedBy}>
							{act.ariaLabel}
						</span>
						{activate ? (
							<button
								aria-describedby={describedBy}
								className={cn(
									GAME_FOCUS,
									"rounded-full px-1.5 font-bold text-[13px]"
								)}
								data-act-agent={act.agentId}
								onClick={(event) => activate?.(event.currentTarget)}
								type="button"
							>
								{act.agentName}
							</button>
						) : (
							<span
								aria-describedby={describedBy}
								className="px-1.5 font-bold text-[13px]"
							>
								{act.agentName}
							</span>
						)}
						<ActStatus
							act={act}
							clock={clock}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							snapshot={snapshot}
						/>
					</li>
				);
			})}
		</ul>
	);
}

/** The game's one act live region: always mounted, read politely. */
export function ActAnnouncer({ sentence }: { sentence: string | null }) {
	return (
		<p aria-live="polite" className="sr-only" data-act-announcer="">
			{sentence ?? ""}
		</p>
	);
}

/** What a host cannot see, said plainly (never "all clear"). */
export function blindSpotText(
	blindSpots: InterfaceSnapshot["askBlindSpots"]
): string | null {
	if (!blindSpots || blindSpots.length === 0) {
		return null;
	}
	return blindSpots.includes("question")
		? "Some questions and prompts only show in their chat"
		: "Some prompts only show in an open chat";
}

/** The visible blind-spot caption under the HUD summary. */
export function BlindSpotCaption({
	className,
	snapshot,
}: {
	className?: string;
	snapshot: Pick<InterfaceSnapshot, "askBlindSpots">;
}) {
	const text = blindSpotText(snapshot.askBlindSpots);
	if (!text) {
		return null;
	}
	return (
		<p
			className={cn(
				GAME_PLATE,
				"pointer-events-auto w-fit max-w-full rounded-xl px-2.5 py-1 font-semibold text-(--gk-ink-muted) text-[12px]",
				className
			)}
			data-blind-spot=""
		>
			{text}
		</p>
	);
}
