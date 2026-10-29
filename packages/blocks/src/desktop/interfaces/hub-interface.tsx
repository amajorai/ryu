import { cn } from "@ryu/ui/lib/utils";
import { type InterfaceEvent, localDayKey } from "@ryuhq/protocol/interfaces";
import { AnimatePresence, motion } from "motion/react";
import {
	type CSSProperties,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { HubAmbient } from "./hub-ambient.tsx";
import { HubBackdrop } from "./hub-backdrop.tsx";
import { HubSkeletonCard } from "./hub-card.tsx";
import {
	HubAttentionCard,
	HubUpcomingCard,
	HubWaitingCard,
	HubWorkingCard,
} from "./hub-cards.tsx";
import { HubAgentsCard, HubComposeCard } from "./hub-compose.tsx";
import {
	HUB_CARD_LABELS,
	HUB_CARDS,
	HUB_IDLE_MS,
	type HubKeyAction,
	hubAgentRuns,
	hubAgents,
	hubClock,
	hubClockDateTime,
	hubComposeAgents,
	hubCounts,
	hubDate,
	hubFailedRuns,
	hubGlyph,
	hubGlyphCount,
	hubGreeting,
	hubKeyAction,
	hubStatusParts,
	hubThreads,
	hubTopicPrompt,
	hubUpcoming,
	hubWithFailedRuns,
	isHubTypingTarget,
	stepHubCard,
} from "./hub-model.ts";
import {
	HUB_EASE,
	HubStatusLine,
	HubThreadSheet,
	useHubClock,
} from "./hub-parts.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

interface HubStyle extends CSSProperties {
	"--hub-card": string;
	"--hub-card-h": string;
	"--hub-card-wide": string;
	"--hub-gutter": string;
}

const HUB_STYLE: HubStyle = {
	"--hub-card": "min(calc(100cqw - 3rem), clamp(20rem, 29cqw, 26rem))",
	// One height for every card: the room under the header and above the
	// dots, capped so a tall screen does not stretch the cards into posters.
	"--hub-card-h": "clamp(17rem, calc(100cqh - 14rem), 34rem)",
	// The last card fills what the card before it leaves, so at the end of the
	// row both rest between the gutters and nothing is clipped.
	"--hub-card-wide":
		"min(56rem, max(min(calc(100cqw - 3rem), clamp(20rem, 40cqw, 36rem)), calc(100cqw - 2 * var(--hub-gutter) - var(--hub-card) - 1rem)))",
	"--hub-gutter": "clamp(1.5rem, 5cqw, 4.5rem)",
};

/** Mouse travel before a press on the cards becomes a drag. */
const DRAG_PX = 6;
/**
 * Longest a programmatic scroll owns the active card. It normally releases as
 * soon as the row arrives; this only covers a scroll the user interrupts.
 */
const SCROLL_SETTLE_MS = 2000;
/** When a smooth scroll that has not arrived is finished without animation. */
const SCROLL_ASSERT_MS = 900;

/** Mark which ends of the row have cards cut off, for the edge fades. */
function markTrackEdges(track: HTMLElement) {
	const start = track.scrollLeft > 1;
	const end = track.scrollLeft + track.clientWidth < track.scrollWidth - 1;
	track.dataset.edgeStart = String(start);
	track.dataset.edgeEnd = String(end);
}

/** Automation and reduced motion keep the cards up until someone leaves. */
function idleTimeoutEnabled(reduceMotion: boolean | null): boolean {
	if (reduceMotion) {
		return false;
	}
	return !(typeof navigator !== "undefined" && navigator.webdriver);
}

function PageDots({
	active,
	hidden,
	onSelect,
}: {
	active: number;
	hidden: boolean;
	onSelect: (index: number) => void;
}) {
	return (
		<nav
			aria-label="Cards"
			className={cn(
				// The hit areas are 44px tall; pull the row up so the dots sit
				// about 32px under the cards.
				"-mt-3 flex items-center justify-center transition-opacity duration-200 motion-reduce:transition-none",
				hidden && "invisible opacity-0"
			)}
		>
			{HUB_CARDS.map((card, index) => {
				const current = index === active;
				return (
					<button
						aria-current={current ? "true" : undefined}
						aria-label={HUB_CARD_LABELS[card]}
						className="group flex h-11 items-center justify-center px-2 outline-none"
						key={card}
						onClick={() => onSelect(index)}
						title={HUB_CARD_LABELS[card]}
						type="button"
					>
						<span
							className={cn(
								"block h-2 rounded-full transition-[width,background-color] duration-300 group-focus-visible:ring-3 group-focus-visible:ring-ring/40 motion-reduce:transition-none",
								current
									? "w-6 bg-foreground"
									: "w-2 bg-foreground/25 group-hover:bg-foreground/45"
							)}
						/>
					</button>
				);
			})}
		</nav>
	);
}

/**
 * Hub: Ryu as a smart display. It rests on an ambient screen (a calm picture,
 * a large clock, and one line of what needs you); a tap or Enter wakes it
 * into a row of large glanceable cards you swipe, drag, or arrow through.
 * Threads open in a full-height sheet holding the host's conversation.
 */
export function HubInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const reduceMotion = useReducedMotion();
	const now = useHubClock();
	const isOpen = threadView !== null && threadView !== undefined;
	const [awakeState, setAwake] = useState(isOpen);
	const awake = awakeState || isOpen;
	const [active, setActive] = useState(0);
	const [composeAgentId, setComposeAgentId] = useState<string>();
	const [composeTopic, setComposeTopic] = useState<string>();
	// Keys can arrive faster than React commits (a wake, then a run of
	// arrows); these refs carry the latest state between renders.
	const awakeRef = useRef(awake);
	awakeRef.current = awake;
	const activeRef = useRef(active);

	const rootRef = useRef<HTMLDivElement>(null);
	const sheetRef = useRef<HTMLElement>(null);
	/** The last control focused outside the sheet: where focus returns. */
	const returnFocusRef = useRef<HTMLElement | null>(null);
	const trackRef = useRef<HTMLDivElement>(null);
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	const cardRefs = useRef<(HTMLElement | null)[]>([]);
	const scrollTargetRef = useRef<{ left: number; until: number } | null>(null);
	const activityRef = useRef(Date.now());
	const dragRef = useRef<{
		dragging: boolean;
		scrollLeft: number;
		x: number;
	} | null>(null);
	const suppressClickRef = useRef(false);
	const pendingScrollRef = useRef<number | null>(null);
	const [scrollRequest, setScrollRequest] = useState(0);

	const failedRuns = useMemo(
		() => hubFailedRuns(snapshot.events, now),
		[snapshot.events, now]
	);
	const model = useMemo(() => {
		// Failed scheduled runs count as needing attention everywhere, so the
		// line, the glyph, and the card all give the same number.
		const counts = hubWithFailedRuns(hubCounts(snapshot), failedRuns);
		const glyph = hubGlyph(counts);
		// One source for who is live, so the cards never contradict the line.
		const runs = hubAgentRuns(snapshot);
		return {
			agents: hubAgents(snapshot, runs),
			attention: hubThreads(snapshot, "attention"),
			// Chips keep a stable, alphabetical order; the default pick is the
			// first agent free to start now.
			composeAgents: [...snapshot.agents].sort((a, b) =>
				a.name.localeCompare(b.name)
			),
			composeDefault: hubComposeAgents(snapshot, runs)[0]?.id,
			glyph,
			glyphCount: hubGlyphCount(glyph, counts),
			runs,
			statusParts: hubStatusParts(counts, snapshot),
			waiting: hubThreads(snapshot, "your-turn"),
			working: hubThreads(snapshot, "working"),
		};
	}, [snapshot, failedRuns]);
	const upcoming = useMemo(
		() => hubUpcoming(snapshot.events, now),
		[snapshot.events, now]
	);
	const openThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const clock = hubClock(now);
	const clockText = [clock.time, clock.dayPeriod].filter(Boolean).join(" ");
	const dayKey = localDayKey(new Date(now));

	const scrollToCard = (index: number) => {
		const track = trackRef.current;
		const card = cardRefs.current[index];
		if (!(track && card)) {
			return;
		}
		const gutter = Number.parseFloat(getComputedStyle(track).paddingLeft) || 0;
		const maxLeft = Math.max(0, track.scrollWidth - track.clientWidth);
		const left = Math.min(maxLeft, Math.max(0, card.offsetLeft - gutter));
		const target = { left, until: Date.now() + SCROLL_SETTLE_MS };
		scrollTargetRef.current = target;
		track.scrollTo?.({ behavior: reduceMotion ? "auto" : "smooth", left });
		// A smooth scroll can be cut short (a retarget mid-flight, a busy main
		// thread); if this one has not landed by now, put the row there.
		window.setTimeout(() => {
			if (scrollTargetRef.current === target) {
				settleTrack(track);
			}
		}, SCROLL_ASSERT_MS);
	};

	const settleTrack = (track: HTMLElement) => {
		const target = scrollTargetRef.current;
		if (!target || Math.abs(track.scrollLeft - target.left) <= 2) {
			return;
		}
		track.scrollTo?.({ behavior: "auto", left: target.left });
	};

	const goTo = (index: number, focus = true) => {
		const next = stepHubCard(index, 0);
		activeRef.current = next;
		setActive(next);
		// Scroll once the row has rendered: a key pressed right after waking
		// arrives before the cards have mounted.
		pendingScrollRef.current = next;
		setScrollRequest((request) => request + 1);
		// Keyboard focus follows the card only once it is already among the
		// cards; arrows from the page move the row without a focus ring.
		const focused = document.activeElement;
		if (focus && focused && trackRef.current?.contains(focused)) {
			cardRefs.current[next]?.focus({ preventScroll: true });
		}
	};

	const scrollToCardRef = useRef(scrollToCard);
	scrollToCardRef.current = scrollToCard;
	useEffect(() => {
		const pending = pendingScrollRef.current;
		if (scrollRequest === 0 || pending === null || !awake || loading) {
			return;
		}
		if (!cardRefs.current[pending]) {
			return;
		}
		pendingScrollRef.current = null;
		scrollToCardRef.current(pending);
	}, [awake, loading, scrollRequest]);

	const wake = () => {
		activityRef.current = Date.now();
		awakeRef.current = true;
		setAwake(true);
		// The ambient wake target unmounts; keep keys on the Hub.
		rootRef.current?.focus({ preventScroll: true });
	};

	const sleep = () => {
		awakeRef.current = false;
		setAwake(false);
		rootRef.current?.focus({ preventScroll: true });
	};

	const runAction = (action: HubKeyAction, target: EventTarget | null) => {
		if (action === "close") {
			if (isOpen) {
				port.closeThread();
				return true;
			}
			if (awakeRef.current) {
				sleep();
				return true;
			}
			return false;
		}
		if (!awakeRef.current) {
			wake();
			return true;
		}
		if (isOpen || action === "wake") {
			return false;
		}
		// The recipient chips use arrows to move between agents.
		if (target instanceof Element && target.closest("[role='radiogroup']")) {
			return false;
		}
		if (action === "next" || action === "prev") {
			goTo(stepHubCard(activeRef.current, action === "next" ? 1 : -1));
		} else {
			goTo(action === "first" ? 0 : HUB_CARDS.length - 1);
		}
		return true;
	};
	const runActionRef = useRef(runAction);
	runActionRef.current = runAction;

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			activityRef.current = Date.now();
			if (event.defaultPrevented || event.isComposing) {
				return;
			}
			const action = hubKeyAction(event);
			if (!action || isHubTypingTarget(event.target)) {
				return;
			}
			const target = event.target;
			// Inside the sheet the host's conversation keeps its keys; only
			// Escape (when the host has not used it) goes back to the cards.
			if (
				target instanceof Node &&
				sheetRef.current?.contains(target) &&
				action !== "close"
			) {
				return;
			}
			const onPage =
				target === document.body ||
				target === document.documentElement ||
				(target instanceof Node && rootRef.current?.contains(target) === true);
			if (!onPage) {
				return;
			}
			// Enter and Space keep activating focused buttons once awake.
			if (
				action === "wake" &&
				target instanceof Element &&
				target.closest("button, a, [role='radio']")
			) {
				return;
			}
			if (runActionRef.current(action, target)) {
				event.preventDefault();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	// Remember the last control focused outside the sheet, so closing the
	// sheet returns focus to the row (or field) that opened it.
	useEffect(() => {
		const root = rootRef.current;
		if (!root) {
			return;
		}
		const onFocusIn = (event: FocusEvent) => {
			const target = event.target;
			if (
				target instanceof HTMLElement &&
				target !== root &&
				!sheetRef.current?.contains(target)
			) {
				returnFocusRef.current = target;
			}
		};
		root.addEventListener("focusin", onFocusIn);
		return () => root.removeEventListener("focusin", onFocusIn);
	}, []);

	// The sheet is modal: focus moves into it on open and back out on close.
	const wasOpenRef = useRef(isOpen);
	useLayoutEffect(() => {
		const wasOpen = wasOpenRef.current;
		wasOpenRef.current = isOpen;
		if (isOpen) {
			// The dialog itself takes focus (no ring on the back control until
			// someone tabs to it); Escape and Tab work from there.
			sheetRef.current?.focus({ preventScroll: true });
			return;
		}
		if (!wasOpen) {
			return;
		}
		const previous = returnFocusRef.current;
		if (previous?.isConnected && !previous.closest("[inert]")) {
			previous.focus({ preventScroll: true });
		} else {
			rootRef.current?.focus({ preventScroll: true });
		}
	}, [isOpen]);

	// Dim back to the ambient screen after a quiet spell, like the reference.
	useEffect(() => {
		if (!(awake && !isOpen && idleTimeoutEnabled(reduceMotion))) {
			return;
		}
		activityRef.current = Date.now();
		const timer = setInterval(() => {
			const field = fieldRef.current;
			const composing =
				field !== null &&
				(document.activeElement === field || field.value.trim() !== "");
			if (composing || document.visibilityState === "hidden") {
				activityRef.current = Date.now();
				return;
			}
			if (Date.now() - activityRef.current >= HUB_IDLE_MS) {
				setAwake(false);
			}
		}, 5000);
		return () => clearInterval(timer);
	}, [awake, isOpen, reduceMotion]);

	const onTrackScroll = () => {
		activityRef.current = Date.now();
		const track = trackRef.current;
		if (!track) {
			return;
		}
		markTrackEdges(track);
		if (dragRef.current?.dragging) {
			return;
		}
		// A row moving to a chosen card keeps that card active until it lands.
		const target = scrollTargetRef.current;
		if (target) {
			const landed = Math.abs(track.scrollLeft - target.left) <= 2;
			if (landed || Date.now() > target.until) {
				scrollTargetRef.current = null;
			}
			return;
		}
		const current = activeRef.current;
		const gutter = Number.parseFloat(getComputedStyle(track).paddingLeft) || 0;
		const atEnd = track.scrollLeft >= track.scrollWidth - track.clientWidth - 4;
		const viewRight = track.scrollLeft + track.clientWidth;
		const fullyVisible = (card: HTMLElement | null | undefined) =>
			card !== null &&
			card !== undefined &&
			card.offsetLeft >= track.scrollLeft &&
			card.offsetLeft + card.offsetWidth <= viewRight + 1;
		if (atEnd && fullyVisible(cardRefs.current[current])) {
			return;
		}
		let nearest = 0;
		let distance = Number.POSITIVE_INFINITY;
		for (const [index, card] of cardRefs.current.entries()) {
			if (!card) {
				continue;
			}
			const gap = Math.abs(card.offsetLeft - gutter - track.scrollLeft);
			if (gap < distance) {
				distance = gap;
				nearest = index;
			}
		}
		activeRef.current = nearest;
		setActive(nearest);
	};

	// When a scroll ends short of the chosen card, finish the move.
	const settleTrackRef = useRef(settleTrack);
	settleTrackRef.current = settleTrack;
	useEffect(() => {
		const track = trackRef.current;
		if (!(awake && track)) {
			return;
		}
		const onScrollEnd = () => settleTrackRef.current(track);
		track.addEventListener("scrollend", onScrollEnd);
		return () => track.removeEventListener("scrollend", onScrollEnd);
	}, [awake]);

	// Fade whichever edge has a card cut off behind it.
	useEffect(() => {
		const track = trackRef.current;
		if (!(awake && track)) {
			return;
		}
		markTrackEdges(track);
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(() => markTrackEdges(track));
		observer.observe(track);
		return () => observer.disconnect();
	}, [awake]);

	// Mouse drag scrolls the row; touch and trackpads scroll it natively.
	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		activityRef.current = Date.now();
		scrollTargetRef.current = null;
		const track = trackRef.current;
		if (event.pointerType !== "mouse" || event.button !== 0 || !track) {
			dragRef.current = null;
			return;
		}
		if (isHubTypingTarget(event.target)) {
			dragRef.current = null;
			return;
		}
		dragRef.current = {
			dragging: false,
			scrollLeft: track.scrollLeft,
			x: event.clientX,
		};
	};
	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		const track = trackRef.current;
		if (!(drag && track)) {
			return;
		}
		const dx = event.clientX - drag.x;
		if (!drag.dragging && Math.abs(dx) < DRAG_PX) {
			return;
		}
		if (!drag.dragging) {
			drag.dragging = true;
			track.style.scrollSnapType = "none";
			track.setPointerCapture?.(event.pointerId);
		}
		track.scrollLeft = drag.scrollLeft - dx;
	};
	const endDrag = () => {
		const drag = dragRef.current;
		dragRef.current = null;
		const track = trackRef.current;
		if (!(drag?.dragging && track)) {
			return;
		}
		suppressClickRef.current = true;
		track.style.scrollSnapType = "";
		const moved = track.scrollLeft - drag.scrollLeft;
		const from = activeRef.current;
		const width = cardRefs.current[from]?.offsetWidth ?? 1;
		const steps = Math.round(moved / width) || Math.sign(moved);
		goTo(stepHubCard(from, steps), false);
	};

	const composeIndex = HUB_CARDS.indexOf("compose");
	const pickAgent = (agentId: string) => {
		setComposeAgentId(agentId);
	};
	// No agent (an agentless run) resets the pick to the default recipient,
	// so an earlier pick never answers for a run it had nothing to do with.
	const toComposer = (agentId: string | undefined, topic?: string) => {
		setComposeAgentId(agentId);
		setComposeTopic(topic);
		goTo(composeIndex, false);
		requestAnimationFrame(() =>
			fieldRef.current?.focus({ preventScroll: true })
		);
	};
	const messageAgent = (agentId: string) => toComposer(agentId);
	const askAboutRun = (run: InterfaceEvent) =>
		toComposer(run.agentId ?? undefined, run.title);
	const onOpenThread = (threadId: string) => port.openThread(threadId);
	const setCardRef = (index: number) => (element: HTMLElement | null) => {
		cardRefs.current[index] = element;
	};
	const threadCardProps = { now, onOpenThread, snapshot };

	let cards: ReactNode;
	if (loading) {
		cards = [0, 1, 2, 3].map((index) => (
			<HubSkeletonCard index={index} key={index} />
		));
	} else {
		cards = (
			<>
				<HubWaitingCard
					{...threadCardProps}
					cardRef={setCardRef(0)}
					index={0}
					threads={model.waiting}
				/>
				<HubWorkingCard
					{...threadCardProps}
					cardRef={setCardRef(1)}
					index={1}
					threads={model.working}
				/>
				<HubAttentionCard
					{...threadCardProps}
					cardRef={setCardRef(2)}
					failedRuns={failedRuns}
					index={2}
					onAskAgent={askAboutRun}
					threads={model.attention}
				/>
				<HubUpcomingCard
					cardRef={setCardRef(3)}
					events={upcoming}
					index={3}
					now={now}
					snapshot={snapshot}
				/>
				<HubAgentsCard
					agents={model.agents}
					cardRef={setCardRef(4)}
					index={4}
					onPickAgent={messageAgent}
					runs={model.runs}
				/>
				<HubComposeCard
					agentId={composeAgentId ?? model.composeDefault}
					agents={model.composeAgents}
					cardRef={setCardRef(5)}
					fieldRef={fieldRef}
					index={5}
					onPickAgent={pickAgent}
					onSubmit={({ agentId, prompt: typed }) => {
						const prompt = hubTopicPrompt(composeTopic, typed);
						setComposeTopic(undefined);
						port.startThread(agentId ? { agentId, prompt } : { prompt });
					}}
					topic={composeTopic}
				/>
			</>
		);
	}

	const slide = reduceMotion ? 0 : 56;

	return (
		<div
			aria-busy={loading || undefined}
			className="relative size-full min-h-0 overflow-hidden bg-background text-foreground antialiased outline-none"
			data-state={isOpen ? "open" : awake ? "cards" : "ambient"}
			data-testid="interface-hub"
			ref={rootRef}
			style={HUB_STYLE}
			tabIndex={-1}
		>
			<HubBackdrop awake={awake} dayKey={dayKey} />
			<AnimatePresence initial={false}>
				{awake ? null : (
					<HubAmbient
						clock={clock}
						clockDateTime={hubClockDateTime(now)}
						date={hubDate(now)}
						glyph={model.glyph}
						glyphCount={model.glyphCount}
						inert={isOpen}
						key="ambient"
						loading={loading}
						onWake={wake}
						statusLine={model.statusParts}
					/>
				)}
			</AnimatePresence>
			<AnimatePresence initial={false}>
				{awake ? (
					<motion.div
						animate={{ opacity: 1 }}
						className="absolute inset-0 z-10 flex flex-col justify-center gap-6 py-[clamp(1rem,4vh,2.5rem)] [container:hub-cards/size] max-sm:gap-4"
						data-testid="hub-cards"
						exit={{ opacity: 0 }}
						inert={isOpen}
						initial={{ opacity: 0 }}
						key="cards"
						transition={{ duration: reduceMotion ? 0 : 0.3, ease: HUB_EASE }}
					>
						<header className="flex shrink-0 items-start justify-between gap-4 px-(--hub-gutter) sm:gap-6">
							<div className="flex min-w-0 flex-col gap-1">
								<h1 className="truncate font-normal text-[28px] text-foreground leading-9 tracking-[-0.01em]">
									{hubGreeting(now)}
								</h1>
								<HubStatusLine
									className="text-[17px] text-muted-foreground leading-6"
									parts={loading ? ["Loading…"] : model.statusParts}
								/>
							</div>
							<button
								aria-keyshortcuts="Escape"
								aria-label={`${clockText}, ambient screen`}
								className="-mt-1.5 -mr-3 inline-flex h-12 shrink-0 items-baseline gap-1.5 rounded-full px-3 pt-1.5 text-[28px] text-foreground tabular-nums leading-9 tracking-[-0.01em] outline-none transition-colors duration-150 hover:bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring/40 active:bg-foreground/10"
								data-testid="hub-header-clock"
								onClick={sleep}
								title="Ambient screen (Esc)"
								type="button"
							>
								{clock.time}
								{clock.dayPeriod ? (
									<span className="text-[17px] text-muted-foreground tracking-normal">
										{clock.dayPeriod}
									</span>
								) : null}
							</button>
						</header>
						<motion.div
							animate={{ opacity: 1, x: 0 }}
							className="data-[edge-end=true]:mask-r-from-[calc(100%-var(--hub-gutter))] data-[edge-start=true]:mask-l-from-[calc(100%-var(--hub-gutter))] -my-1 flex shrink-0 cursor-default select-none snap-x snap-mandatory items-stretch gap-4 overflow-x-auto overflow-y-hidden px-(--hub-gutter) py-1 [scrollbar-width:none] motion-reduce:scroll-auto [&::-webkit-scrollbar]:hidden"
							data-testid="hub-track"
							initial={{ opacity: 0, x: slide }}
							onClickCapture={(event) => {
								if (suppressClickRef.current) {
									suppressClickRef.current = false;
									event.preventDefault();
									event.stopPropagation();
								}
							}}
							onLostPointerCapture={endDrag}
							onPointerCancel={endDrag}
							onPointerDown={onPointerDown}
							onPointerMove={onPointerMove}
							onPointerUp={endDrag}
							onScroll={onTrackScroll}
							onWheel={() => {
								scrollTargetRef.current = null;
							}}
							ref={trackRef}
							transition={{
								delay: reduceMotion ? 0 : 0.08,
								duration: reduceMotion ? 0 : 0.5,
								ease: HUB_EASE,
							}}
						>
							{cards}
						</motion.div>
						<PageDots
							active={active}
							hidden={isOpen}
							onSelect={(index) => goTo(index)}
						/>
					</motion.div>
				) : null}
			</AnimatePresence>
			<AnimatePresence>
				{isOpen ? (
					<HubThreadSheet
						key="sheet"
						onClose={() => port.closeThread()}
						sheetRef={sheetRef}
						snapshot={snapshot}
						thread={openThread}
						threadView={threadView}
					/>
				) : null}
			</AnimatePresence>
		</div>
	);
}
