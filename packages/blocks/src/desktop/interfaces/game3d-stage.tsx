/* eslint-disable react/no-unknown-property */
import { Canvas } from "@react-three/fiber";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { type Scene3dTheme, sunDirection } from "./game3d-palette.ts";
import { Bloom } from "./game3d-post.tsx";
import { Glimmers, useGlowCanvas } from "./game3d-sky.tsx";
import { FOCUS_ZOOM, IsoCamera } from "./game3d-stage-camera.tsx";
import { PlateDeclutter } from "./game3d-stage-declutter.ts";
import {
	type IsoBounds,
	type IsoInsets,
	type IsoPlateFit,
	type IsoPortrait,
	NO_INSETS,
	sceneTheme,
} from "./game3d-stage-framing.ts";
import {
	FirstFrame,
	KeepDrawing,
	SceneLights,
	SeaStars,
} from "./game3d-stage-scene.tsx";
import { focusToward, isFocusKey } from "./game3d-stage-targets.tsx";
import {
	type IsoView,
	StageCramped,
	StageQuality,
	useCrampedStage,
	useStageVisible,
	useWebGLProbe,
} from "./game3d-stage-view.tsx";
import {
	CURVE_UNIFORMS,
	FADE_UNIFORMS,
	QUALITY,
	type RenderQuality,
	setLook,
} from "./game3d-toon.ts";

export { IsoCamera } from "./game3d-stage-camera.tsx";
export { declutterPlates, PlateDeclutter } from "./game3d-stage-declutter.ts";
export {
	fitIso,
	ISO_ANGLE,
	type IsoAngle,
	type IsoBounds,
	type IsoFit,
	type IsoInsets,
	type IsoPlateFit,
	type IsoPortrait,
	isoFraming,
	isPortraitStage,
	PORTRAIT_PITCH,
	sceneTheme,
} from "./game3d-stage-framing.ts";
export {
	DECLUTTER_MS,
	holdPlateRoots,
	plateFit,
	stagePlates,
} from "./game3d-stage-plate-dom.ts";
export { SceneLights, SeaStars } from "./game3d-stage-scene.tsx";
export { IsoLabel, IsoMarker } from "./game3d-stage-targets.tsx";
export {
	type IsoView,
	IsoZoomControls,
	StageCramped,
	StageQuality,
	useFocusOnOpen,
	useGameNight,
	useIsoView,
	useStageCramped,
	useStageQuality,
	useWebGLProbe,
} from "./game3d-stage-view.tsx";

/**
 * The 3D game kit: every game is a cosy, cel-shaded isometric diorama in
 * one shared art style (soft toon light with ink outlines, lush swaying
 * grass, rounded props, chibi villagers with big anime eyes), drawn on one
 * canvas under the 2D game kit's HUD (`game-shell.tsx`).
 *
 * Files (all `game3d-*`):
 * - `game3d-stage.tsx` (this file): `IsoStage`, the canvas, camera, light
 *   and interaction shell; `useIsoView` + `IsoZoomControls` for the zoom
 *   plate; `useGameNight`, `useReducedMotion`, `useWebGLProbe`.
 * - `game3d-ground.tsx`: `IsoIsland` (rounded island with an earth cliff
 *   in the sea), `IslandGrass`, `islandFor`.
 * - `game3d-villager.tsx`: `Villagers` (one chibi per agent, posed by
 *   state, with a name plate that is its control), `useVillagerLooks`,
 *   `GroundRing`, and the lower-level `VillagerRig`.
 * - `game3d-life.ts` (pure) + `game3d-life.tsx` (render): the behaviour
 *   layer that makes villagers act things out. See "Villager life" below.
 * - `game3d-props.tsx`: instanced `TreeGrove`, `Bushes`, `Fences`,
 *   `LampPosts`, `Benches`, `Crates`, `Signs`, `PathStones`, `Rocks`,
 *   `Pond`.
 * - `game3d-cottages.tsx`: `Cottages` (rounded storybook houses from
 *   `CottageSpec`s, with chimney smoke, porch lamps and lit windows at
 *   night), plus `buildCottages` and `CottageMeshes` for custom layouts.
 * - `game3d-grass.tsx` (`GrassBlades`, `FlowerClusters`),
 *   `game3d-materials.tsx` (`ToonMaterial`, `ToonMesh`, `InkMaterial`),
 *   `game3d-instances.tsx` (`InstancedParts`), `game3d-toon.ts` (the
 *   shader patches, and `CEL_GLSL` for scenes with their own shaders),
 *   `game3d-sky.tsx`, `game3d-post.tsx` (bloom).
 * - `game3d-palette.ts`: every scene colour (`GAME3D_DAY`/`GAME3D_NIGHT`,
 *   prop and villager colours). No colour literals anywhere else.
 *
 * How a game builds its diorama:
 * 1. Lay the world out in world units around the origin (x right, z
 *    toward the viewer, y up; one unit is about a villager's height).
 *    Keep that layout pure (a `*-model.ts`) so it is testable.
 * 2. Render `<GameShell>` as usual; its child is `<IsoStage>`:
 *    `<IsoStage label="Farm" bounds={...} insets={...} night={night}
 *    view={view} fallback={<PlainList />}>{diorama}</IsoStage>`.
 *    `bounds` is the box the camera fits (fit-to-content between the HUD
 *    `insets`); the sea and sky fill every edge beyond it. `fill` (about
 *    1.15) frames tighter so the edges bleed and villagers read bigger. `night` comes
 *    from `useGameNight(rootRef)` (dark theme = night: lamps on, warm
 *    windows, stars). `fallback` is what renders without WebGL (and in
 *    tests): a plain, keyboard-usable list of the same things.
 * 3. Inside, build the diorama from kit pieces: `<IsoIsland shape={...}
 *    theme={theme} paint={...} />`, `<IslandGrass avoid={...} />`, props,
 *    and game-specific meshes made with `ToonMesh`/`InstancedParts` +
 *    `ToonMaterial` (colours from your `*-palette.ts`). Use `theme` from
 *    the render prop: `{({ quality, theme }) => ...}` children get the
 *    day or night scene theme and the quality budget (for the grass).
 * 4. Place agents with `<Villagers villagers={...} onSelect={...}
 *    selectedId={...} />`: each `VillagerSpec` gives the agent's looks
 *    (`useVillagerLooks`), where it stands, its `pose` (`idle`, `working`,
 *    `needs-you`, `failed`, `waiting`) and an accessible `label`. Their
 *    name plates are the controls: focusable buttons, clickable, with the
 *    kit's focus ring.
 * 5. Make other interactive objects reachable the same way: put a
 *    `<IsoMarker at={[x, y, z]} label="..." onSelect={...}>` (a kit plate
 *    billboarded in the scene) over each. Every plate carries
 *    `data-iso-target`, so Tab walks them and the arrow keys move focus in
 *    reading order (`game3d-focus.ts`): rows top to bottom, left to right
 *    by screen position. Plates with a game order (advent doors, path
 *    stops, quiz cells) take `order={n}` (`data-iso-order`) and the arrows
 *    step through that order instead. Plates never overlap: the stage
 *    nudges crowded ones apart (`game3d-plates.ts`, at most a plate's
 *    height); give a non-control board `data-iso-plate` to join in
 *    (`IsoLabel` does).
 * 6. Wire selection to the `GameSheet`: `onSelect` opens the sheet; pass
 *    `gameSheetCover(width)` as `insets.right` while it is open so the
 *    diorama refits beside it.
 *    Call `useFocusOnOpen(view, id)` with the sheet's object id: the camera
 *    glides (pan and zoom) to the plate carrying `data-iso-focus={id}`
 *    (villager plates use their spec id; give an `IsoMarker` a `focusId`).
 *    `view.focusOnTarget(id)` does the same on demand.
 * 7. Put `<IsoZoomControls view={view} />` in a HUD slot (bottom right):
 *    drag pans, the wheel and +/- zoom, within bounds. A drag of more than
 *    5px never ends in a click on the scene.
 *
 * Villager life (game3d-life.*): give a `VillagerSpec` a `life` script
 * and pass the game's waypoints as `<Villagers paths={...}>`. A script is
 * `{ key, steps, idle? }`; steps are generic and run in order:
 * `goTo` (walk a waypoint id or point along the paths, turning to face
 * where it goes), `place` (snap, e.g. a newcomer at the door), `face`,
 * `pose` (`work`, `wave`, `cheer`, `stumble`, `slump`, `look`, `sip`,
 * `stretch`, `chat`, `idle`), `carry` (an item in both hands, drawn in
 * them; null puts it down), `say` (a bubble on the name plate: an icon
 * and at most five words, timed or until the next `say`), `wait`, and
 * `effect` (`sparkle`, `smoke`, `puff`). Change `key` whenever the state
 * the script shows changes: the villager plays the new steps from wherever
 * it is, then loops `idle`. Villagers on stage at the first frame start
 * settled at their script's end; newcomers and later changes play in.
 * Under reduced motion every script snaps to its settled end (no walking,
 * bubbles still shown). Helpers: `meetUp(a, b, { handOff })` gives two
 * villagers steps to meet halfway and chat (or hand an item over),
 * `ambientLife(seed, { nearby })` a subtle idle loop, `changedScripts` the
 * ids whose key changed. Everything is deterministic and unit-tested in
 * `game3d-life.test.ts`; `LifeDemo` (`game3d-life-demo.tsx`) shows it all.
 *
 * Phones and portrait stages: when the space between the insets is taller
 * than wide, the camera tilts steeper (`PORTRAIT_PITCH`, so depth reads
 * taller) and fits all of `bounds` across, never cropping the sides. Pass
 * `portrait={{ bounds, yaw, pitch, fill }}` to frame differently there:
 * `bounds` a tighter content box (else it zooms on to the plates once they
 * are placed: `fitPlates`; `fitPlates={{ above, below }}` on the stage
 * does the same on wide stages), `yaw` to turn a wide diorama so its long side runs up the screen
 * (keep it within about 20 degrees of the default 45 so the back walls stay
 * at the back). `isPortraitStage(width, height, insets)` tells a game when
 * to lay its world out taller.
 *
 * Act-layer DOM contract (what the useful-state browser checks look for,
 * apps/desktop/e2e/harness/useful-state-checks.ts):
 * - `data-act-agent="<agent id>"` on each agent's one per-agent target:
 *   `VillagerSpec.actAgent`, `IsoMarker actAgent`, `ActAgentList` rows, and
 *   a game's own targets (town buildings, list rows, hotbar slots).
 * - `data-iso-target` (kit plates, markers and act props, set by the kit) or
 *   `data-act-scene` (a game's own in-scene overlay button) marks a target
 *   as in the scene.
 * - `data-you-spot="slot|tray|tally"` on you-spot overlays:
 *   `VillagerSpec.youSpot` / `IsoMarker youSpot` for queue plates,
 *   `NoticePost`, `TrayItem`, `TallyPlate scope="you"`.
 * - `data-tally="you|off"` (`TallyPlate scope`), `data-act-target` (act prop
 *   openers), `data-icon-only` (collapsed plates), `data-budgeted-overlay`
 *   (status overlays) and `data-agent-list` (a game's per-agent list) are
 *   set by the kit where it draws them; a game drawing its own equivalent
 *   sets the same attribute on it.
 *
 * Performance: one canvas, dpr capped at 2, instanced props and grass, no
 * per-frame allocation; the frame loop stops when the stage is hidden and
 * only draws on demand under reduced motion or when `animate` is false.
 */
/**
 * Whether the viewer prefers reduced motion (the system setting or the host's
 * own "animations off"), known from the first render: a scene that starts
 * animated and then turns still would settle wherever its first frames left it.
 */
export { useReducedMotion } from "./reduced-motion.ts";

/** What a diorama is drawn with: the scene theme and the GPU budget. */
export interface IsoScene {
	quality: RenderQuality;
	theme: Scene3dTheme;
}

export interface IsoStageProps {
	/** Something moves (villagers, wind): draw every frame (unless reduced). */
	animate?: boolean;
	bounds: IsoBounds;
	/** The diorama, given the day or night scene theme and render quality. */
	children: (scene: IsoScene) => ReactNode;
	/** What renders without WebGL (and in tests): the same things as a list. */
	fallback: ReactNode;
	/**
	 * How much closer than fit-to-content the camera frames: 1 (default)
	 * keeps all of `bounds` in view; 1.15 to 1.2 lets the diorama's edges
	 * bleed off the frame so its villagers read bigger.
	 */
	fill?: number;
	/** Zoom on to the plates on wide stages too (portrait ones always do). */
	fitPlates?: IsoPlateFit;
	/** How far opening an object zooms in at least (default 1.45). */
	focusZoom?: number;
	insets?: IsoInsets;
	/** What the diorama shows, and how to use it (the stage's name). */
	label: string;
	/** Fireflies at night and pollen by day over the island. */
	motes?: boolean;
	night: boolean;
	/** How to frame on a portrait stage (a phone); see the header. */
	portrait?: IsoPortrait;
	reducedMotion: boolean;
	view?: IsoView;
}

/**
 * The diorama stage: one canvas with the isometric camera, the shared
 * lights and toon look, sea to every edge, and the frame loop managed for
 * visibility and reduced motion. A sea-coloured cover hides the canvas
 * until its first frame, so nothing flashes white.
 */
export function IsoStage({
	animate = true,
	bounds,
	children,
	fallback,
	fill = 1,
	fitPlates,
	focusZoom = FOCUS_ZOOM,
	insets = NO_INSETS,
	label,
	motes = true,
	night,
	portrait,
	reducedMotion,
	view,
}: IsoStageProps) {
	const tl = useLiteralMessages();
	const root = useRef<HTMLDivElement>(null);
	const probe = useWebGLProbe();
	const visible = useStageVisible(root);
	const cramped = useCrampedStage(root);
	const [drawn, setDrawn] = useState(false);
	const theme = sceneTheme(night);
	const sea = theme.water ?? theme.sky;
	useEffect(() => {
		const element = root.current;
		if (!element) {
			return;
		}
		const keydown = (event: KeyboardEvent) => {
			if (event.altKey || event.ctrlKey || event.metaKey) {
				return;
			}
			// Typing in a field inside the stage never moves focus or the camera.
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, textarea, select, [contenteditable]")) {
				return;
			}
			if (isFocusKey(event.key)) {
				if (focusToward(element, event.key)) {
					event.preventDefault();
				}
			} else if (event.key === "+" || event.key === "=") {
				view?.send("in");
			} else if (event.key === "-") {
				view?.send("out");
			} else if (event.key === "0") {
				view?.send("reset");
			}
		};
		element.addEventListener("keydown", keydown);
		return () => element.removeEventListener("keydown", keydown);
	}, [view]);
	// The HUD insets for plate separation (stageInsets), written outside the
	// rendered markup so a game's static snapshot of the stage is unchanged.
	useLayoutEffect(() => {
		root.current?.setAttribute(
			"data-iso-insets",
			`${insets.top} ${insets.right} ${insets.bottom} ${insets.left}`
		);
	}, [insets.bottom, insets.left, insets.right, insets.top]);
	let frameloop: "always" | "demand" | "never" = "demand";
	if (!visible) {
		frameloop = "never";
	} else if (animate && !reducedMotion) {
		frameloop = "always";
	}
	const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
	const quality: RenderQuality = probe?.quality ?? "low";
	return (
		<div
			aria-label={label}
			className="relative size-full overflow-hidden"
			data-iso-fit={probe && !probe.supported ? "none" : "pending"}
			data-testid="iso-stage"
			ref={root}
			role="group"
			style={{ background: sea }}
		>
			{probe?.supported ? (
				<Canvas
					camera={{ far: 400, near: 0.1, position: [30, 30, 30], zoom: 40 }}
					dpr={QUALITY[quality].dpr}
					frameloop={frameloop}
					gl={{ antialias: false, powerPreference: "high-performance" }}
					orthographic
					shadows="soft"
					style={{ inset: 0, position: "absolute" }}
				>
					<StageContents
						bounds={bounds}
						fill={fill}
						fitPlates={fitPlates}
						focusZoom={focusZoom}
						insets={insets}
						motes={motes}
						portrait={portrait}
						quality={quality}
						reducedMotion={reducedMotion}
						span={span}
						theme={theme}
						view={view}
					>
						<StageQuality.Provider value={quality}>
							<StageCramped.Provider value={cramped}>
								{children({ quality, theme })}
							</StageCramped.Provider>
						</StageQuality.Provider>
					</StageContents>
					<KeepDrawing active={frameloop === "always"} />
					<FirstFrame onReady={() => setDrawn(true)} />
				</Canvas>
			) : null}
			{probe?.supported ? null : fallback}
			{probe === null || (probe.supported && !drawn) ? (
				<div
					className={cn("pointer-events-none absolute inset-0")}
					role="status"
					style={{ background: sea }}
				>
					<span className="sr-only">{tl("Loading {label}", { label })}</span>
				</div>
			) : null}
		</div>
	);
}

function StageContents({
	bounds,
	children,
	fill,
	fitPlates,
	focusZoom,
	insets,
	motes,
	portrait,
	quality,
	reducedMotion,
	span,
	theme,
	view,
}: {
	bounds: IsoBounds;
	children: ReactNode;
	fill: number;
	fitPlates?: IsoPlateFit;
	focusZoom: number;
	insets: IsoInsets;
	motes: boolean;
	portrait?: IsoPortrait;
	quality: RenderQuality;
	reducedMotion: boolean;
	span: number;
	theme: Scene3dTheme;
	view?: IsoView;
}) {
	const glow = useGlowCanvas();
	const budget = QUALITY[quality];
	// The diorama is flat and nothing fades: clear what a world left behind.
	CURVE_UNIFORMS.ryuCurve.value = 0;
	FADE_UNIFORMS.ryuFadeRadius.value = 0;
	FADE_UNIFORMS.ryuFadeNear.value = 0;
	useMemo(() => setLook({ ...theme, sun: sunDirection(theme) }), [theme]);
	const width = bounds.maxX - bounds.minX;
	const depth = bounds.maxZ - bounds.minZ;
	return (
		<>
			<color args={[theme.water ?? theme.sky]} attach="background" />
			<SceneLights shadowMap={budget.shadowMap} span={span} theme={theme} />
			<IsoCamera
				bounds={bounds}
				fill={fill}
				focusZoom={focusZoom}
				insets={insets}
				plates={fitPlates}
				portrait={portrait}
				reducedMotion={reducedMotion}
				view={view}
			/>
			<PlateDeclutter reducedMotion={reducedMotion} />
			{children}
			{motes && !reducedMotion ? (
				<Glimmers
					count={
						theme.night ? Math.round(budget.pollen * 1.2) : budget.pollen / 2
					}
					glow={glow}
					height={depth}
					theme={theme}
					width={width}
				/>
			) : null}
			{theme.night ? <SeaStars glow={glow} span={span} /> : null}
			<Bloom samples={quality === "high" ? 4 : 2} strength={theme.bloom} />
		</>
	);
}
