import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import {
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
import { ensureGameDisplayFont } from "./game-font.ts";
import { GAME_KIT_CSS } from "./game-palette.ts";
import { useGameKitSettings } from "./game3d-settings.tsx";
import { BlindSpotCaption } from "./interface-ask-card.tsx";
import { useInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
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
	PlanetsActA11y,
	PlanetsActButtons,
	usePlanetsActLayer,
} from "./planets-interface-acts.tsx";
import { usePlanetsKeys } from "./planets-interface-keys.ts";
import { PlanetsNotices } from "./planets-interface-notices.tsx";
import {
	PHONE_WIDTH,
	planetsSettings,
	ROOMY_HEIGHT,
	ROOMY_WIDTH,
} from "./planets-interface-settings.ts";
import { planetsView } from "./planets-interface-view.ts";
import {
	buildSystem,
	columnSystem,
	holdOrbits,
	ORBIT_PACE,
	OVERVIEW_AZIMUTH,
} from "./planets-model.ts";
import {
	createOverlayRegistry,
	PlanetsOverlay,
	STAR_ID,
} from "./planets-overlay.tsx";
import { paletteVars, planetsPalette } from "./planets-palette.ts";
import { PlanetsPanel } from "./planets-panel.tsx";
import {
	PLACEHOLDER_FADE_MS,
	PlanetsPlaceholder,
} from "./planets-placeholder.tsx";
import type { CameraApi } from "./planets-scene.tsx";
import { useReducedMotion } from "./reduced-motion.ts";
import { useActs } from "./use-acts.ts";

export { planetsSettings } from "./planets-interface-settings.ts";

const PlanetsScene = lazy(() => import("./planets-scene.tsx"));

/**
 * Planets: a small solar system of your work. You are the star at the
 * centre; each agent is a planet on its own orbit (busier agents orbit
 * closer, sized by their threads), and each thread is a moon that glows by
 * status. Click a planet (or pick it from the list, or use the arrow keys)
 * and the camera flies to it while a panel opens with the agent, its threads
 * and a composer. Clicking a moon opens that thread: the host's own
 * conversation, shown in the same panel.
 */
export function PlanetsInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["planets"]>) {
	const { moonLabels, orbitSpeed } = planetsSettings(params);
	const tl = useLiteralMessages();
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
	const { acts } = actsView;
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
	const { focusId, threadPlanet, view } = planetsView({
		activeThreadId,
		selection,
		snapshot,
		system,
		threadOpen,
	});
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
	const { onRootKeyDown, onSceneKeyDown } = usePlanetsKeys({
		cameraApi,
		close,
		focusHeading,
		focusId,
		planets: system.planets,
		rootRef,
		select,
		stepBack,
	});

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

	const actLayer = usePlanetsActLayer({
		actsOn,
		actsView,
		kitSettings,
		port,
		reduced,
		sceneSize,
		snapshot,
	});
	const { actSummary, askOf, onAsk, sceneActs, tally } = actLayer;
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
				<PlanetsActButtons
					actsView={actsView}
					layer={actLayer}
					phone={phone}
					snapshot={snapshot}
				/>
			) : null}
		</PlanetsControls>
	);
	const now = Date.now();
	let sceneLabel = tl(
		"Solar system: you at the centre, {agents, plural, one {{agentCount} planet} other {{agentCount} planets}}, {working} working, {waitingOnYou} waiting on you. Arrow keys visit planets, plus and minus zoom.",
		{
			agentCount: String(summary.agents),
			agents: summary.agents,
			waitingOnYou: summary.waitingOnYou,
			working: summary.working,
		}
	);
	if (loading) {
		sceneLabel = "Solar system, loading";
	} else if (actsOn) {
		sceneLabel = tl(
			"Solar system: {actSummary}. Arrow keys visit planets, plus and minus zoom.",
			{ actSummary }
		);
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
				<PlanetsNotices
					isEmpty={isEmpty}
					loading={loading}
					port={port}
					reduced={reduced}
					webgl={webgl}
				/>
				<p aria-live="polite" className="sr-only">
					{announcement}
				</p>
				{actsOn ? (
					<PlanetsActA11y
						actsView={actsView}
						layer={actLayer}
						snapshot={snapshot}
					/>
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
