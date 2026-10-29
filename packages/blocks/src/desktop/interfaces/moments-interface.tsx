import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { AnimatePresence, motion } from "motion/react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import {
	agentById,
	type InterfaceRendererProps,
} from "./interface-renderer.ts";
import { MomentsBackdrop } from "./moments-backdrop.tsx";
import {
	MOMENTS_MODULE_ATTRIBUTE,
	MOMENTS_THREAD_VIEW_ATTRIBUTE,
	MomentsFlowView,
} from "./moments-flow.tsx";
import {
	MOMENTS_FLOW_ATTRIBUTE,
	MomentsHome,
	MomentsHomeEmpty,
	MomentsHomeSkeleton,
} from "./moments-home.tsx";
import { MomentsClock, MomentsIntentBar } from "./moments-intent.tsx";
import {
	buildMomentsFlows,
	groupMomentsDays,
	type MomentsFlow,
	type MomentsModule,
	type MomentsRect,
	momentsFlowForThread,
	momentsGridStep,
	momentsStep,
} from "./moments-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

const NOW_TICK_MS = 30_000;
/** Horizontal two-finger travel (px) that counts as a back swipe. */
const SWIPE_BACK_PX = 120;
/** Pinch-out travel (ctrl+wheel deltaY) that counts as zooming out. */
const PINCH_OUT_PX = 40;
/** A pause this long (ms) ends one gesture and starts the next. */
const GESTURE_IDLE_MS = 220;
const EASE = [0.22, 1, 0.36, 1] as const;

/** +1 zooms into a flow, -1 zooms back out to the timeline. */
type Zoom = 1 | -1;

const LAYER_VARIANTS = {
	enter: ({ layer, zoom }: { layer: "flow" | "home"; zoom: Zoom }) => ({
		opacity: 0,
		scale: layer === "flow" ? 1 - 0.04 * zoom : 1 + 0.04 * zoom,
	}),
	exit: ({ layer, zoom }: { layer: "flow" | "home"; zoom: Zoom }) => ({
		opacity: 0,
		scale: layer === "flow" ? 1 - 0.04 * zoom : 1 + 0.04 * zoom,
	}),
	shown: { opacity: 1, scale: 1 },
};

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement
	);
}

/** Keys pressed inside the host's conversation view belong to it. */
function insideThreadView(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		target.closest(`[${MOMENTS_THREAD_VIEW_ATTRIBUTE}]`) !== null
	);
}

/** Where each flow card sits, in timeline order, for grid-aware arrows. */
function flowCardRects(root: HTMLElement | null): MomentsRect[] {
	const cards = root?.querySelectorAll(`[${MOMENTS_FLOW_ATTRIBUTE}]`) ?? [];
	const rects: MomentsRect[] = [];
	for (const card of cards) {
		const rect = card.getBoundingClientRect();
		rects.push({ height: rect.height, left: rect.left, top: rect.top });
	}
	return rects;
}

function focusByAttribute(
	root: HTMLElement | null,
	attribute: string,
	index: number
) {
	const element = root?.querySelector(`[${attribute}="${index}"]`);
	if (element instanceof HTMLElement) {
		element.focus();
	}
}

/**
 * Moments, after MercuryOS: an ambient timeline of flows (what needs you,
 * each project and team, each agent) under the day they last moved. Opening a
 * flow zooms into it: its conversations down the left and one focused card;
 * opening a conversation grows that card around the host's thread view.
 */
export function MomentsInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const reduceMotion = useReducedMotion();
	const [now, setNow] = useState(() => Date.now());
	const flows = useMemo(() => buildMomentsFlows(snapshot), [snapshot]);
	const days = useMemo(() => groupMomentsDays(flows, now), [flows, now]);
	const ordered = useMemo(() => days.flatMap((day) => day.flows), [days]);

	const [flowId, setFlowId] = useState<string | null>(
		() => momentsFlowForThread(flows, activeThreadId)?.id ?? null
	);
	const [selectedFlowId, setSelectedFlowId] = useState<string | null>(flowId);
	const [focusIndex, setFocusIndex] = useState(() => {
		const flow = momentsFlowForThread(flows, activeThreadId);
		const index =
			flow?.modules.findIndex((item) => item.thread.id === activeThreadId) ?? 0;
		return Math.max(0, index);
	});
	const [direction, setDirection] = useState(1);
	const [zoom, setZoom] = useState<Zoom>(1);

	const rootRef = useRef<HTMLDivElement>(null);
	const intentRef = useRef<HTMLInputElement>(null);
	const homeScrollRef = useRef(0);
	const pendingFocus = useRef<"flow" | "home" | null>(null);

	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS);
		return () => window.clearInterval(timer);
	}, []);

	const openFlow = flowId
		? (flows.find((flow) => flow.id === flowId) ?? null)
		: null;
	const inFlow = openFlow !== null || threadView !== null;

	// The host opened a thread (from here, a new prompt, or elsewhere): show
	// it inside its flow, with its module focused.
	useEffect(() => {
		if (!activeThreadId) {
			return;
		}
		const current = flowId
			? flows.find((flow) => flow.id === flowId)
			: undefined;
		const holder = current?.modules.some(
			(item) => item.thread.id === activeThreadId
		)
			? current
			: momentsFlowForThread(flows, activeThreadId);
		if (!holder) {
			return;
		}
		const index = holder.modules.findIndex(
			(item) => item.thread.id === activeThreadId
		);
		if (holder.id !== flowId) {
			setZoom(1);
			setFlowId(holder.id);
			setSelectedFlowId(holder.id);
		}
		setFocusIndex(Math.max(0, index));
	}, [activeThreadId, flowId, flows]);

	// Keep the focused module inside the flow as it grows or shrinks.
	const moduleCount = openFlow?.modules.length ?? 0;
	useEffect(() => {
		setFocusIndex((index) => momentsStep(index, 0, moduleCount));
	}, [moduleCount]);

	const enterFlow = useCallback(
		(flow: MomentsFlow) => {
			homeScrollRef.current =
				rootRef.current?.querySelector("[data-moments-home]")?.scrollTop ?? 0;
			pendingFocus.current = "flow";
			setZoom(1);
			setDirection(1);
			setSelectedFlowId(flow.id);
			setFlowId(flow.id);
			const index = activeThreadId
				? flow.modules.findIndex((item) => item.thread.id === activeThreadId)
				: -1;
			setFocusIndex(Math.max(0, index));
		},
		[activeThreadId]
	);

	const leaveFlow = useCallback(() => {
		if (threadView) {
			port.closeThread();
		}
		pendingFocus.current = "home";
		setZoom(-1);
		setFlowId(null);
	}, [port, threadView]);

	const closeConversation = useCallback(() => {
		port.closeThread();
		if (!openFlow) {
			pendingFocus.current = "home";
			setZoom(-1);
		}
	}, [openFlow, port]);

	const selectModule = useCallback(
		(index: number) => {
			const item = openFlow?.modules[index];
			if (!item) {
				return;
			}
			setDirection(index >= focusIndex ? 1 : -1);
			setFocusIndex(index);
			if (threadView && item.thread.id !== activeThreadId) {
				port.openThread(item.thread.id);
			}
		},
		[activeThreadId, focusIndex, openFlow, port, threadView]
	);

	// Move keyboard focus with the zoom, and put the timeline back where it was.
	useLayoutEffect(() => {
		const target = pendingFocus.current;
		if (!target) {
			return;
		}
		pendingFocus.current = null;
		const root = rootRef.current;
		if (target === "home") {
			const home = root?.querySelector("[data-moments-home]");
			if (home) {
				home.scrollTop = homeScrollRef.current;
			}
			const index = Math.max(
				0,
				ordered.findIndex((flow) => flow.id === selectedFlowId)
			);
			focusByAttribute(root, MOMENTS_FLOW_ATTRIBUTE, index);
			return;
		}
		const row = root?.querySelector(
			`[${MOMENTS_MODULE_ATTRIBUTE}="${focusIndex}"]`
		);
		if (row instanceof HTMLElement && row.offsetParent !== null) {
			row.focus();
		} else {
			root?.querySelector<HTMLElement>("[data-testid='moments-flow']")?.focus();
		}
	});

	function handleHomeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		const vertical = event.key === "ArrowDown" || event.key === "ArrowUp";
		const horizontal = event.key === "ArrowRight" || event.key === "ArrowLeft";
		const edge =
			event.key === "Home" ? "first" : event.key === "End" ? "last" : null;
		if (!(vertical || horizontal || edge)) {
			return;
		}
		event.preventDefault();
		const current = Math.max(
			0,
			ordered.findIndex((flow) => flow.id === selectedFlowId)
		);
		let next = current;
		if (edge === "first") {
			next = 0;
		} else if (edge === "last") {
			next = ordered.length - 1;
		} else {
			const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
			next =
				momentsGridStep(
					flowCardRects(rootRef.current),
					current,
					vertical ? "row" : "column",
					forward ? 1 : -1
				) ?? momentsStep(current, forward ? 1 : -1, ordered.length);
		}
		setSelectedFlowId(ordered[next]?.id ?? null);
		focusByAttribute(rootRef.current, MOMENTS_FLOW_ATTRIBUTE, next);
	}

	function handleListKeyDown(event: KeyboardEvent<HTMLElement>) {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const next = momentsStep(
			focusIndex,
			event.key === "ArrowDown" ? 1 : -1,
			moduleCount
		);
		selectModule(next);
		focusByAttribute(rootRef.current, MOMENTS_MODULE_ATTRIBUTE, next);
	}

	function handleRootKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (
			event.defaultPrevented ||
			!inFlow ||
			insideThreadView(event.target) ||
			isTypingTarget(event.target)
		) {
			return;
		}
		if (
			(event.key === "ArrowRight" || event.key === "ArrowLeft") &&
			moduleCount > 0
		) {
			event.preventDefault();
			const next = momentsStep(
				focusIndex,
				event.key === "ArrowRight" ? 1 : -1,
				moduleCount
			);
			selectModule(next);
			focusByAttribute(rootRef.current, MOMENTS_MODULE_ATTRIBUTE, next);
		}
	}

	/**
	 * Arrow keys pressed with nothing focused (on load, or after a click on
	 * the wash) still steer: on the timeline they land on the selected flow
	 * first, inside a flow they move between modules.
	 */
	function handleUnfocusedArrow(event: globalThis.KeyboardEvent): boolean {
		if (inFlow) {
			if (threadView || moduleCount === 0) {
				return false;
			}
			const delta =
				event.key === "ArrowRight" || event.key === "ArrowDown"
					? 1
					: event.key === "ArrowLeft" || event.key === "ArrowUp"
						? -1
						: 0;
			if (delta === 0) {
				return false;
			}
			const next = momentsStep(focusIndex, delta, moduleCount);
			selectModule(next);
			focusByAttribute(rootRef.current, MOMENTS_MODULE_ATTRIBUTE, next);
			return true;
		}
		if (
			ordered.length === 0 ||
			!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
		) {
			return false;
		}
		const current = Math.max(
			0,
			ordered.findIndex((flow) => flow.id === selectedFlowId)
		);
		let next = current;
		if (event.key === "Home") {
			next = 0;
		} else if (event.key === "End") {
			next = ordered.length - 1;
		}
		setSelectedFlowId(ordered[next]?.id ?? null);
		focusByAttribute(rootRef.current, MOMENTS_FLOW_ATTRIBUTE, next);
		return true;
	}
	const unfocusedArrowRef = useRef(handleUnfocusedArrow);
	unfocusedArrowRef.current = handleUnfocusedArrow;

	/** From an empty intent bar, ArrowDown drops into the timeline or list. */
	function leaveIntent() {
		if (inFlow) {
			focusByAttribute(rootRef.current, MOMENTS_MODULE_ATTRIBUTE, focusIndex);
			return;
		}
		const index = Math.max(
			0,
			ordered.findIndex((flow) => flow.id === selectedFlowId)
		);
		focusByAttribute(rootRef.current, MOMENTS_FLOW_ATTRIBUTE, index);
	}

	/** Esc zooms out one level: the open conversation first, then the flow. */
	const zoomOut = useCallback(() => {
		if (threadView) {
			closeConversation();
		} else if (inFlow) {
			leaveFlow();
		}
	}, [closeConversation, inFlow, leaveFlow, threadView]);

	// "/" and Esc work from anywhere on the page while Moments is up, not
	// only once focus is inside it, but never over another field or the
	// host's own conversation view, and not while a host page covers it.
	const zoomOutRef = useRef(zoomOut);
	zoomOutRef.current = zoomOut;
	useEffect(() => {
		function handleDocumentKeyDown(event: globalThis.KeyboardEvent) {
			const root = rootRef.current;
			const target = event.target;
			const unfocused =
				target === document.body || target === document.documentElement;
			const ours =
				unfocused ||
				(target instanceof Node && root?.contains(target) === true);
			if (
				event.defaultPrevented ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				!ours ||
				isInterfaceCovered(root) ||
				insideThreadView(target) ||
				isTypingTarget(target)
			) {
				return;
			}
			if (event.key === "/") {
				event.preventDefault();
				intentRef.current?.focus();
			} else if (event.key === "Escape") {
				event.preventDefault();
				zoomOutRef.current();
			} else if (unfocused && unfocusedArrowRef.current(event)) {
				event.preventDefault();
			}
		}
		document.addEventListener("keydown", handleDocumentKeyDown);
		return () => document.removeEventListener("keydown", handleDocumentKeyDown);
	}, []);

	// The back gesture: a two-finger swipe to the right, or a pinch out,
	// zooms out like Esc. Never inside the host's conversation view.
	const inFlowRef = useRef(inFlow);
	inFlowRef.current = inFlow;
	useEffect(() => {
		const root = rootRef.current;
		if (!root) {
			return;
		}
		let swipe = 0;
		let pinch = 0;
		let lastAt = 0;
		/** One gesture zooms out once, however long the fingers keep moving. */
		let spent = false;
		function handleWheel(event: WheelEvent) {
			if (!inFlowRef.current || insideThreadView(event.target)) {
				return;
			}
			if (event.timeStamp - lastAt > GESTURE_IDLE_MS) {
				swipe = 0;
				pinch = 0;
				spent = false;
			}
			lastAt = event.timeStamp;
			if (event.ctrlKey) {
				event.preventDefault();
				pinch = Math.max(0, pinch + event.deltaY);
				if (!spent && pinch > PINCH_OUT_PX) {
					spent = true;
					zoomOutRef.current();
				}
				return;
			}
			if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) {
				return;
			}
			swipe = Math.min(0, swipe + event.deltaX);
			if (!spent && swipe < -SWIPE_BACK_PX) {
				spent = true;
				zoomOutRef.current();
			}
		}
		root.addEventListener("wheel", handleWheel, { passive: false });
		return () => root.removeEventListener("wheel", handleWheel);
	}, []);

	const groupNames = useMemo(
		() => new Map(snapshot.groups.map((group) => [group.id, group.name])),
		[snapshot.groups]
	);
	const contextFor = useCallback(
		(item: MomentsModule) => {
			const { projectId, teamId } = item.thread;
			return (
				(projectId && groupNames.get(projectId)) ||
				(teamId && groupNames.get(teamId)) ||
				"Direct"
			);
		},
		[groupNames]
	);

	/** Who a prompt without `@name` goes to, given where you are. */
	const fallbackAgent: InterfaceAgent | undefined = openFlow
		? (agentById(snapshot, openFlow.start.agentId) ??
			(openFlow.kind === "needs-you" ? undefined : openFlow.agents[0]))
		: undefined;

	function startFromIntent(prompt: string, agent: InterfaceAgent | undefined) {
		const start = openFlow?.kind === "needs-you" ? {} : (openFlow?.start ?? {});
		port.startThread({
			...start,
			agentId: agent?.id ?? fallbackAgent?.id,
			prompt,
		});
	}

	const transition = { duration: reduceMotion ? 0 : 0.36, ease: EASE };
	const hasContent = snapshot.threads.length > 0;

	let home = <MomentsHomeEmpty hasAgents={snapshot.agents.length > 0} />;
	if (loading) {
		home = <MomentsHomeSkeleton />;
	} else if (hasContent) {
		home = (
			<MomentsHome
				days={days}
				now={now}
				onKeyDown={handleHomeKeyDown}
				onOpen={enterFlow}
				selectedId={selectedFlowId ?? ordered[0]?.id ?? null}
			/>
		);
	}

	return (
		<div
			className="relative isolate flex size-full min-h-0 flex-col overflow-hidden text-foreground"
			data-testid="interface-moments"
			onKeyDown={handleRootKeyDown}
			ref={rootRef}
		>
			<MomentsBackdrop />
			<header className="relative z-20 shrink-0">
				<div className="mx-auto flex h-20 w-full max-w-6xl items-center gap-6 px-4 sm:px-10">
					<MomentsIntentBar
						fallback={fallbackAgent}
						inputRef={intentRef}
						onLeave={leaveIntent}
						onStart={startFromIntent}
						snapshot={snapshot}
					/>
					<MomentsClock />
				</div>
			</header>
			<main className="relative min-h-0 flex-1">
				<AnimatePresence
					custom={{ layer: inFlow ? "flow" : "home", zoom }}
					initial={false}
				>
					{inFlow ? (
						<motion.div
							animate="shown"
							className="absolute inset-0"
							custom={{ layer: "flow", zoom }}
							exit="exit"
							initial="enter"
							key="flow"
							transition={transition}
							variants={LAYER_VARIANTS}
						>
							<div className="mx-auto size-full max-w-6xl outline-none">
								<MomentsFlowView
									contextFor={contextFor}
									direction={direction}
									flow={openFlow}
									focusIndex={focusIndex}
									now={now}
									onBack={leaveFlow}
									onClose={closeConversation}
									onListKeyDown={handleListKeyDown}
									onNewThread={() => intentRef.current?.focus()}
									onOpenThread={(threadId) => port.openThread(threadId)}
									onSelect={selectModule}
									threadView={threadView}
								/>
							</div>
						</motion.div>
					) : (
						<motion.div
							animate="shown"
							className="absolute inset-0 overflow-y-auto"
							custom={{ layer: "home", zoom }}
							data-moments-home=""
							exit="exit"
							initial="enter"
							key="home"
							transition={transition}
							variants={LAYER_VARIANTS}
						>
							<div className="mx-auto w-full max-w-6xl px-4 pt-4 pb-16 sm:px-10">
								{home}
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</main>
		</div>
	);
}
