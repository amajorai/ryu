import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import { Orbit, SquarePen } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	type KeyboardEvent,
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { keepsActOverlay } from "./act-settings.ts";
import { ensureGameDisplayFont } from "./game-font.ts";
import { GAME_KIT_CSS } from "./game-palette.ts";
import {
	actOverlays,
	actSummaryLine,
	actTotals,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import { useGameKitSettings } from "./game3d-settings.tsx";
import {
	ActAnnouncer,
	AskQueueList,
	askOwners,
	BlindSpotCaption,
	NeedYouButton,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import { isInterfaceCovered, useInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import type { PlanetsActView } from "./planets-acts.tsx";
import {
	useElementSize,
	useHudLayout,
	useThemeColors,
	useWebGLSupport,
} from "./planets-hooks.ts";
import {
	PlanetsControls,
	PlanetsLegend,
	PlanetsSystemCard,
} from "./planets-hud.tsx";
import {
	buildSystem,
	columnSystem,
	cyclePlanet,
	holdOrbits,
	ORBIT_PACE,
	OVERVIEW_AZIMUTH,
	plural,
} from "./planets-model.ts";
import {
	createOverlayRegistry,
	PlanetsOverlay,
	STAR_ID,
} from "./planets-overlay.tsx";
import { paletteVars, planetsPalette } from "./planets-palette.ts";
import { PlanetsPanel, type PlanetsPanelView } from "./planets-panel.tsx";
import { GLASS } from "./planets-parts.tsx";
import {
	PLACEHOLDER_FADE_MS,
	PlanetsPlaceholder,
} from "./planets-placeholder.tsx";
import type { CameraApi } from "./planets-scene.tsx";
import { useReducedMotion } from "./reduced-motion.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";

const PlanetsScene = lazy(() => import("./planets-scene.tsx"));

/** A scene at least this tall keeps the planet list open on a narrower screen. */
const ROOMY_HEIGHT = 980;
const ROOMY_WIDTH = 720;
/** Below this width a portrait scene is a phone: column and bottom sheet. */
const PHONE_WIDTH = 560;

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
		target.closest("[data-planets-composer]") !== null &&
		target.value.trim() === ""
	);
}

/**
 * Planets: a small solar system of your work. You are the star at the
 * centre; each agent is a planet on its own orbit (busier agents orbit
 * closer, sized by their threads), and each thread is a moon that glows by
 * status. Click a planet (or pick it from the list, or use the arrow keys)
 * and the camera flies to it while a panel opens with the agent, its threads
 * and a composer. Clicking a moon opens that thread: the host's own
 * conversation, shown in the same panel.
 */
/** The Planets' own settings, resolved from its live params. */
export function planetsSettings(
	params: InterfaceParamsByRenderer["planets"] | undefined
): Required<InterfaceParamsByRenderer["planets"]> {
	// SAFETY: resolveInterfaceParams fills every field (each falls back to
	// its default); only the declared type keeps them optional.
	return resolveInterfaceParams("planets", params) as Required<
		InterfaceParamsByRenderer["planets"]
	>;
}

export function PlanetsInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["planets"]>) {
	const { moonLabels, orbitSpeed } = planetsSettings(params);
	const kitSettings = useGameKitSettings();
	const panelId = useId();
	const rootRef = useRef<HTMLDivElement>(null);
	// A page the host opens over the interface stops the frame loop.
	const covered = useInterfaceCovered(rootRef);
	const sceneRef = useRef<HTMLElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const focusHeading = useRef(false);
	const hoverRef = useRef<string | null>(null);
	const cameraApi = useRef<CameraApi | null>(null);
	const registry = useRef(createOverlayRegistry());
	const reduced = useReducedMotion();
	useEffect(() => {
		ensureGameDisplayFont();
	}, []);
	const webgl = useWebGLSupport();
	const theme = useThemeColors(rootRef);
	const palette = useMemo(() => planetsPalette(theme), [theme]);
	// The act layer (when the host sends asks): moons go by act priority,
	// the planets hold their places so the station's plates can be read,
	// and the planet list and the ask queue carry the keyboard.
	const actsView = useActs(snapshot);
	const { acts, nowMs, privacy, unowned } = actsView;
	const actsOn = actsView.enabled && !loading;
	const system = useMemo(
		() => buildSystem(snapshot, actsOn ? acts : undefined),
		[acts, actsOn, snapshot]
	);
	const [selection, setSelection] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState("");
	// The scene has drawn its first frame: the placeholder star can fade out.
	const [drawn, setDrawn] = useState(false);
	// ...and, once faded, leaves the tree.
	const [sketchGone, setSketchGone] = useState(false);
	const onSceneReady = useCallback(() => setDrawn(true), []);
	// The loading sketch matches the overview only; a thread open at mount
	// starts the camera on its planet instead.
	const [openedOnOverview] = useState(() => threadView === null);
	const sceneSize = useElementSize(sceneRef);

	useEffect(() => {
		if (!drawn) {
			return;
		}
		const timer = window.setTimeout(
			() => setSketchGone(true),
			reduced ? 0 : PLACEHOLDER_FADE_MS + 60
		);
		return () => window.clearTimeout(timer);
	}, [drawn, reduced]);

	const threadOpen = threadView !== null;
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const selectedPlanet = system.planets.find(
		(planet) => planet.id === selection
	);
	// The open thread belongs to the planet it was opened from, else to its
	// first agent's planet.
	const threadPlanet =
		selectedPlanet && activeThread?.agentIds.includes(selectedPlanet.id)
			? selectedPlanet
			: system.planets.find((planet) =>
					activeThread?.agentIds.includes(planet.id)
				);

	let view: PlanetsPanelView | null = null;
	if (threadOpen) {
		view = { kind: "thread", planet: threadPlanet, thread: activeThread };
	} else if (selectedPlanet) {
		view = { kind: "planet", planet: selectedPlanet };
	} else if (selection === STAR_ID) {
		view = { kind: "star" };
	}
	let focusId: string | null = selectedPlanet ? selectedPlanet.id : selection;
	if (threadOpen) {
		focusId = threadPlanet?.id ?? STAR_ID;
	}
	const viewKey = view
		? `${view.kind}:${focusId ?? ""}:${activeThreadId ?? ""}`
		: "";

	// Opening or switching the panel moves focus to its heading.
	useLayoutEffect(() => {
		if (!(viewKey && focusHeading.current)) {
			return;
		}
		focusHeading.current = false;
		headingRef.current?.focus();
	}, [viewKey]);

	const onHover = useCallback((bodyId: string | null) => {
		hoverRef.current = bodyId;
	}, []);

	const select = (bodyId: string) => {
		if (threadOpen) {
			port.closeThread();
		}
		focusHeading.current = true;
		setSelection(bodyId);
		const planet = system.planets.find((item) => item.id === bodyId);
		setAnnouncement(
			planet ? `Visiting ${planet.name}` : "Visiting you, the star"
		);
	};
	const openThread = (threadId: string, bodyId?: string) => {
		focusHeading.current = true;
		if (bodyId) {
			setSelection(bodyId);
		}
		port.openThread(threadId);
	};
	const back = () => {
		port.closeThread();
		focusHeading.current = true;
		setSelection(threadPlanet?.id ?? selection ?? STAR_ID);
	};
	const close = () => {
		if (threadOpen) {
			port.closeThread();
		}
		setSelection(null);
		setAnnouncement("Back to the overview");
	};
	const message = (input: { agentId?: string; prompt: string }) => {
		focusHeading.current = true;
		port.startThread(
			input.agentId
				? { agentId: input.agentId, prompt: input.prompt }
				: { prompt: input.prompt }
		);
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

	/** The scene region's own keys: arrows visit planets, +/- zoom, 0 resets. */
	const onSceneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.target !== event.currentTarget) {
			return;
		}
		if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
			event.preventDefault();
			const next = cyclePlanet(
				system.planets,
				focusId,
				event.key === "ArrowRight" ? 1 : -1
			);
			if (next) {
				select(next);
				// Keep keyboard control in the scene while visiting.
				focusHeading.current = false;
			}
		} else if (event.key === "+" || event.key === "=") {
			event.preventDefault();
			cameraApi.current?.zoom(0.72);
		} else if (event.key === "-" || event.key === "_") {
			event.preventDefault();
			cameraApi.current?.zoom(1.38);
		} else if (event.key === "0") {
			event.preventDefault();
			close();
		} else if (event.key === "Enter" && focusId === null) {
			event.preventDefault();
			select(system.planets[0]?.id ?? STAR_ID);
		}
	};

	const { summary } = system;
	const isEmpty = !loading && snapshot.agents.length === 0;
	// Re-scan the HUD when its pieces change (the legend comes and goes, the
	// card folds while a thread is open).
	const hud = useHudLayout(
		sceneRef,
		`${loading}:${isEmpty}:${view?.kind ?? "none"}`
	);
	const sceneReady = !loading && webgl?.supported === true;
	const placeholder = !sketchGone && webgl?.supported !== false;
	const roomy =
		sceneSize.height >= ROOMY_HEIGHT && sceneSize.width >= ROOMY_WIDTH;
	// A phone: the roster is a bottom sheet, and the planets stand in a
	// column under the star, framed top-down, so every world reads.
	const phone =
		sceneSize.width > 0 &&
		sceneSize.width < PHONE_WIDTH &&
		sceneSize.height > sceneSize.width;
	const shown = useMemo(() => {
		if (phone) {
			return columnSystem(system, OVERVIEW_AZIMUTH);
		}
		return actsOn ? holdOrbits(system) : system;
	}, [actsOn, phone, system]);

	const fallbackRef = useRef<HTMLHeadingElement>(null);
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
	const stageWidth = sceneSize.width || 1280;
	const budget = overlayBudget(stageWidth, { domTargets: false });
	const shownKey = [
		...budget.fill(
			actOverlays(
				staged.onStage,
				slots,
				staged.offStage,
				staged.onStage.find((item) => item.act === "working")?.agentId ?? null,
				{ reduced }
			).filter((item) => keepsActOverlay(item, kitSettings))
		),
	]
		.sort()
		.join("|");
	const overlays = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
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
	const sceneActs = useMemo(
		(): PlanetsActView | null =>
			actsOn
				? {
						acts,
						clock,
						iconOnly: budget.iconOnly,
						nowMs,
						offStage: staged.offStage,
						onAsk: (askId) => onAskRef.current(askId),
						onBlocker: (threadId, agentName) =>
							onBlockerRef.current(threadId, agentName),
						onQueue: () => queueOpener.current?.(),
						onStage: staged.onStage,
						owners,
						privacy,
						shown: overlays,
						slots,
						snapshot,
						width: stageWidth,
					}
				: null,
		[
			acts,
			actsOn,
			budget.iconOnly,
			clock,
			nowMs,
			overlays,
			owners,
			privacy,
			slots,
			snapshot,
			stageWidth,
			staged,
		]
	);
	/** An asking planet's plate answers its ask; the others visit. */
	const askOf = (planetId: string): string | null => {
		const act = actsOn ? acts.get(planetId) : undefined;
		return act?.act === "asking" && act.ask ? act.ask.id : null;
	};
	const actSummary = actSummaryLine(tally);
	const systemCard = (
		<PlanetsSystemCard
			actLayer={
				actsOn
					? {
							acts,
							onAsk,
							summary: actSummary,
							totals: tally,
						}
					: null
			}
			compact={view?.kind === "thread"}
			focusId={focusId}
			loading={loading}
			onHover={onHover}
			onSelect={select}
			palette={palette}
			roomy={roomy}
			sheet={phone}
			sheetFooter={
				loading || isEmpty ? null : (
					<PlanetsLegend bare palette={palette} system={system} />
				)
			}
			system={system}
		/>
	);
	// The HUD actions: New thread, the camera, and with acts Need you and Queue.
	const controls = (
		<PlanetsControls
			compact={sceneSize.width > 0 && sceneSize.width < 720}
			disabled={loading}
			onNewThread={() => port.startThread({})}
			onOverview={() => {
				close();
				cameraApi.current?.overview();
			}}
			onZoom={(factor) => cameraApi.current?.zoom(factor)}
			showCamera={sceneReady}
			stacked={phone && actsOn}
		>
			{actsOn ? (
				<>
					<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={tally} />
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
		</PlanetsControls>
	);
	const now = Date.now();
	let sceneLabel = `Solar system: you at the centre, ${plural(summary.agents, "planet")}, ${summary.working} working, ${summary.waitingOnYou} waiting on you. Arrow keys visit planets, plus and minus zoom.`;
	if (loading) {
		sceneLabel = "Solar system, loading";
	} else if (actsOn) {
		sceneLabel = `Solar system: ${actSummary}. Arrow keys visit planets, plus and minus zoom.`;
	}

	return (
		<div
			className="relative flex size-full min-h-0 overflow-hidden bg-background text-foreground"
			data-game-accent="grape"
			data-game-shell=""
			data-mode={palette.mode}
			data-testid="interface-planets"
			onKeyDown={onRootKeyDown}
			ref={rootRef}
			style={paletteVars(palette)}
		>
			<style>{GAME_KIT_CSS}</style>
			<section
				aria-busy={loading}
				aria-label="Planets"
				className="@container relative isolate min-h-0 min-w-0 flex-1 overflow-hidden"
				ref={sceneRef}
			>
				<div
					aria-hidden="true"
					className="absolute inset-0 -z-10"
					style={{ background: palette.sky.background }}
				/>
				<div
					aria-label={sceneLabel}
					aria-roledescription="3D solar system"
					className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
					onKeyDown={onSceneKeyDown}
					role="application"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the scene is a keyboard-driven 3D surface (role="application").
					tabIndex={0}
				>
					{sceneReady ? (
						<Suspense fallback={null}>
							<PlanetsScene
								active={!covered}
								acts={sceneActs}
								cameraApi={cameraApi}
								focusId={focusId}
								hoverRef={hoverRef}
								hud={hud}
								onHover={onHover}
								onReady={onSceneReady}
								onSelect={select}
								orbitPace={ORBIT_PACE[orbitSpeed]}
								palette={palette}
								quality={webgl.quality}
								reduced={reduced}
								registry={registry}
								system={shown}
							/>
						</Suspense>
					) : null}
				</div>

				<div className="pointer-events-none absolute inset-0 z-20 flex flex-col justify-between @min-[672px]:gap-3 gap-2 @min-[672px]:p-4 p-2.5">
					<div
						className={cn(
							"flex min-h-0 items-start gap-3",
							phone ? "justify-end" : "justify-between"
						)}
					>
						{phone ? null : systemCard}
						{actsOn ? (
							<div className="flex min-w-0 shrink-0 flex-col items-end gap-2">
								{controls}
								<BlindSpotCaption
									className="max-w-72 text-end"
									snapshot={snapshot}
								/>
							</div>
						) : (
							controls
						)}
					</div>
					{phone ? (
						<div className="flex min-h-0 items-end">{systemCard}</div>
					) : null}
					{loading || isEmpty || phone ? null : (
						<div className="flex items-end justify-between gap-3">
							<PlanetsLegend palette={palette} system={system} />
						</div>
					)}
				</div>

				{sceneReady ? (
					<PlanetsOverlay
						askOf={askOf}
						focusId={focusId}
						moonLabels={moonLabels}
						onAsk={onAsk}
						onHover={onHover}
						onOpenThread={openThread}
						onSelect={select}
						palette={palette}
						registry={registry}
						system={system}
					/>
				) : null}

				{placeholder ? (
					<PlanetsPlaceholder
						fading={drawn}
						hud={hud}
						overview={openedOnOverview}
						palette={palette}
						reduced={reduced}
						size={sceneSize}
						system={system}
					/>
				) : null}
				<AnimatePresence>
					{isEmpty ? (
						<motion.div
							animate={{ opacity: 1, transform: "translateY(0px)" }}
							className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-6 sm:bottom-6"
							initial={
								reduced ? false : { opacity: 0, transform: "translateY(8px)" }
							}
							key="empty"
						>
							<div
								className={cn(
									"pointer-events-auto flex max-w-sm flex-col items-center gap-3 rounded-3xl px-6 py-6 text-center",
									GLASS
								)}
							>
								<span
									aria-hidden="true"
									className="flex size-11 items-center justify-center rounded-2xl bg-primary/12 text-primary"
								>
									<Orbit className="size-5" />
								</span>
								<div className="flex flex-col gap-1">
									<h2 className="font-heading font-semibold text-base text-foreground">
										No planets yet
									</h2>
									<p className="text-pretty text-muted-foreground text-sm leading-relaxed">
										Each agent orbits you as its own planet, with its threads as
										moons. Add an agent or start a thread to fill the sky.
									</p>
								</div>
								<Button
									className="mt-1"
									onClick={() => port.startThread({})}
									size="sm"
									type="button"
								>
									<SquarePen aria-hidden="true" data-icon="inline-start" />
									Start a thread
								</Button>
							</div>
						</motion.div>
					) : null}
					{!loading && webgl?.supported === false ? (
						<motion.p
							animate={{ opacity: 1 }}
							className={cn(
								"absolute inset-x-0 bottom-24 z-20 mx-auto w-fit max-w-sm rounded-2xl px-4 py-3 text-center text-muted-foreground text-sm",
								GLASS
							)}
							initial={reduced ? false : { opacity: 0 }}
							key="no-webgl"
						>
							The 3D view needs WebGL, which is off here. Your planets are still
							listed above.
						</motion.p>
					) : null}
				</AnimatePresence>
				<p aria-live="polite" className="sr-only">
					{announcement}
				</p>
				{actsOn ? (
					<>
						<h2 className="sr-only" ref={fallbackRef} tabIndex={-1}>
							Planets: {actSummary}.
						</h2>
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
						<ActAnnouncer sentence={sentence} />
						{cards.element}
					</>
				) : null}
			</section>
			{view ? (
				<PlanetsPanel
					activeThreadId={activeThreadId}
					headingRef={headingRef}
					id={panelId}
					now={now}
					onBack={back}
					onClose={close}
					onMessage={message}
					onOpen={(threadId) => openThread(threadId)}
					palette={palette}
					snapshot={snapshot}
					system={system}
					threadView={threadView}
					view={view}
				/>
			) : null}
		</div>
	);
}
