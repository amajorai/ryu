import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import {
	BellRing,
	CircleAlert,
	Fish,
	Inbox,
	Move3d,
	Plus,
	Sparkles,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	type KeyboardEvent,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { TankFilling } from "./aquarium-filling.tsx";
import { useThemeColors, useWebGLSupport } from "./aquarium-hooks.ts";
import {
	buildCreatures,
	plural,
	type TankSummary,
	tankSummary,
} from "./aquarium-model.ts";
import { cssColor, tankPalette } from "./aquarium-palette.ts";
import {
	AquariumPanel,
	AquariumPanelActs,
	type AquariumPanelView,
} from "./aquarium-panel.tsx";
import { BubblesGlyph, GLASS, PearlGlyph } from "./aquarium-parts.tsx";
import {
	AquariumTank,
	type AquariumTankActs,
	CreatureList,
	type CreatureListActs,
} from "./aquarium-tank.tsx";
import { ensureGameDisplayFont } from "./game-font.ts";
import {
	GAME_FOCUS,
	GAME_PLATE,
	GameAction,
	GameCounter,
	GameCounters,
	GameLegend,
	GameTitlePlate,
} from "./game-hud.tsx";
import { GameShell, gameSheetCover } from "./game-shell.tsx";
import {
	actOverlays,
	actSummaryLine,
	actTotals,
	isRedBlocker,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import { IsoZoomControls, useIsoView } from "./game3d-stage.tsx";
import {
	ActAnnouncer,
	AskQueueList,
	askOwners,
	BlindSpotCaption,
	NeedYouButton,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

/** Creature hues in the art palette (both moods have the same count). */
const HUE_COUNT = 8;

type Selection =
	| { agentId: string; kind: "agent" }
	| { kind: "unassigned" }
	| null;

/**
 * Escape inside a text field belongs to the field, except in the panel's own
 * composer while it is empty: there it closes the panel, as the Esc hint says.
 */
function escapeIsFree(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return true;
	}
	const editable =
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !==
			null;
	if (!editable) {
		return true;
	}
	return (
		target instanceof HTMLTextAreaElement &&
		target.closest("[data-aquarium-composer]") !== null &&
		target.value.trim() === ""
	);
}

interface SummaryPart {
	/** Kept in the narrowest header, where only the live counts fit. */
	essential: boolean;
	text: string;
}

function summaryParts(summary: TankSummary): SummaryPart[] {
	if (summary.agents === 0) {
		return [{ essential: true, text: "No agents yet" }];
	}
	const parts: SummaryPart[] = [
		{ essential: false, text: plural(summary.agents, "agent") },
		{ essential: true, text: `${summary.working} working` },
	];
	if (summary.attention > 0) {
		parts.push({
			essential: true,
			text: `${summary.attention} need${summary.attention === 1 ? "s" : ""} attention`,
		});
	}
	if (summary.yourTurn > 0) {
		parts.push({
			essential: false,
			text: `${summary.yourTurn} waiting on you`,
		});
	}
	return parts;
}

/**
 * Aquarium: a glass reef tank on the game kit's island (aquarium-diorama.tsx).
 * Each agent is a toon creature (reef fish, angelfish, jellyfish, sea turtle
 * or manta ray, picked from its id) in its own colors, swimming around its
 * own spot: high with a bubble trail while it works, low over the reef when
 * idle, carrying a pearl when a thread needs attention. Its kit name plate
 * (or Tab and Enter on the creature list) opens its card beside the tank,
 * with its threads and a composer that messages it. An open thread is the
 * host's own conversation, shown in the same panel.
 */
export function AquariumInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["aquarium"]>) {
	const panelId = useId();
	const reduceMotion = useReducedMotion();
	const rootRef = useRef<HTMLDivElement>(null);
	const theme = useThemeColors(rootRef);
	const palette = useMemo(() => tankPalette(theme), [theme]);
	const webgl = useWebGLSupport();
	const creatures = useMemo(
		() => (loading ? [] : buildCreatures(snapshot, HUE_COUNT)),
		[loading, snapshot]
	);
	const summary = useMemo(() => tankSummary(snapshot), [snapshot]);
	const [selection, setSelection] = useState<Selection>(null);
	const isoView = useIsoView();
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const [rootWidth, setRootWidth] = useState(0);
	useEffect(() => {
		ensureGameDisplayFont();
	}, []);
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root) {
			return;
		}
		const measure = () => setRootWidth(root.clientWidth);
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(root);
		return () => observer.disconnect();
	}, []);
	/** The 3D scene has drawn its first frame (its chunk and shaders are ready). */
	const [rendered, setRendered] = useState(false);
	const [announcement, setAnnouncement] = useState("");
	const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
	const headingRef = useRef<HTMLHeadingElement>(null);
	const focusHeading = useRef(false);
	const returnFocusTo = useRef<string | null>(null);

	const threadOpen = threadView !== null;
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const selectedCreature =
		selection?.kind === "agent"
			? creatures.find((creature) => creature.id === selection.agentId)
			: undefined;
	// The open thread belongs to the agent it was opened from, else its first agent.
	const contextCreature =
		selectedCreature ??
		creatures.find((creature) => creature.id === activeThread?.agentIds[0]);

	let view: AquariumPanelView | null = null;
	if (threadOpen) {
		view = { creature: contextCreature, kind: "thread", thread: activeThread };
	} else if (selectedCreature) {
		view = { creature: selectedCreature, kind: "agent" };
	} else if (selection?.kind === "unassigned") {
		view = { kind: "unassigned" };
	}
	const highlightId =
		view && view.kind !== "unassigned" ? (view.creature?.id ?? null) : null;
	const viewKey = view
		? `${view.kind}:${highlightId ?? ""}:${activeThreadId ?? ""}`
		: "";

	// Move focus into the panel when the user opens or switches it, so
	// keyboard users land on what they asked for.
	useLayoutEffect(() => {
		if (!(viewKey && focusHeading.current)) {
			return;
		}
		focusHeading.current = false;
		headingRef.current?.focus();
	}, [viewKey]);

	// Closing the panel removes whatever had focus inside it; return focus to
	// the creature it was about instead of dropping it to <body>.
	useLayoutEffect(() => {
		if (viewKey || !returnFocusTo.current) {
			return;
		}
		const target = buttonRefs.current.get(returnFocusTo.current);
		returnFocusTo.current = null;
		const active = document.activeElement;
		if (
			active &&
			active !== document.body &&
			rootRef.current?.contains(active)
		) {
			return;
		}
		target?.focus();
	}, [viewKey]);

	const selectAgent = (agentId: string) => {
		const creature = creatures.find((item) => item.id === agentId);
		if (threadOpen) {
			port.closeThread();
		}
		focusHeading.current = true;
		setSelection({ agentId, kind: "agent" });
		setAnnouncement(creature ? `${creature.name} selected` : "");
	};
	const openThread = (threadId: string) => {
		focusHeading.current = true;
		port.openThread(threadId);
	};
	const back = () => {
		port.closeThread();
		focusHeading.current = true;
		if (contextCreature) {
			setSelection({ agentId: contextCreature.id, kind: "agent" });
		} else if (selection?.kind !== "unassigned") {
			returnFocusTo.current = null;
			setSelection(null);
		}
	};
	const close = () => {
		returnFocusTo.current = highlightId;
		if (threadOpen) {
			port.closeThread();
		}
		setSelection(null);
		setAnnouncement("Panel closed");
	};
	const message = (agentId: string, prompt: string) => {
		focusHeading.current = true;
		setSelection({ agentId, kind: "agent" });
		port.startThread({ agentId, prompt });
	};
	/** A click in open water puts down the agent card (an open thread stays). */
	const dismiss = () => {
		if (threadOpen || !view) {
			return;
		}
		returnFocusTo.current = null;
		setSelection(null);
	};
	const openUnassigned = () => {
		if (threadOpen) {
			port.closeThread();
		}
		focusHeading.current = true;
		setSelection({ kind: "unassigned" });
	};

	/** Escape steps back out of a thread, then closes the panel. */
	const stepBack = (): boolean => {
		if (threadOpen) {
			back();
			return true;
		}
		if (view) {
			close();
			return true;
		}
		return false;
	};
	const stepBackRef = useRef(stepBack);
	stepBackRef.current = stepBack;

	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key !== "Escape" ||
			event.defaultPrevented ||
			!escapeIsFree(event.target)
		) {
			return;
		}
		if (stepBackRef.current()) {
			event.preventDefault();
		}
	};

	// Escape with nothing focused (after a click in the water) still closes.
	useEffect(() => {
		const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key !== "Escape" ||
				event.defaultPrevented ||
				event.target !== document.body
			) {
				return;
			}
			if (stepBackRef.current()) {
				event.preventDefault();
			}
		};
		document.addEventListener("keydown", onDocumentKeyDown);
		return () => document.removeEventListener("keydown", onDocumentKeyDown);
	}, []);

	// The act layer (when the host sends asks): the creatures swim to their
	// acts, the props sit on the sand and at the front glass (pointer targets
	// only), and the list and the queue carry the keyboard (spec §5 aquarium).
	const fallbackRef = useRef<HTMLHeadingElement>(null);
	const actsView = useActs(snapshot);
	const { acts, nowMs, privacy, unowned } = actsView;
	const actsOn = actsView.enabled && !loading;
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: fallbackRef,
		nowMs,
		port,
		snapshot,
	});
	const { openAsk, openBlocker } = cards;
	const slots = useMemo(() => youSpotSlots(acts, unowned), [acts, unowned]);
	const tally = actTotals(snapshot, acts);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const staged = useMemo(
		() => stageAgents(acts, Number.POSITIVE_INFINITY),
		[acts]
	);
	const budget = overlayBudget(rootWidth || 1280, { domTargets: false });
	const phone = rootWidth > 0 && rootWidth < 640;
	const shownKey = [
		...budget.fill(
			actOverlays(
				staged.onStage,
				slots,
				staged.offStage,
				staged.onStage.find((act) => act.act === "working")?.agentId ?? null,
				{ reduced: reduceMotion }
				// A phone's tank has no room beside the plates for a bubble (asks
				// get none there already): the plates and the list carry it.
			).filter((item) => !(phone && /^(work|done|wait):/.test(item.id)))
		),
	]
		.sort()
		.join("|");
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const onAsk = (askId: string, opener?: HTMLElement) => openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => openBlocker(threadId, agentName, opener);
	const queueOpener = useRef<(() => void) | null>(null);
	const onAskRef = useRef(onAsk);
	onAskRef.current = onAsk;
	const onBlockerRef = useRef(onBlocker);
	onBlockerRef.current = onBlocker;
	const tankActs = useMemo(
		(): AquariumTankActs | null =>
			actsOn
				? {
						acts,
						handlers: {
							clock,
							iconOnly: budget.iconOnly,
							nowMs,
							onAsk: (askId) => onAskRef.current(askId),
							onBlocker: (threadId, agentName) =>
								onBlockerRef.current(threadId, agentName),
							onQueue: () => queueOpener.current?.(),
							privacy,
							reduced: reduceMotion,
							shown,
							snapshot,
						},
						offStage: staged.offStage,
						onStage: staged.onStage,
						owners,
						slots,
					}
				: null,
		[
			acts,
			actsOn,
			budget.iconOnly,
			clock,
			nowMs,
			owners,
			privacy,
			reduceMotion,
			shown,
			slots,
			snapshot,
			staged,
		]
	);
	// With acts the creatures' own signs follow the acts, not the threads:
	// bubbles and the high, quick loop only while working; a pearl only when
	// a run stopped. Keyed on what changed, so a ticking clock rebuilds
	// nothing.
	const actSignature = actsOn
		? [...acts.values()]
				.map(
					(act) =>
						`${act.agentId}:${act.act === "blocked" && act.blockers.some((blocker) => isRedBlocker(blocker)) ? "failed" : act.act}`
				)
				.sort()
				.join("|")
		: "";
	const sceneCreatures = useMemo(() => {
		if (!actSignature) {
			return creatures;
		}
		const byId = new Map(
			actSignature.split("|").map((entry) => {
				const [id = "", state = ""] = entry.split(":");
				return [id, state] as const;
			})
		);
		return creatures.map((creature) => {
			const state = byId.get(creature.id);
			return state
				? {
						...creature,
						// A pearl means a failed run (an interrupted one has none).
						pearl: state === "failed",
						working: state === "working",
					}
				: creature;
		});
	}, [actSignature, creatures]);
	const listActs: CreatureListActs | null = actsOn
		? { acts, clock, nowMs, onAsk, onBlocker, snapshot }
		: null;

	const isEmpty = !loading && snapshot.agents.length === 0;
	const now = Date.now();
	const parts = summaryParts(summary);
	// The HUD tightens on a narrow tank (a phone, or beside the open panel).
	const compactHud = view !== null || (rootWidth > 0 && rootWidth < 720);
	// The tank frames itself beside an open card, unless the card covers the
	// whole stage (a phone): then the tank keeps the stage, out of sight.
	const sheetCover = view ? gameSheetCover(rootWidth) : 0;
	const sheetFrame = sheetCover < rootWidth ? sheetCover : 0;
	let tankLabel = `Underwater reef with ${parts.map((part) => part.text).join(", ")}`;
	if (loading) {
		tankLabel = "Aquarium, filling the tank";
	} else if (actsOn) {
		tankLabel = `Underwater reef: ${actSummaryLine(tally)}`;
	}
	const webglMissing = webgl?.supported === false;
	// Until the reef has drawn (the 3D chunk loads and its shaders compile)
	// the water shows a filling state rather than an empty tank.
	const filling =
		loading || webgl === null || (webgl.supported && !rendered && !isEmpty);

	return (
		<GameShell
			accent="sky"
			busy={loading}
			data-mode={palette.mode}
			hud={
				<>
					<header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between @min-[672px]:gap-3 gap-2 @min-[672px]:p-4 p-2.5">
						{actsOn ? (
							<div className="flex min-w-0 flex-col items-start gap-2">
								<GameTitlePlate
									compact={rootWidth > 0 && rootWidth < 720}
									icon={<Fish strokeWidth={2.25} />}
									keepStatus
									status={
										<span data-testid="aquarium-summary">
											{actSummaryLine(tally)}
										</span>
									}
									title="Aquarium"
								/>
								<BlindSpotCaption snapshot={snapshot} />
							</div>
						) : (
							<GameTitlePlate
								compact={rootWidth > 0 && rootWidth < 720}
								icon={<Fish strokeWidth={2.25} />}
								status={
									loading ? (
										<Skeleton className="mt-1 h-3 w-40" radius="pill" />
									) : (
										<span
											className="tabular-nums"
											data-testid="aquarium-summary"
										>
											{parts.map((part, index) => (
												<span
													// A narrow tank keeps only the live counts.
													className={cn(
														!part.essential && "@max-[620px]:hidden",
														index === 1 && "@max-[620px]:[&>.sep]:hidden"
													)}
													key={part.text}
												>
													{index > 0 ? <span className="sep"> · </span> : null}
													{part.text}
												</span>
											))}
										</span>
									)
								}
								title="Aquarium"
							/>
						)}
						<div
							className={cn(
								"pointer-events-auto flex shrink-0 @min-[672px]:gap-3 gap-2",
								phone ? "flex-col items-end" : "items-start"
							)}
						>
							<GameAction
								compact={rootWidth > 0 && rootWidth < 720}
								disabled={loading}
								icon={<Plus strokeWidth={2.75} />}
								label="New thread"
								onClick={() => port.startThread({})}
							/>
							{actsOn ? (
								<>
									<NeedYouButton
										onAsk={onAsk}
										snapshot={snapshot}
										totals={tally}
									/>
									<QueueButton
										acts={acts}
										clock={clock}
										narrow={phone}
										nowMs={nowMs}
										onAsk={onAsk}
										onBlocker={onBlocker}
										openRef={queueOpener}
										snapshot={snapshot}
										totals={tally}
										unowned={unowned}
									/>
								</>
							) : null}
						</div>
					</header>
					<CreatureList
						actLayer={listActs}
						buttonRefs={buttonRefs}
						creatures={creatures}
						onFocusChange={setFocusedId}
						onSelect={selectAgent}
						palette={palette}
						panelId={panelId}
						sceneReady={webgl?.supported === true}
						selectedId={highlightId}
						view={isoView}
						webglMissing={webglMissing && !loading}
					/>
					{loading || isEmpty ? null : (
						<footer className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end justify-between @min-[672px]:gap-3 gap-2 @min-[672px]:p-4 p-2.5">
							{actsOn ? (
								<GameCounters label="Tank counters">
									{tally.failed > 0 ? (
										<GameCounter
											compact={compactHud}
											icon={<CircleAlert strokeWidth={2.5} />}
											label="failed"
											tone="bad"
											value={tally.failed}
										/>
									) : null}
									<GameCounter
										compact={compactHud}
										icon={<BellRing strokeWidth={2.5} />}
										label="need you"
										tone={tally.needYou > 0 ? "warn" : "info"}
										value={tally.needYou}
									/>
									<GameCounter
										compact={compactHud}
										icon={<Sparkles strokeWidth={2.5} />}
										label="working"
										tone="good"
										value={tally.working}
									/>
								</GameCounters>
							) : (
								<GameCounters label="Tank counters">
									<GameCounter
										compact={compactHud}
										icon={<Sparkles strokeWidth={2.5} />}
										label="working"
										tone="good"
										value={summary.working}
									/>
									<GameCounter
										compact={compactHud}
										icon={<BellRing strokeWidth={2.5} />}
										label="waiting on you"
										tone={summary.yourTurn > 0 ? "warn" : "info"}
										value={summary.yourTurn}
									/>
									{summary.attention > 0 ? (
										<GameCounter
											compact={compactHud}
											icon={<CircleAlert strokeWidth={2.5} />}
											label="needs attention"
											tone="bad"
											value={summary.attention}
										/>
									) : null}
								</GameCounters>
							)}
							<div className="flex flex-col items-end @min-[672px]:gap-3 gap-2">
								{summary.unassigned > 0 ? (
									<button
										aria-label={plural(summary.unassigned, "unassigned thread")}
										className={cn(
											GAME_PLATE,
											"gk-display pointer-events-auto flex h-12 items-center gap-2 whitespace-nowrap ps-2 pe-4 text-[16px] transition-colors hover:bg-(--gk-plate-sunk)",
											GAME_FOCUS
										)}
										onClick={openUnassigned}
										type="button"
									>
										<span
											aria-hidden="true"
											className="grid size-8 place-items-center rounded-lg border-(--gk-edge) border-2 bg-(--gk-warn) text-(--gk-edge)"
										>
											<Inbox className="size-4" strokeWidth={2.5} />
										</span>
										{compactHud
											? summary.unassigned
											: plural(summary.unassigned, "unassigned thread")}
									</button>
								) : null}
								<div className="flex items-end @min-[672px]:gap-3 gap-2">
									<div className="@max-[1100px]:hidden">
										<GameLegend
											items={[
												{
													key: "bubbles",
													label: "Bubbles: working",
													mark: <BubblesGlyph className="size-4" />,
												},
												{
													key: "pearl",
													label: actsOn
														? "Pearl: run failed"
														: "Pearl: needs attention",
													mark: <PearlGlyph className="size-4" />,
												},
												// No 3D view without WebGL, so never offer to drag one.
												...(webglMissing
													? []
													: [
															{
																key: "drag",
																label: (
																	<span className="@max-[860px]:hidden">
																		Drag to pan
																	</span>
																),
																mark: (
																	<Move3d
																		className="@max-[860px]:hidden size-4"
																		strokeWidth={2.5}
																	/>
																),
															},
														]),
												{
													key: "tab",
													label: (
														<span className="@max-[760px]:hidden">
															Visit a creature
														</span>
													),
													mark: (
														<span className="@max-[760px]:hidden rounded-md border-(--gk-edge) border-2 bg-(--gk-plate-sunk) px-1.5 font-semibold text-[12px] leading-4">
															Tab
														</span>
													),
												},
											]}
											label="Legend"
										/>
									</div>
									{webgl?.supported ? (
										<div className="pointer-events-auto">
											<IsoZoomControls view={isoView} />
										</div>
									) : null}
								</div>
							</div>
						</footer>
					)}
					<p aria-live="polite" className="sr-only">
						{announcement}
					</p>
					{actsOn ? <ActAnnouncer sentence={sentence} /> : null}
					{cards.element}
				</>
			}
			label="Aquarium"
			onKeyDown={onRootKeyDown}
			rootRef={rootRef}
			sheet={
				view ? (
					<AquariumPanelActs.Provider
						value={
							actsOn ? { acts, clock, nowMs, onAsk, onBlocker, snapshot } : null
						}
					>
						<AquariumPanel
							activeThreadId={activeThreadId}
							headingRef={headingRef}
							id={panelId}
							key="panel"
							now={now}
							onBack={back}
							onClose={close}
							onMessage={message}
							onOpen={openThread}
							palette={palette}
							snapshot={snapshot}
							threadView={threadView}
							view={view}
						/>
					</AquariumPanelActs.Provider>
				) : null
			}
			testId="interface-aquarium"
		>
			<h1 className="sr-only" ref={fallbackRef} tabIndex={-1}>
				Aquarium
			</h1>
			{actsOn ? (
				<>
					<p className="sr-only">Aquarium: {actSummaryLine(tally)}.</p>
					<AskQueueList
						acts={acts}
						clock={clock}
						fallbackFocus={fallbackRef}
						nowMs={nowMs}
						onAsk={onAsk}
						onBlocker={onBlocker}
						snapshot={snapshot}
						unowned={unowned}
					/>
				</>
			) : null}
			<div
				aria-hidden="true"
				className="absolute inset-0"
				style={{
					// The water color shows while the scene loads (and without WebGL).
					background: `linear-gradient(to bottom, ${cssColor(palette.water.surface)}, ${cssColor(palette.water.mid)} 45%, ${cssColor(palette.water.deep)})`,
				}}
			/>
			<AquariumTank
				actLayer={tankActs}
				creatures={sceneCreatures}
				focusedId={focusedId}
				insets={{
					bottom: compactHud ? 72 : 96,
					left: 16,
					right: 16 + sheetFrame,
					top: compactHud ? 64 : 88,
				}}
				label={tankLabel}
				onDismiss={dismiss}
				onRendered={() => setRendered(true)}
				onSelect={selectAgent}
				palette={palette}
				reduced={reduceMotion}
				sceneReady={webgl?.supported === true}
				selectedId={highlightId}
				view={isoView}
				wallpaper={params?.wallpaper ?? "cream"}
			/>
			<AnimatePresence>
				{filling ? (
					<TankFilling
						count={loading ? 0 : creatures.length}
						key="loading"
						reduced={reduceMotion}
					/>
				) : null}
				{isEmpty ? (
					<motion.div
						animate={{ opacity: 1, transform: "translateY(0px)" }}
						className="absolute inset-0 z-10 flex items-center justify-center p-6"
						initial={
							reduceMotion
								? false
								: { opacity: 0, transform: "translateY(8px)" }
						}
						key="empty"
					>
						<div
							className={cn(
								"flex max-w-sm flex-col items-center gap-3 rounded-3xl px-6 py-6 text-center",
								GLASS
							)}
						>
							<span
								aria-hidden="true"
								className="flex size-11 items-center justify-center rounded-2xl bg-primary/12 text-primary"
							>
								<Fish className="size-5" />
							</span>
							<div className="flex flex-col gap-1">
								<h2 className="font-heading font-semibold text-base text-foreground">
									The tank is empty
								</h2>
								<p className="text-pretty text-muted-foreground text-sm leading-relaxed">
									Each agent swims here as its own creature. Start a thread and
									they will drop in.
								</p>
							</div>
							<Button
								className="mt-1"
								onClick={() => port.startThread({})}
								size="sm"
								type="button"
							>
								<Plus aria-hidden="true" data-icon="inline-start" />
								Start a thread
							</Button>
						</div>
					</motion.div>
				) : null}
				{webglMissing && !loading && !isEmpty ? (
					<motion.div
						animate={{ opacity: 1 }}
						className="pointer-events-none absolute inset-x-0 top-1/3 z-10 flex justify-center px-6"
						initial={reduceMotion ? false : { opacity: 0 }}
						key="no-webgl"
					>
						<p
							className={cn(
								"max-w-sm rounded-2xl px-4 py-3 text-center text-muted-foreground text-sm",
								GLASS
							)}
						>
							The 3D reef needs WebGL, which is off here. Your agents are listed
							below; pick one to see its threads.
						</p>
					</motion.div>
				) : null}
			</AnimatePresence>
		</GameShell>
	);
}
