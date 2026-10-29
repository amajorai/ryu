import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import {
	Sheet,
	SheetContent,
	SheetTitle,
	SheetTrigger,
} from "@ryu/ui/components/sheet.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	askAriaLabel,
	askBubble,
	askKindWords,
	blockerAriaLabel,
	blockerKindWord,
	type ClockOptions,
	clockLabel,
	compareAsks,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceAskChoice,
	type InterfacePort,
	type InterfaceSnapshot,
	isSuggestion,
	riskTagLabel,
	waitLabel,
} from "@ryuhq/protocol/interfaces";
import { BellRing, ListChecks } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import {
	type ActTotals,
	type BlockerEntry,
	blockerEntries,
	NARROW_STAGE,
} from "./game3d-acts.ts";
import {
	BlockerCard,
	queueButtons,
	resolveReturnFocus,
} from "./interface-blocker-card.tsx";

export { resolveReturnFocus } from "./interface-blocker-card.tsx";

/**
 * The act layer's shared DOM: the ask card (the ONLY place an ask is
 * answered), the ask queue (in-stage, revealed on focus, and as the Queue
 * sheet), the HUD "N need you" and "Queue · N" buttons, the per-agent
 * status line and agent list, the live announcer and the blind-spot
 * caption. Every game renders these outside its Canvas and outside any
 * `role="application"` element. Each root stops keydown propagation, so a
 * game's own key handlers (Escape to step back, digit shortcuts) never see
 * keys pressed inside them; default Tab, Enter and Escape still work.
 *
 * Games open cards through `useActCards`, which also returns focus when a
 * card closes: to its opener if still on the page, else to the next queue
 * button, else to the game's `fallbackFocus` heading, never to the body.
 */

/** Keeps keys pressed inside kit DOM away from the game's own handlers. */
export function isolateKeys(event: KeyboardEvent): void {
	event.stopPropagation();
}

/** Text with backticks and simple markdown removed. */
export function plainText(text: string): string {
	return text
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_#>~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Who owns each ask, by name (null when no agent on the snapshot does). */
export function askOwners(
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Map<string, string> {
	const owners = new Map<string, string>();
	for (const act of acts.values()) {
		const asks = [
			...(act.ask ? [act.ask] : []),
			...act.parkedAsks,
			...act.suggestions,
		];
		for (const ask of asks) {
			owners.set(ask.id, act.agentName);
		}
	}
	return owners;
}

function ownerName(
	ask: InterfaceAsk,
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	owners: ReadonlyMap<string, string>
): string | null {
	const owned = owners.get(ask.id);
	if (owned) {
		return owned;
	}
	if (ask.agentId) {
		return acts.get(ask.agentId)?.agentName ?? null;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Card controller
// ---------------------------------------------------------------------------

/** A card a game can open: an ask, or a stopped run's blocker. */
export type ActCardRequest =
	| { askId: string; kind: "ask" }
	| { agentName: string; kind: "blocker"; threadId: string };

interface OpenCard {
	opener: HTMLElement | null;
	/** The opener's place in the ask queue, for "the next queue button". */
	queueIndex: number;
	request: ActCardRequest;
}

/**
 * Opens ask and blocker cards for a game. `openAsk(askId)` and
 * `openBlocker(threadId, agentName)` remember the focused element as the
 * opener; render `element` once, anywhere in the game's DOM.
 */
export function useActCards({
	clock,
	fallbackFocus,
	nowMs,
	port,
	snapshot,
	acts,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	fallbackFocus: RefObject<HTMLElement | null>;
	nowMs: number;
	port: InterfacePort;
	snapshot: InterfaceSnapshot;
}): {
	element: ReactNode;
	openAsk: (askId: string, opener?: HTMLElement | null) => void;
	openBlocker: (
		threadId: string,
		agentName: string,
		opener?: HTMLElement | null
	) => void;
} {
	const [open, setOpen] = useState<OpenCard | null>(null);
	const show = useCallback(
		(request: ActCardRequest, opener?: HTMLElement | null) => {
			const from =
				opener ??
				(typeof document === "undefined"
					? null
					: (document.activeElement as HTMLElement | null));
			const index = from ? queueButtons().indexOf(from) : -1;
			setOpen({ opener: from, queueIndex: index, request });
		},
		[]
	);
	const openAsk = useCallback(
		(askId: string, opener?: HTMLElement | null) =>
			show({ askId, kind: "ask" }, opener),
		[show]
	);
	const openBlocker = useCallback(
		(threadId: string, agentName: string, opener?: HTMLElement | null) =>
			show({ agentName, kind: "blocker", threadId }, opener),
		[show]
	);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const close = useCallback(() => setOpen(null), []);
	let element: ReactNode = null;
	if (open?.request.kind === "ask") {
		const askId = open.request.askId;
		const ask = snapshot.asks?.find((item) => item.id === askId);
		element = (
			<AskCard
				askId={askId}
				clock={clock}
				fallbackFocus={fallbackFocus}
				key={askId}
				nowMs={nowMs}
				onClose={close}
				opener={open.opener}
				ownerName={ask ? ownerName(ask, acts, owners) : null}
				port={port}
				queueIndex={open.queueIndex}
				snapshot={snapshot}
			/>
		);
	} else if (open?.request.kind === "blocker") {
		element = (
			<BlockerCard
				agentName={open.request.agentName}
				clock={clock}
				fallbackFocus={fallbackFocus}
				key={open.request.threadId}
				nowMs={nowMs}
				onClose={close}
				opener={open.opener}
				port={port}
				queueIndex={open.queueIndex}
				snapshot={snapshot}
				threadId={open.request.threadId}
			/>
		);
	}
	return { element, openAsk, openBlocker };
}

// ---------------------------------------------------------------------------
// Ask card
// ---------------------------------------------------------------------------

/** The card's expiry line: "Expires in 7m", "Expires in up to 7m". */
export function expiryText(ask: InterfaceAsk, nowMs: number): string | null {
	if (!ask.expiresAt) {
		return null;
	}
	const left = waitLabel(ask.since ?? ask.expiresAt, nowMs, {
		until: ask.expiresAt,
	});
	if (!left) {
		return null;
	}
	const span = left.replace(/^in /, "").replace(/^≤ ?/, "");
	return ask.expiresApprox ? `Expires in up to ${span}` : `Expires in ${span}`;
}

/** The card's age line: "Waited 14m", "Waited ~7m". */
export function ageText(ask: InterfaceAsk, nowMs: number): string | null {
	const age = waitLabel(ask.since, nowMs, { approx: ask.sinceApprox });
	return age ? `Waited ${age}` : null;
}

/** The card's first line: who asks, offers an answer, or suggests. */
export function askerLine(ask: InterfaceAsk, owner: string | null): string {
	const who = owner ?? "Inbox";
	if (ask.kind === "reply") {
		return `${who} has an answer ready`;
	}
	if (isSuggestion(ask)) {
		return ask.kind === "question"
			? `${who} has a question when you have time`
			: `${who} suggests`;
	}
	return `${who} asks`;
}

/** What makes an ask "changed in place" (cancels a pending confirm). */
function askShape(ask: InterfaceAsk | undefined): string {
	if (!ask) {
		return "";
	}
	return JSON.stringify([ask.text, ask.choices, ask.expiresAt]);
}

/**
 * The ask card: what is asked, why, how long it has waited and until when,
 * its target and up to 2 risk tags, then the choices. A destructive
 * choice asks "Confirm …?" first. It reads the ask from the live snapshot:
 * when the ask leaves it, the card says "No longer waiting" and only Close
 * works. Under redaction it offers Open only. Tool arguments are never
 * shown, only the host's short target.
 */
export function AskCard({
	askId,
	clock: _clock,
	fallbackFocus,
	nowMs,
	onClose,
	opener = null,
	ownerName: owner,
	port,
	queueIndex = -1,
	snapshot,
}: {
	askId: string;
	clock?: ClockOptions;
	/** The game's focusable heading: where focus lands when nothing else is left. */
	fallbackFocus: RefObject<HTMLElement | null>;
	nowMs: number;
	onClose: () => void;
	/** The control that opened the card; focus returns to it while it exists. */
	opener?: HTMLElement | null;
	ownerName: string | null;
	port: InterfacePort;
	/** The opener's place in the ask queue (-1 when it is not a queue button). */
	queueIndex?: number;
	snapshot: InterfaceSnapshot;
}) {
	const live = snapshot.asks?.find((item) => item.id === askId);
	const last = useRef<InterfaceAsk | undefined>(live);
	if (live) {
		last.current = live;
	}
	const ask = live ?? last.current;
	const stale = !live;
	const staleRef = useRef(stale);
	staleRef.current = stale;
	const redacted = snapshot.privacy === "redacted";
	const [confirming, setConfirming] = useState<InterfaceAskChoice | null>(null);
	const [answering, setAnswering] = useState(false);
	const [failed, setFailed] = useState(false);
	const openRef = useRef<HTMLButtonElement>(null);
	const firstSafeRef = useRef<HTMLButtonElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const confirmedRef = useRef<string | null>(null);
	const promptId = useId();
	const shape = askShape(live);
	const shapeRef = useRef(shape);
	// An ask changed in place, or details just got hidden: drop the confirm
	// step so a stale destructive choice can never fire.
	useEffect(() => {
		if (shapeRef.current !== shape || redacted || stale) {
			setConfirming(null);
		}
		shapeRef.current = shape;
	}, [redacted, shape, stale]);
	useEffect(() => {
		if (stale) {
			if (answering) {
				// The ask left while we were answering it: that is success.
				onClose();
				return;
			}
			closeRef.current?.focus();
		}
	}, [answering, onClose, stale]);
	// Into the confirm step: focus Cancel. Out of it (Cancel, a stale ask,
	// an in-place change, details hidden): back to the choice that asked,
	// or Close when that choice is gone or disabled.
	useEffect(() => {
		if (confirming) {
			confirmedRef.current = confirming.id;
			cancelRef.current?.focus();
			return;
		}
		const asked = confirmedRef.current;
		if (asked === null) {
			return;
		}
		confirmedRef.current = null;
		const choice = bodyRef.current?.querySelector<HTMLButtonElement>(
			`[data-choice="${CSS.escape(asked)}"]`
		);
		if (staleRef.current) {
			// "No longer waiting": Close is the only thing left to do.
			closeRef.current?.focus();
		} else if (choice && !choice.disabled) {
			choice.focus();
		} else {
			(openRef.current ?? closeRef.current)?.focus();
		}
	}, [confirming]);
	if (!ask) {
		return null;
	}
	const canOpen = ask.threadId ? true : Boolean(port.openInbox);
	const choices = redacted || !port.answerAsk ? [] : (ask.choices ?? []);
	const firstSafe = choices.find((choice) => !choice.destructive);
	const answer = async (choice: InterfaceAskChoice) => {
		if (stale || redacted || !port.answerAsk) {
			return;
		}
		setAnswering(true);
		setFailed(false);
		try {
			await port.answerAsk(ask.id, choice.id);
			onClose();
		} catch {
			setFailed(true);
		} finally {
			setAnswering(false);
		}
	};
	const choose = (choice: InterfaceAskChoice) => {
		if (choice.destructive) {
			setConfirming(choice);
			return;
		}
		answer(choice);
	};
	const openIt = () => {
		if (ask.threadId) {
			port.openThread(ask.threadId);
		} else {
			port.openInbox?.();
		}
		onClose();
	};
	const tags = (ask.riskTags ?? []).slice(0, 2).map(riskTagLabel);
	const age = ageText(ask, nowMs);
	const expiry = expiryText(ask, nowMs);
	const title = redacted ? askKindWords(ask) : plainText(ask.text);
	return (
		<Dialog
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			open
		>
			<DialogContent
				className="max-sm:[&[data-ask-card]]:!inset-x-[20px] max-sm:[&[data-ask-card]]:!bottom-[20px] max-sm:[&[data-ask-card]]:!w-auto max-sm:[&[data-ask-card]]:!rounded-4xl max-w-[calc(100%-2rem)] gap-3 max-sm:px-4 sm:max-w-md"
				data-ask-card=""
				finalFocus={() =>
					resolveReturnFocus(opener, queueIndex, fallbackFocus) ?? true
				}
				initialFocus={() =>
					openRef.current ?? firstSafeRef.current ?? closeRef.current ?? true
				}
				onKeyDown={isolateKeys}
				showCloseButton={false}
			>
				<div className="contents" ref={bodyRef}>
					<p className="font-medium text-muted-foreground text-xs">
						{askerLine(ask, owner)}
					</p>
					<DialogTitle className="text-lg leading-snug">{title}</DialogTitle>
					<DialogDescription className="flex flex-col gap-1">
						{!redacted && ask.reason ? (
							<span>{plainText(ask.reason)}</span>
						) : null}
						<span>{[age, expiry].filter(Boolean).join(" · ")}</span>
					</DialogDescription>
					{!redacted && ask.target ? (
						<p className="text-sm">{`Target: ${ask.target}`}</p>
					) : null}
					{tags.length > 0 ? (
						<ul aria-label="Risk" className="flex flex-wrap gap-1.5">
							{tags.map((tag) => (
								<li
									className="rounded-full bg-muted px-2 py-0.5 text-xs"
									key={tag}
								>
									{tag}
								</li>
							))}
						</ul>
					) : null}
					{redacted ? (
						<p className="text-sm">
							Details are hidden while work details are hidden. Open to answer.
						</p>
					) : null}
					{stale ? (
						<p className="font-medium text-sm" role="status">
							No longer waiting
						</p>
					) : null}
					{failed ? (
						<p className="text-destructive text-sm" role="alert">
							That answer did not go through. Open the chat to answer there.
						</p>
					) : null}
					{confirming ? (
						<div
							aria-labelledby={promptId}
							className="flex flex-wrap items-center gap-2"
							data-ask-confirm=""
							role="group"
						>
							<span className="text-sm" id={promptId}>
								{`Confirm ${confirming.label}?`}
							</span>
							<Button
								aria-describedby={promptId}
								disabled={stale || answering}
								onClick={() => answer(confirming)}
								size="sm"
								variant="destructive"
							>
								{`Confirm ${confirming.label}`}
							</Button>
							<Button
								aria-describedby={promptId}
								onClick={() => setConfirming(null)}
								ref={cancelRef}
								size="sm"
								variant="outline"
							>
								Cancel
							</Button>
						</div>
					) : null}
					<div className="flex flex-wrap gap-2">
						{choices.map((choice) => (
							<Button
								data-choice={choice.id}
								disabled={stale || answering}
								key={choice.id}
								onClick={() => choose(choice)}
								ref={choice === firstSafe ? firstSafeRef : undefined}
								size="sm"
								variant={choice.tone === "deny" ? "outline" : "default"}
							>
								{choice.label}
							</Button>
						))}
						{canOpen ? (
							<Button
								onClick={openIt}
								ref={openRef}
								size="sm"
								variant="secondary"
							>
								Open
							</Button>
						) : null}
						<Button onClick={onClose} ref={closeRef} size="sm" variant="ghost">
							Close
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

// ---------------------------------------------------------------------------
// Ask queue
// ---------------------------------------------------------------------------

/** "3 asks need you", "1 ask needs you". */
export function needYouHeading(count: number): string {
	return count === 1 ? "1 ask needs you" : `${count} asks need you`;
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** The queue's four groups, in order (empty groups are left out). */
export interface AskQueueGroups {
	answers: InterfaceAsk[];
	blocking: InterfaceAsk[];
	stopped: BlockerEntry[];
	suggestions: InterfaceAsk[];
}

export function askQueueGroups(
	snapshot: InterfaceSnapshot,
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	unowned: readonly InterfaceAsk[]
): AskQueueGroups {
	const asks = [...(snapshot.asks ?? [])];
	for (const ask of unowned) {
		if (!asks.some((item) => item.id === ask.id)) {
			asks.push(ask);
		}
	}
	const since = (ask: InterfaceAsk) =>
		ask.since ? Date.parse(ask.since) : Number.NEGATIVE_INFINITY;
	return {
		answers: asks
			.filter((ask) => ask.kind === "reply")
			.sort((a, b) => since(b) - since(a) || (a.id < b.id ? -1 : 1)),
		blocking: asks.filter((ask) => ask.blocking).sort(compareAsks),
		stopped: blockerEntries(snapshot, acts),
		suggestions: asks.filter((ask) => isSuggestion(ask)).sort(compareAsks),
	};
}

/** Items shown in a capped group before "Show N more". */
export const QUEUE_GROUP_CAP = 5;

function QueueGroup({
	children,
	count,
	heading,
	capped,
}: {
	capped: boolean;
	children: (limit: number) => ReactNode;
	count: number;
	heading: string;
}) {
	const [expanded, setExpanded] = useState(false);
	const headingId = useId();
	const listRef = useRef<HTMLOListElement>(null);
	const revealFrom = useRef<number | null>(null);
	useEffect(() => {
		if (count <= QUEUE_GROUP_CAP) {
			setExpanded(false);
		}
	}, [count]);
	// "Show N more" leaves the page when pressed: hand focus to the first
	// item it revealed, so focus never falls to the body.
	useEffect(() => {
		if (!expanded || revealFrom.current === null) {
			return;
		}
		const items = listRef.current?.querySelectorAll<HTMLElement>("button");
		items?.[revealFrom.current]?.focus();
		revealFrom.current = null;
	}, [expanded]);
	if (count === 0) {
		return null;
	}
	const limit = capped && !expanded ? QUEUE_GROUP_CAP : count;
	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-1">
			<h3
				className="font-semibold text-(--gk-ink-muted) text-[12px] uppercase tracking-wide"
				id={headingId}
			>
				{heading}
			</h3>
			<ol className="flex flex-wrap gap-1.5" ref={listRef}>
				{children(limit)}
			</ol>
			{count > limit ? (
				<button
					className={cn(
						GAME_FOCUS,
						"self-start rounded-full px-2 py-1 font-semibold text-[12px] underline"
					)}
					onClick={() => {
						revealFrom.current = limit;
						setExpanded(true);
					}}
					type="button"
				>
					{`Show ${count - limit} more`}
				</button>
			) : null}
		</section>
	);
}

const QUEUE_BUTTON = cn(
	GAME_PLATE,
	GAME_FOCUS,
	"min-h-7 max-w-64 truncate rounded-full px-2.5 text-start font-semibold text-[12px] leading-6"
);

/**
 * Everything waiting on the user, as buttons, in four groups: blocking
 * asks (all of them), stopped runs, suggestions and unread answers (the
 * last three capped at 5 with "Show N more"). Each ask button is named by
 * `askAriaLabel`, each stopped run by `blockerAriaLabel`, and opens its
 * card. `reveal` (in the stage) is visually hidden until a button inside
 * has focus, then shows as a plate strip; `sheet` is always visible.
 */
export function AskQueueList({
	acts,
	clock,
	fallbackFocus,
	mode = "reveal",
	nowMs,
	onAsk,
	onBlocker,
	snapshot,
	unowned,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	/**
	 * The game's focusable heading: where focus goes when the item that had
	 * it leaves the list (answered elsewhere) and nothing is left to take it.
	 */
	fallbackFocus?: RefObject<HTMLElement | null>;
	mode?: "reveal" | "sheet";
	nowMs: number;
	onAsk: (askId: string, opener: HTMLElement) => void;
	onBlocker: (threadId: string, agentName: string, opener: HTMLElement) => void;
	snapshot: InterfaceSnapshot;
	unowned: readonly InterfaceAsk[];
}) {
	const privacy = snapshot.privacy ?? "full";
	const groups = useMemo(
		() => askQueueGroups(snapshot, acts, unowned),
		[acts, snapshot, unowned]
	);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const navRef = useRef<HTMLElement>(null);
	const focusInside = useRef(false);
	// The focused item left the list: keep focus in the queue (its first
	// item), or on the game's heading when the queue emptied.
	useEffect(() => {
		if (!focusInside.current || typeof document === "undefined") {
			return;
		}
		const active = document.activeElement;
		if (active && active !== document.body && active.isConnected) {
			return;
		}
		focusInside.current = false;
		const first = navRef.current?.querySelector<HTMLElement>(
			"[data-ask-queue-item]"
		);
		(first ?? fallbackFocus?.current)?.focus();
	});
	const askButton = (ask: InterfaceAsk) => {
		const owner = ownerName(ask, acts, owners);
		return (
			<li key={ask.id}>
				<button
					aria-label={askAriaLabel(ask, owner, nowMs, privacy)}
					className={QUEUE_BUTTON}
					data-ask-id={ask.id}
					data-ask-queue-item=""
					onClick={(event) => onAsk(ask.id, event.currentTarget)}
					type="button"
				>
					{`${owner ?? "Inbox"}: ${askBubble(ask, privacy)}`}
				</button>
			</li>
		);
	};
	const total =
		groups.blocking.length +
		groups.stopped.length +
		groups.suggestions.length +
		groups.answers.length;
	if (total === 0) {
		return null;
	}
	return (
		<nav
			aria-label="Ask queue"
			className={cn(
				"flex flex-col gap-2",
				mode === "reveal" &&
					cn(
						GAME_PLATE,
						"pointer-events-auto absolute inset-x-2 top-2 z-40 max-h-[60%] overflow-y-auto p-2.5 [&:not(:focus-within)]:sr-only"
					)
			)}
			data-ask-queue={mode}
			onBlur={(event) => {
				focusInside.current = navRef.current?.contains(
					event.relatedTarget as Node | null
				)
					? true
					: event.relatedTarget === null;
			}}
			onFocus={() => {
				focusInside.current = true;
			}}
			onKeyDown={(event) => {
				// In the Queue sheet or popover, Escape goes on to the container,
				// which closes it and isolates the key from the game.
				if (mode === "sheet" && event.key === "Escape") {
					return;
				}
				isolateKeys(event);
			}}
			ref={navRef}
		>
			<QueueGroup
				capped={false}
				count={groups.blocking.length}
				heading={needYouHeading(groups.blocking.length)}
			>
				{(limit) => groups.blocking.slice(0, limit).map(askButton)}
			</QueueGroup>
			<QueueGroup
				capped
				count={groups.stopped.length}
				heading={plural(groups.stopped.length, "run stopped", "runs stopped")}
			>
				{(limit) =>
					groups.stopped.slice(0, limit).map((entry) => (
						<li key={entry.threadId}>
							<button
								aria-label={blockerAriaLabel(
									entry.blocker,
									entry.agentName,
									nowMs,
									privacy,
									clock
								)}
								className={QUEUE_BUTTON}
								data-ask-queue-item=""
								data-blocker-thread={entry.threadId}
								onClick={(event) =>
									onBlocker(
										entry.threadId,
										entry.agentName,
										event.currentTarget
									)
								}
								type="button"
							>
								{`${entry.agentName}: ${
									privacy === "redacted"
										? blockerKindWord(entry.blocker.kind)
										: entry.blocker.title
								}`}
							</button>
						</li>
					))
				}
			</QueueGroup>
			<QueueGroup
				capped
				count={groups.suggestions.length}
				heading={plural(groups.suggestions.length, "suggestion", "suggestions")}
			>
				{(limit) => groups.suggestions.slice(0, limit).map(askButton)}
			</QueueGroup>
			<QueueGroup
				capped
				count={groups.answers.length}
				heading={plural(groups.answers.length, "answer ready", "answers ready")}
			>
				{(limit) => groups.answers.slice(0, limit).map(askButton)}
			</QueueGroup>
		</nav>
	);
}

// ---------------------------------------------------------------------------
// HUD buttons
// ---------------------------------------------------------------------------

const HUD_ACTION = cn(
	"gk-action gk-display pointer-events-auto inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-2xl bg-(--gk-accent) ps-4 pe-5 text-(--gk-accent-ink) text-[18px] [&_svg]:size-5 [&_svg]:shrink-0",
	GAME_FOCUS
);

/** "3 need you": opens the card of the first ask in queue order. */
export function NeedYouButton({
	onAsk,
	snapshot,
	totals,
}: {
	onAsk: (askId: string, opener: HTMLElement) => void;
	snapshot: Pick<InterfaceSnapshot, "asks">;
	totals: Pick<ActTotals, "needYou">;
}) {
	const first = (snapshot.asks ?? [])
		.filter((ask) => ask.blocking)
		.sort(compareAsks)[0];
	if (!first || totals.needYou === 0) {
		return null;
	}
	return (
		<button
			className={HUD_ACTION}
			data-need-you=""
			onClick={(event) => onAsk(first.id, event.currentTarget)}
			onKeyDown={isolateKeys}
			type="button"
		>
			<BellRing aria-hidden="true" />
			{`${totals.needYou} need you`}
		</button>
	);
}

function useNarrow(narrow: boolean | undefined): boolean {
	const [wide, setWide] = useState(true);
	useEffect(() => {
		if (
			narrow !== undefined ||
			typeof window === "undefined" ||
			!window.matchMedia
		) {
			return;
		}
		const query = window.matchMedia(`(min-width: ${NARROW_STAGE}px)`);
		const update = () => setWide(query.matches);
		update();
		query.addEventListener?.("change", update);
		return () => query.removeEventListener?.("change", update);
	}, [narrow]);
	return narrow ?? !wide;
}

/**
 * Opens the Queue sheet through a `QueueButton`'s `openRef` (for tallies);
 * without one (no queue button on the page), moves focus into the in-stage
 * queue so the tap still leads somewhere.
 */
export function openQueue(openRef: RefObject<(() => void) | null>): void {
	if (openRef.current) {
		openRef.current();
		return;
	}
	if (typeof document === "undefined") {
		return;
	}
	document
		.querySelector<HTMLElement>(
			"[data-ask-queue='reveal'] [data-ask-queue-item]"
		)
		?.focus();
}

/**
 * "Queue · N": the visible, tappable path to everything in the queue (N =
 * blocking asks + stopped runs + suggestions + unread answers). Opens the
 * queue as a popover, or a bottom sheet on narrow stages; choosing an
 * item closes it and opens that card, and focus comes back here after.
 * Absent when N is 0.
 */
export function QueueButton({
	acts,
	clock,
	narrow,
	nowMs,
	onAsk,
	onBlocker,
	snapshot,
	totals,
	unowned,
	openRef,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	narrow?: boolean;
	nowMs: number;
	onAsk: (askId: string, opener: HTMLElement) => void;
	onBlocker: (threadId: string, agentName: string, opener: HTMLElement) => void;
	/** Lets a tally plate open this sheet. */
	openRef?: RefObject<(() => void) | null>;
	snapshot: InterfaceSnapshot;
	totals: Pick<ActTotals, "queue">;
	unowned: readonly InterfaceAsk[];
}) {
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const isNarrow = useNarrow(narrow);
	const empty = totals.queue === 0;
	useEffect(() => {
		if (empty) {
			// Nothing to show: no opener for tallies, and never pop up later.
			setOpen(false);
			if (openRef) {
				openRef.current = null;
			}
			return;
		}
		if (!openRef) {
			return;
		}
		openRef.current = () => setOpen(true);
		return () => {
			openRef.current = null;
		};
	}, [empty, openRef]);
	if (empty) {
		return null;
	}
	const label = `Queue · ${totals.queue}`;
	// The kit stops key propagation inside its DOM, which also keeps Escape
	// from the dismiss listener on the document: close on Escape here.
	const keepKeys = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			setOpen(false);
		}
		isolateKeys(event);
	};
	const list = (
		<AskQueueList
			acts={acts}
			clock={clock}
			mode="sheet"
			nowMs={nowMs}
			onAsk={(askId) => {
				setOpen(false);
				onAsk(askId, trigger.current ?? document.body);
			}}
			onBlocker={(threadId, agentName) => {
				setOpen(false);
				onBlocker(threadId, agentName, trigger.current ?? document.body);
			}}
			snapshot={snapshot}
			unowned={unowned}
		/>
	);
	const button = (
		<button
			className={HUD_ACTION}
			data-queue-button=""
			onKeyDown={isolateKeys}
			ref={trigger}
			type="button"
		>
			<ListChecks aria-hidden="true" />
			{label}
		</button>
	);
	if (isNarrow) {
		return (
			<Sheet onOpenChange={setOpen} open={open}>
				<SheetTrigger render={button} />
				<SheetContent
					className="gap-3 p-4 pb-6"
					onKeyDown={keepKeys}
					side="bottom"
				>
					<SheetTitle>Queue</SheetTitle>
					{list}
				</SheetContent>
			</Sheet>
		);
	}
	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger render={button} />
			<PopoverContent
				align="end"
				className="w-96 max-w-[calc(100vw-2rem)]"
				onKeyDown={keepKeys}
			>
				{list}
			</PopoverContent>
		</Popover>
	);
}

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
					{clears ? `back ${clockLabel(clears, nowMs, clock)}` : "Limit hit"}
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
				Ask waiting
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
