import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { Plus } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandBar } from "./hologram-command.tsx";
import { FrameScrim, ThreadFrame } from "./hologram-frame.tsx";
import { useHoloNow, useTypedText } from "./hologram-hooks.ts";
import {
	agentThreads,
	briefing,
	buildHologram,
	clock,
	dateStamp,
} from "./hologram-model.ts";
import { HoloOrbit, type RadialAction } from "./hologram-orbit.tsx";
import { DECK_TEXTURE, HOLO_MODE, HOLO_VARS } from "./hologram-palette.ts";
import {
	AgentThreadsPanel,
	OperationsPanel,
	PriorityPanel,
	SchedulePanel,
	SystemPanel,
} from "./hologram-panels.tsx";
import {
	HoloKeyframes,
	HoloPanel,
	HUD_INTERACTIVE,
	HUD_LABEL,
} from "./hologram-parts.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/** Ages and the schedule's countdowns refresh on this beat. */
const DECK_TICK_MS = 30_000;
const SKELETON_ROWS = ["a", "b", "c", "d"] as const;
const LOADING_PANELS = [
	{ id: "priority", label: "Priority" },
	{ id: "system", label: "System" },
	{ id: "operations", label: "Active operations" },
	{ id: "schedule", label: "Schedule" },
] as const;

/** Keys inside a text field belong to the field (or the host's composer). */
function isEditable(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !== null
	);
}

/** Local date and a seconds clock for the deck's top-left readout. */
function DeckClock() {
	const now = useHoloNow(1000);
	return (
		<p className="flex items-baseline gap-3 font-mono tabular-nums">
			<span className={cn(HUD_LABEL, "text-(--holo-dim)")}>
				{dateStamp(now)}
			</span>
			<time
				className="text-(--holo-text) text-[14px]"
				dateTime={new Date(now).toISOString()}
			>
				{clock(now, true)}
			</time>
		</p>
	);
}

/** The briefing, typed out once (whole at once when motion is reduced). */
function Briefing({
	reduceMotion,
	text,
}: {
	reduceMotion: boolean;
	text: string;
}) {
	const typed = useTypedText(text, reduceMotion);
	const done = typed.length >= text.length;
	return (
		<p
			className="@min-[760px]/holo:line-clamp-1 line-clamp-2 min-w-0 @min-[760px]/holo:text-center text-(--holo-text) text-[14px] leading-5"
			data-holo-briefing=""
		>
			<span className="sr-only">{text}</span>
			<span aria-hidden="true">
				{typed}
				<span
					className={cn(
						"ml-0.5 inline-block h-4 w-[7px] translate-y-[3px] bg-(--holo-ink)",
						done ? "opacity-0" : "opacity-100"
					)}
				/>
			</span>
		</p>
	);
}

function SkeletonRows() {
	return (
		<ul aria-hidden="true" className="flex flex-col gap-4 px-4 py-3">
			{SKELETON_ROWS.map((key, index) => (
				<li className="flex flex-col gap-2" key={key}>
					<span
						className="h-3 bg-(--holo-ink)/12 motion-safe:animate-pulse"
						style={{ width: `${82 - index * 12}%` }}
					/>
					<span className="h-2 w-2/5 bg-(--holo-ink)/8 motion-safe:animate-pulse" />
				</li>
			))}
		</ul>
	);
}

/**
 * Hologram: a holographic command HUD. A reactor core whose pulse follows how
 * many agents are working, rotating rings of agent nodes with radial menus,
 * floating panels for what needs the user, live operations, the schedule and
 * system totals, a typed briefing and a command bar. An open thread shows the
 * host's own conversation surface inside a large holographic frame.
 */
export function HologramInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["hologram"]>) {
	const reduceMotion = useReducedMotion();
	const now = useHoloNow(DECK_TICK_MS);
	const view = useMemo(() => buildHologram(snapshot, now), [snapshot, now]);
	const hour = new Date(now).getHours();
	const brief = loading
		? "Syncing with your agents."
		: briefing(view.totals, hour);

	const frameOpen = threadView !== null && threadView !== undefined;
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [focusAgentId, setFocusAgentId] = useState<string | null>(null);
	const [targetId, setTargetId] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const returnFocusRef = useRef<HTMLElement | null>(null);
	const wasOpenRef = useRef(false);

	const focusAgent = focusAgentId
		? view.agents.find((agent) => agent.id === focusAgentId)
		: undefined;
	const target = targetId
		? view.agents.find((agent) => agent.id === targetId)
		: undefined;

	const rememberFocus = useCallback(() => {
		const active = document.activeElement;
		returnFocusRef.current = active instanceof HTMLElement ? active : null;
	}, []);
	const openThread = useCallback(
		(threadId: string) => {
			rememberFocus();
			port.openThread(threadId);
		},
		[port, rememberFocus]
	);
	const closeThread = useCallback(() => port.closeThread(), [port]);

	useEffect(() => {
		const wasOpen = wasOpenRef.current;
		wasOpenRef.current = frameOpen;
		if (frameOpen && !wasOpen) {
			headingRef.current?.focus({ preventScroll: true });
		} else if (!frameOpen && wasOpen) {
			const back = returnFocusRef.current;
			returnFocusRef.current = null;
			if (back?.isConnected) {
				back.focus({ preventScroll: true });
			}
		}
	}, [frameOpen]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				isInterfaceCovered(rootRef.current)
			) {
				return;
			}
			if (event.key === "Escape") {
				if (isEditable(event.target)) {
					return;
				}
				if (selectedId !== null) {
					event.preventDefault();
					setSelectedId(null);
					return;
				}
				if (frameOpen) {
					event.preventDefault();
					port.closeThread();
				}
				return;
			}
			if (event.key === "/" && !frameOpen && !isEditable(event.target)) {
				event.preventDefault();
				inputRef.current?.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [frameOpen, port, selectedId]);

	const onAction = useCallback(
		(agentId: string, action: RadialAction) => {
			setSelectedId(null);
			if (action === "message") {
				setTargetId(agentId);
				inputRef.current?.focus();
				return;
			}
			if (action === "open-latest") {
				const latest = view.agents.find(
					(agent) => agent.id === agentId
				)?.latestThreadId;
				if (latest) {
					openThread(latest);
				}
				return;
			}
			setFocusAgentId(agentId);
		},
		[openThread, view.agents]
	);

	const startThread = useCallback(
		(input: { agentId: string | null; prompt: string }) => {
			rememberFocus();
			setTargetId(null);
			port.startThread(
				input.agentId
					? { agentId: input.agentId, prompt: input.prompt }
					: { prompt: input.prompt }
			);
		},
		[port, rememberFocus]
	);

	const empty =
		!loading && snapshot.agents.length === 0 && snapshot.threads.length === 0;
	const openRecord = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const listProps = {
		activeThreadId: frameOpen ? activeThreadId : null,
		now,
		onOpen: openThread,
	};
	/**
	 * Three columns (1200px and up): each side column stacks its two panels
	 * from the top, 16px apart. Every panel keeps its content's height (the
	 * deck shows below the stack, not a padded box) and only shrinks, then
	 * scrolls with a "n more" footer, when the column runs out. Two
	 * columns: the panels are grid items; the right column holds the three
	 * lists (Priority capped at four rows, Schedule taking what is left) and
	 * System sits under the ring as a wide readout. One column: the page
	 * scrolls and every panel keeps its natural height.
	 */
	const panelColumn =
		"contents @min-[1200px]/holo:flex @min-[1200px]/holo:min-h-0 @min-[1200px]/holo:flex-col @min-[1200px]/holo:gap-4";
	const leftColumn = cn(
		panelColumn,
		"@min-[1200px]/holo:col-start-1 @min-[1200px]/holo:row-start-1"
	);
	const rightColumn = cn(
		panelColumn,
		"@min-[1200px]/holo:col-start-3 @min-[1200px]/holo:row-start-1"
	);
	const listPanel =
		"max-h-96 flex-none @min-[1200px]/holo:min-h-24 @min-[1200px]/holo:flex-[0_1_auto]";
	const place = {
		operations: cn(
			listPanel,
			"@min-[760px]/holo:col-start-2 @min-[760px]/holo:row-start-2 @min-[1200px]/holo:max-h-[50%] @min-[760px]/holo:max-h-52"
		),
		priority: cn(
			listPanel,
			"@min-[760px]/holo:col-start-2 @min-[760px]/holo:row-start-1 @min-[1200px]/holo:max-h-none @min-[760px]/holo:max-h-[278px]"
		),
		schedule: cn(
			listPanel,
			"@min-[760px]/holo:col-start-2 @min-[760px]/holo:row-span-2 @min-[760px]/holo:row-start-3 @min-[760px]/holo:max-h-none"
		),
		system:
			"order-last shrink-0 @min-[760px]/holo:col-start-1 @min-[760px]/holo:row-start-4 @min-[1200px]/holo:order-none",
	} as const;

	return (
		<div
			aria-busy={loading ? "true" : undefined}
			className={cn(
				"@container/holo relative flex size-full min-h-0 flex-col overflow-hidden text-(--holo-text) antialiased",
				HOLO_MODE
			)}
			data-testid="interface-hologram"
			ref={rootRef}
			style={{ ...HOLO_VARS, ...DECK_TEXTURE }}
		>
			<HoloKeyframes />
			<div className="flex min-h-0 flex-1 flex-col" inert={frameOpen}>
				<header className="grid @min-[760px]/holo:h-14 min-h-14 shrink-0 @min-[760px]/holo:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)_minmax(0,1fr)] grid-cols-[minmax(0,1fr)_auto] @min-[760px]/holo:content-center items-start @min-[760px]/holo:items-baseline gap-4 border-(--holo-line) border-b @min-[760px]/holo:px-6 px-4 @min-[760px]/holo:py-0 py-3">
					<div className="@min-[760px]/holo:block hidden">
						<DeckClock />
					</div>
					<Briefing reduceMotion={reduceMotion} text={brief} />
					<div className="flex justify-end">
						<button
							aria-label="New thread"
							className={cn(
								HUD_LABEL,
								HUD_INTERACTIVE,
								"-mt-1.5 @min-[760px]/holo:mt-0 flex h-8 items-center justify-center gap-1.5 rounded-sm px-2.5 text-(--holo-ink) disabled:pointer-events-none disabled:opacity-50"
							)}
							disabled={loading}
							onClick={() => {
								rememberFocus();
								port.startThread({});
							}}
							type="button"
						>
							<Plus aria-hidden="true" className="size-3.5" />
							<span aria-hidden="true" className="@min-[760px]/holo:hidden">
								New
							</span>
							<span
								aria-hidden="true"
								className="@min-[760px]/holo:inline hidden"
							>
								New thread
							</span>
						</button>
					</div>
				</header>
				<main className="grid min-h-0 flex-1 auto-rows-max @min-[1200px]/holo:grid-cols-[300px_minmax(0,1fr)_300px] @min-[1400px]/holo:grid-cols-[320px_minmax(0,1fr)_320px] @min-[760px]/holo:grid-cols-[minmax(0,1fr)_300px] grid-cols-1 @min-[1200px]/holo:grid-rows-[minmax(0,1fr)] @min-[760px]/holo:grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-4 @min-[760px]/holo:overflow-hidden overflow-y-auto @min-[1200px]/holo:px-6 px-4 pt-4 @min-[760px]/holo:pb-4 pb-16 @min-[760px]/holo:[mask-image:none] [mask-image:linear-gradient(to_bottom,black_calc(100%-24px),transparent)]">
					<div className="relative @min-[1200px]/holo:col-start-2 @min-[760px]/holo:col-start-1 @min-[1200px]/holo:row-span-1 @min-[760px]/holo:row-span-3 @min-[760px]/holo:row-start-1 @min-[760px]/holo:h-auto h-[440px] min-h-0">
						<HoloOrbit
							loading={loading}
							onAction={onAction}
							onSelect={setSelectedId}
							pinnedId={focusAgent?.id ?? null}
							reduceMotion={reduceMotion}
							selectedId={selectedId}
							targetId={target?.id ?? null}
							view={view}
						>
							{empty ? (
								<div className="flex max-w-72 flex-col items-center gap-3 text-center">
									<p className="text-(--holo-dim) text-[14px] leading-5">
										Agents you create appear on this ring. Start a thread to put
										one to work.
									</p>
									<button
										className={cn(
											HUD_LABEL,
											HUD_INTERACTIVE,
											"flex h-8 items-center gap-1.5 rounded-sm border border-(--holo-line) px-3 text-(--holo-ink)"
										)}
										onClick={() => {
											rememberFocus();
											port.startThread({});
										}}
										type="button"
									>
										<Plus aria-hidden="true" className="size-3.5" />
										Start a thread
									</button>
								</div>
							) : null}
						</HoloOrbit>
					</div>
					{loading ? (
						<>
							<div className={leftColumn}>
								{LOADING_PANELS.slice(0, 2).map((panel) => (
									<HoloPanel
										className={place[panel.id]}
										id={panel.id}
										key={panel.id}
										label={panel.label}
									>
										<SkeletonRows />
									</HoloPanel>
								))}
							</div>
							<div className={rightColumn}>
								{LOADING_PANELS.slice(2).map((panel) => (
									<HoloPanel
										className={place[panel.id]}
										id={panel.id}
										key={panel.id}
										label={panel.label}
									>
										<SkeletonRows />
									</HoloPanel>
								))}
							</div>
						</>
					) : (
						<>
							<div className={leftColumn}>
								{focusAgent ? (
									<AgentThreadsPanel
										{...listProps}
										agentName={focusAgent.name}
										className={place.priority}
										items={agentThreads(snapshot, focusAgent.id)}
										onClose={() => setFocusAgentId(null)}
									/>
								) : (
									<PriorityPanel
										{...listProps}
										className={place.priority}
										items={view.priority}
									/>
								)}
								<SystemPanel className={place.system} now={now} view={view} />
							</div>
							<div className={rightColumn}>
								<OperationsPanel
									{...listProps}
									className={place.operations}
									items={view.working}
								/>
								<SchedulePanel
									className={place.schedule}
									now={now}
									snapshot={snapshot}
									view={view}
								/>
							</div>
						</>
					)}
				</main>
				<footer className="flex shrink-0 justify-center px-4 @min-[760px]/holo:pt-0 pt-3 pb-4">
					<div className="w-full max-w-[640px]">
						<CommandBar
							disabled={loading}
							inputRef={inputRef}
							onClearTarget={() => setTargetId(null)}
							onSubmit={startThread}
							snapshot={snapshot}
							targetId={target?.id ?? null}
						/>
					</div>
				</footer>
			</div>
			<AnimatePresence>
				{frameOpen ? <FrameScrim key="scrim" onClose={closeThread} /> : null}
				{frameOpen ? (
					<ThreadFrame
						headingRef={headingRef}
						key="frame"
						now={now}
						onClose={closeThread}
						snapshot={snapshot}
						thread={openRecord}
						threadView={threadView}
					/>
				) : null}
			</AnimatePresence>
		</div>
	);
}
