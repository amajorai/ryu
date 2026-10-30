import { useLiteralMessages } from "@ryu/i18n/react";
import { type InterfaceEvent, localDayKey } from "@ryuhq/protocol/interfaces";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useMemo, useRef, useState } from "react";
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
import { HUB_STYLE, PageDots } from "./hub-interface-chrome.tsx";
import {
	useHubFocusReturn,
	useHubIdle,
	useHubKeys,
} from "./hub-interface-focus.ts";
import { useHubTrack } from "./hub-interface-track.ts";
import {
	HUB_CARDS,
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
	hubStatusParts,
	hubThreads,
	hubTopicPrompt,
	hubUpcoming,
	hubWithFailedRuns,
	stepHubCard,
} from "./hub-model.ts";
import {
	HUB_EASE,
	HubStatusLine,
	HubThreadSheet,
	useHubClock,
} from "./hub-parts.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

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
	const tl = useLiteralMessages();
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
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	const activityRef = useRef(Date.now());
	const {
		endDrag,
		goTo,
		onPointerDown,
		onPointerMove,
		onTrackScroll,
		scrollTargetRef,
		setCardRef,
		suppressClickRef,
		trackRef,
	} = useHubTrack({
		activeRef,
		activityRef,
		awake,
		loading,
		reduceMotion,
		setActive,
	});

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

	useHubKeys({ activityRef, rootRef, runActionRef, sheetRef });
	useHubFocusReturn({ isOpen, rootRef, sheetRef });
	useHubIdle({ activityRef, awake, fieldRef, isOpen, reduceMotion, setAwake });

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
								aria-label={tl("{clockText}, ambient screen", { clockText })}
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
