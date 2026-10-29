/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { cn } from "@ryu/ui/lib/utils";
import { Maximize, Minus, Plus } from "lucide-react";
import {
	createContext,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { DirectionalLight, OrthographicCamera, Vector3 } from "three";
import { GAME_FOCUS, GAME_PLATE, GameIconButton } from "./game-hud.tsx";
import {
	type FocusKey,
	type FocusPlate,
	nextFocus,
	ROW_TOLERANCE,
} from "./game3d-focus.ts";
import { ISLAND_MARGIN } from "./game3d-island.ts";
import { FILL_DIRECTION, FILL_INTENSITY } from "./game3d-lawn.ts";
import { CurvedPointsMaterial } from "./game3d-materials.tsx";
import { ADDITIVE_BLENDING, jitter } from "./game3d-math.ts";
import {
	GAME3D_DAY,
	GAME3D_NIGHT,
	type Scene3dTheme,
	sunDirection,
	type Vec3,
} from "./game3d-palette.ts";
import {
	CRAMPED_STAGE,
	type FitBox,
	fitBoxes,
	type PlateBox,
	partOnStage,
	plateFitBox,
} from "./game3d-plates.ts";
import { Bloom } from "./game3d-post.tsx";
import { Glimmers, useGlowCanvas } from "./game3d-sky.tsx";
import {
	CURVE_UNIFORMS,
	FADE_UNIFORMS,
	probeWebGL,
	QUALITY,
	type RenderQuality,
	setLook,
	type WebGLProbe,
} from "./game3d-toon.ts";
import { isInterfaceCovered } from "./interface-keys.ts";

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

/** The fixed isometric angle: yaw 45 degrees, pitch about 32 degrees. */
const YAW = Math.PI / 4;
const PITCH = 0.56;
const CAMERA_DISTANCE = 60;
/** Zoom range on top of the fitted zoom, and the step per +/- press. */
const MAX_ZOOM = 3;
const MIN_ZOOM = 0.85;
const ZOOM_STEP = 1.25;
/** Portrait stages tilt steeper so the diorama's depth reads taller. */
export const PORTRAIT_PITCH = 0.78;
/** Portrait fits let the frame bleed at most this much (the island rim). */
const PORTRAIT_FILL = 1.06;

/** The box the camera keeps in frame, in world units. */
export interface IsoBounds {
	maxX: number;
	maxZ: number;
	minX: number;
	minZ: number;
	/** Height of the tallest content (roofs, trees, plates). */
	top?: number;
}

/** Pixels kept clear for the HUD on each side of the stage. */
export interface IsoInsets {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

const NO_INSETS: IsoInsets = { bottom: 0, left: 0, right: 0, top: 0 };

type ViewListener = (command: "in" | "out" | "reset") => void;

type FocusListener = (targetId: string) => void;

/** The stage's zoom, driven by the HUD's zoom plate and the keyboard. */
export interface IsoView {
	/**
	 * Smoothly pans (and zooms in a little) so the plate marked
	 * `data-iso-focus={targetId}` sits in the middle of the uncovered
	 * stage: call it when a sheet opens on that object.
	 */
	focusOnTarget: (targetId: string) => void;
	listen: (listener: ViewListener) => () => void;
	listenFocus: (listener: FocusListener) => () => void;
	send: (command: "in" | "out" | "reset") => void;
}

/** A zoom channel shared by an `IsoStage` and its `IsoZoomControls`. */
export function useIsoView(): IsoView {
	return useMemo(() => {
		const listeners = new Set<ViewListener>();
		const focusListeners = new Set<FocusListener>();
		return {
			focusOnTarget: (targetId) => {
				for (const listener of focusListeners) {
					listener(targetId);
				}
			},
			listenFocus: (listener) => {
				focusListeners.add(listener);
				return () => focusListeners.delete(listener);
			},
			listen: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			send: (command) => {
				for (const listener of listeners) {
					listener(command);
				}
			},
		};
	}, []);
}

/**
 * Focuses the stage on `targetId` whenever it changes to a new object (a
 * sheet opened on it). Waits two frames so the stage has refitted beside
 * the sheet before it measures the plate.
 */
export function useFocusOnOpen(
	view: IsoView | undefined,
	targetId: string | null | undefined
): void {
	useEffect(() => {
		if (!(view && targetId)) {
			return;
		}
		let frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(() => view.focusOnTarget(targetId));
		});
		return () => cancelAnimationFrame(frame);
	}, [targetId, view]);
}

/** The HUD's zoom plate: zoom in, zoom out, and fit the whole diorama. */
export function IsoZoomControls({ view }: { view: IsoView }) {
	return (
		<div
			aria-label="Zoom"
			className={cn(
				GAME_PLATE,
				"pointer-events-auto flex flex-col items-center gap-1.5 p-1.5"
			)}
			role="group"
		>
			<GameIconButton label="Zoom in" onClick={() => view.send("in")}>
				<Plus aria-hidden="true" className="size-5" />
			</GameIconButton>
			<GameIconButton label="Zoom out" onClick={() => view.send("out")}>
				<Minus aria-hidden="true" className="size-5" />
			</GameIconButton>
			<GameIconButton label="Fit to view" onClick={() => view.send("reset")}>
				<Maximize aria-hidden="true" className="size-4" />
			</GameIconButton>
		</div>
	);
}

/** The stage's render quality, for kit pieces that trim on a slow renderer. */
export const StageQuality = createContext<RenderQuality>("high");

/** The render quality of the stage this is drawn in ("high" outside one). */
export function useStageQuality(): RenderQuality {
	return useContext(StageQuality);
}

/**
 * Whether the stage is cramped: shorter than CRAMPED_STAGE, as when a
 * thread view squeezes it. IsoStage measures itself and provides it, so act
 * pieces drop their lowest-priority words (board "Next:" lines) on their own.
 */
export const StageCramped = createContext(false);

/** Whether the stage this is drawn in is cramped (false outside one). */
export function useStageCramped(): boolean {
	return useContext(StageCramped);
}

/**
 * Whether the viewer prefers reduced motion (the system setting or the host's
 * own "animations off"), known from the first render: a scene that starts
 * animated and then turns still would settle wherever its first frames left it.
 */
export { useReducedMotion } from "./reduced-motion.ts";

/**
 * `null` until checked on the client, then whether WebGL is available and
 * whether it runs on a software rasterizer (which gets the light budget).
 */
export function useWebGLProbe(): WebGLProbe | null {
	const [probe, setProbe] = useState<WebGLProbe | null>(null);
	useEffect(() => {
		setProbe(probeWebGL());
	}, []);
	return probe;
}

/**
 * Whether the stage at `ref` sits in a dark theme (the `.dark` class on an
 * ancestor): night in the diorama. Re-read when the class changes.
 */
export function useGameNight(ref: RefObject<HTMLElement | null>): boolean {
	const [night, setNight] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const update = () => setNight(element.closest(".dark") !== null);
		update();
		if (typeof MutationObserver === "undefined") {
			return;
		}
		const observer = new MutationObserver(update);
		const options = { attributeFilter: ["class"], attributes: true };
		observer.observe(element.ownerDocument.documentElement, options);
		if (element.ownerDocument.body) {
			observer.observe(element.ownerDocument.body, options);
		}
		return () => observer.disconnect();
	}, [ref]);
	return night;
}

/**
 * Whether the stage is on screen, the tab visible and the interface not under
 * a host page (else no frames). A page the host opens over the interface
 * (Settings, the Marketplace) neither scrolls the stage out of view nor hides
 * the tab, so the cover is read from the interface root's `inert` ancestor.
 */
function useStageVisible(ref: RefObject<HTMLElement | null>): boolean {
	const [inView, setInView] = useState(true);
	const [pageVisible, setPageVisible] = useState(true);
	const [covered, setCovered] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof MutationObserver === "undefined") {
			return;
		}
		// The renderer's own panels make parts of its tree inert; only an inert
		// ancestor of the whole interface is the host's cover.
		const shell = element.closest("[data-game-shell]") ?? element;
		const update = () => setCovered(isInterfaceCovered(shell));
		update();
		const observer = new MutationObserver(update);
		observer.observe(document.body, {
			attributeFilter: ["inert"],
			attributes: true,
			subtree: true,
		});
		return () => observer.disconnect();
	}, [ref]);
	useEffect(() => {
		const update = () => setPageVisible(document.visibilityState !== "hidden");
		update();
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof IntersectionObserver === "undefined") {
			return;
		}
		const observer = new IntersectionObserver(([entry]) => {
			if (entry) {
				setInView(entry.isIntersecting);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return inView && pageVisible && !covered;
}

/** The scene theme for day or night. */
export function sceneTheme(night: boolean): Scene3dTheme {
	return night ? GAME3D_NIGHT : GAME3D_DAY;
}

/** The camera's angle: yaw around the vertical, pitch down from level. */
export interface IsoAngle {
	pitch: number;
	yaw: number;
}

export const ISO_ANGLE: IsoAngle = { pitch: PITCH, yaw: YAW };

/** Toward the camera, screen right and screen up, for an angle. */
interface IsoBasis {
	right: Vec3;
	toward: Vec3;
	up: Vec3;
}

function isoBasis({ pitch, yaw }: IsoAngle): IsoBasis {
	const toward: Vec3 = [
		Math.cos(pitch) * Math.sin(yaw),
		Math.sin(pitch),
		Math.cos(pitch) * Math.cos(yaw),
	];
	const right: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
	const up: Vec3 = [
		toward[1] * right[2] - toward[2] * right[1],
		toward[2] * right[0] - toward[0] * right[2],
		toward[0] * right[1] - toward[1] * right[0],
	];
	return { right, toward, up };
}

/** How a stage frames itself when it is taller than wide (a phone). */
export interface IsoPortrait {
	/** A tighter box to fit there (the content, not the whole island). */
	bounds?: IsoBounds;
	/** Fill there (default 1.06: only the island's rim bleeds). */
	fill?: number;
	/**
	 * Zoom on to the plates once they are placed (default true unless
	 * `bounds` is given): the agents and controls fill the phone and only
	 * the island's empty rim is cropped (drag pans to it).
	 */
	fitPlates?: boolean;
	/** Camera pitch there (default `PORTRAIT_PITCH`). */
	pitch?: number;
	/** Camera yaw there (default 45 degrees; larger turns +x up-screen). */
	yaw?: number;
}

/**
 * Zoom on to the plates on every stage shape, not only portrait ones: the
 * world units kept around them (`above`, `below` for the bodies under
 * name plates, `side`) and the furthest it zooms (`max`, default 1.8).
 */
export interface IsoPlateFit {
	above?: number;
	below?: number;
	max?: number;
	side?: number;
}

/** Whether the room between the insets is taller than wide. */
export function isPortraitStage(
	width: number,
	height: number,
	insets: IsoInsets = NO_INSETS
): boolean {
	return (
		width - insets.left - insets.right < height - insets.top - insets.bottom
	);
}

/** The bounds, angle and fill a stage of this shape frames with. */
export function isoFraming(
	bounds: IsoBounds,
	fill: number,
	portrait: IsoPortrait | undefined,
	isPortrait: boolean
): { angle: IsoAngle; bounds: IsoBounds; fill: number } {
	if (!isPortrait) {
		return { angle: ISO_ANGLE, bounds, fill };
	}
	return {
		angle: {
			pitch: portrait?.pitch ?? PORTRAIT_PITCH,
			yaw: portrait?.yaw ?? YAW,
		},
		bounds: portrait?.bounds ?? bounds,
		fill: portrait?.fill ?? Math.min(fill, PORTRAIT_FILL),
	};
}

/** The fitted framing: zoom and the content box on the screen plane. */
export interface IsoFit {
	/** Content extent across and up the screen plane, in world units. */
	across: number;
	/** The content's middle on the screen plane (right, up). */
	middle: [number, number];
	tall: number;
	zoom: number;
}

/**
 * Fits `bounds` (with its height) into the stage minus `insets`: the
 * orthographic zoom in pixels per world unit, and where the content sits.
 */
export function fitIso(
	bounds: IsoBounds,
	width: number,
	height: number,
	insets: IsoInsets,
	fill = 1,
	angle: IsoAngle = ISO_ANGLE
): IsoFit {
	const { right: axisRight, up: axisUp } = isoBasis(angle);
	let minRight = Number.POSITIVE_INFINITY;
	let maxRight = Number.NEGATIVE_INFINITY;
	let minUp = Number.POSITIVE_INFINITY;
	let maxUp = Number.NEGATIVE_INFINITY;
	for (const x of [bounds.minX, bounds.maxX]) {
		for (const z of [bounds.minZ, bounds.maxZ]) {
			for (const y of [0, bounds.top ?? 2]) {
				const right = x * axisRight[0] + z * axisRight[2];
				const up = x * axisUp[0] + y * axisUp[1] + z * axisUp[2];
				minRight = Math.min(minRight, right);
				maxRight = Math.max(maxRight, right);
				minUp = Math.min(minUp, up);
				maxUp = Math.max(maxUp, up);
			}
		}
	}
	const across = Math.max(0.1, maxRight - minRight);
	const tall = Math.max(0.1, maxUp - minUp);
	const availableWidth = Math.max(80, width - insets.left - insets.right);
	const availableHeight = Math.max(80, height - insets.top - insets.bottom);
	return {
		across,
		middle: [(minRight + maxRight) / 2, (minUp + maxUp) / 2],
		tall,
		zoom: Math.min(availableWidth / across, availableHeight / tall) * fill,
	};
}

/**
 * The isometric camera: fitted to `bounds` between the HUD insets, panned
 * by dragging and zoomed by the wheel or the view's commands, both kept
 * within the diorama.
 */
/** A drag longer than this (px) is a pan, and swallows the click after it. */
const CLICK_SLOP = 5;
/** How far a focus zooms in at least (default), and its glide time (s). */
const FOCUS_ZOOM = 1.45;
const FOCUS_SECONDS = 0.5;

export function IsoCamera({
	bounds: wideBounds,
	fill: wideFill,
	focusZoom,
	insets,
	plates,
	portrait,
	reducedMotion,
	view,
}: {
	bounds: IsoBounds;
	fill: number;
	focusZoom: number;
	insets: IsoInsets;
	plates?: IsoPlateFit;
	portrait?: IsoPortrait;
	reducedMotion: boolean;
	view?: IsoView;
}) {
	const camera = useThree((state) => state.camera) as OrthographicCamera;
	const size = useThree((state) => state.size);
	const advance = useThree((state) => state.advance);
	const frameloop = useThree((state) => state.frameloop);
	const getState = useThree((state) => state.get);
	const invalidate = useThree((state) => state.invalidate);
	const element = useThree((state) => state.gl.domElement);
	const state = useRef({ factor: 1, panRight: 0, panUp: 0 });
	const target = useRef<Vector3 | null>(null);
	const tallStage = isPortraitStage(size.width, size.height, insets);
	const { angle, bounds, fill } = useMemo(
		() => isoFraming(wideBounds, wideFill, portrait, tallStage),
		[portrait, tallStage, wideBounds, wideFill]
	);
	const basis = useMemo(() => isoBasis(angle), [angle]);
	const base = useMemo(
		() => fitIso(bounds, size.width, size.height, insets, fill, angle),
		[angle, bounds, fill, insets, size.height, size.width]
	);
	// Portrait stages zoom on to what is there (the plates), once fitted.
	const [content, setContent] = useState<ContentFit>(NO_CONTENT);
	const fit = useMemo<IsoFit>(
		() =>
			content === NO_CONTENT
				? base
				: {
						...base,
						middle: [
							base.middle[0] + content.right,
							base.middle[1] + content.up,
						],
						zoom: base.zoom * content.scale,
					},
		[base, content]
	);
	const fitPlates =
		plates !== undefined ||
		(tallStage && !portrait?.bounds && portrait?.fitPlates !== false);
	const padAbove = plates?.above ?? CONTENT_PAD.above;
	const padBelow = plates?.below ?? CONTENT_PAD.below;
	const padSide = plates?.side ?? CONTENT_PAD.side;
	const padMax = plates?.max ?? CONTENT_PAD.max;
	const baseKey = [
		base.zoom,
		...base.middle,
		insets.left,
		insets.right,
		insets.top,
		insets.bottom,
	]
		.map((value) => value.toFixed(3))
		.join(" ");
	// Frames drawn, so plates are measured only once they have followed
	// the camera (drei places them during a frame).
	const frames = useRef(0);
	// A fit measure is scheduled or running: a settle must not mark done.
	const awaiting = useRef(true);
	const insetsNow = useRef(insets);
	insetsNow.current = insets;
	// A manual draw (R3F's `advance` ignores `frameloop`, so a stage that is
	// covered, off screen or hidden would still render). In seconds, as the
	// clock counts, since `advance` sets it outright under "never".
	const drawNow = useCallback(() => {
		if (getState().frameloop !== "never") {
			advance(performance.now() / 1000);
		}
	}, [advance, getState]);
	useFrame(() => {
		frames.current += 1;
	});
	useEffect(() => {
		setContent(NO_CONTENT);
		const stage = element.parentElement?.closest("[data-testid='iso-stage']");
		// Every stage, fitted or not, is pending until a frame is drawn with
		// its final camera and its plates have parted (see settleAfterFit).
		awaiting.current = true;
		markFit(stage, "pending");
		// Covered, off screen or in a hidden tab (frameloop "never"): no frames
		// run, so nothing can be measured. Stay pending; this effect runs again
		// when the stage is drawn.
		if (frameloop === "never") {
			return;
		}
		let tries = 0;
		let timer = 0;
		const start = frames.current;
		// Reduced motion fits once and holds it, so it must fit the scene that
		// stays: wait until plates stop mounting (a bubble or board line lands
		// a frame or two late), and until frames have placed them (drei moves
		// a plate only during a frame, and a demand canvas draws none unasked),
		// then measure.
		let changedAt = performance.now();
		let changedFrame = frames.current;
		let fitted = false;
		// Plates mounting, or a web font swapping in (it resizes every plate
		// with no DOM change), even after the fit: fit again once it settles.
		const changed = () => {
			changedAt = performance.now();
			changedFrame = frames.current;
			invalidate();
			if (fitted) {
				fitted = false;
				awaiting.current = true;
				markFit(stage, "pending");
				tries = 0;
				window.clearTimeout(timer);
				timer = window.setTimeout(measure, CONTENT_WAIT_MS);
			}
		};
		const quiet = new MutationObserver(changed);
		if (reducedMotion && stage) {
			quiet.observe(stage, { childList: true, subtree: true });
			document.fonts?.addEventListener("loadingdone", changed);
		}
		const fontsLoading = () =>
			document.fonts !== undefined && document.fonts.status !== "loaded";
		const settling = () =>
			reducedMotion &&
			(performance.now() - changedAt < CONTENT_QUIET_MS ||
				frames.current - changedFrame < CONTENT_FRAMES ||
				fontsLoading());
		const measure = () => {
			if (
				(frames.current - start < CONTENT_FRAMES || settling()) &&
				tries < CONTENT_TRIES
			) {
				tries += 1;
				invalidate();
				timer = window.setTimeout(measure, CONTENT_WAIT_MS);
				return;
			}
			const current = state.current;
			const userMoved =
				current.factor !== 1 || current.panRight !== 0 || current.panUp !== 0;
			// No fit to make (a stage that does not fit its plates, or one the
			// reader zoomed or panned): only part the plates and finish.
			const settleHere = () => {
				fitted = true;
				awaiting.current = false;
				settleAfterFit.current();
			};
			if (!fitPlates || userMoved) {
				settleHere();
				return;
			}
			if (reducedMotion) {
				// Draw now, twice (a plate's wrapper follows its anchor a frame
				// late), so every plate sits where this camera puts it: the fit
				// then depends on the scene, not on when frames last ran.
				drawNow();
				drawNow();
			}
			// Reduced motion: the fit as the base camera would see the plates
			// (each centre unprojected through this camera, projected through
			// the base one; plates keep their px size), so it never depends on
			// the fit the camera carries now or how many refits came before.
			const fitAtBase = (from: Element) => {
				const box = element.getBoundingClientRect();
				const toBase = (points: [number, number][]) => {
					const worlds = points.map(([x, y]) =>
						camera.position
							.clone()
							.set((x / box.width) * 2 - 1, 1 - (y / box.height) * 2, 0)
							.unproject(camera)
					);
					applyNow.current(baseNow.current);
					camera.updateMatrixWorld();
					const out = worlds.map((world): [number, number] => {
						const at = world.project(camera);
						return [
							((at.x + 1) / 2) * box.width,
							((1 - at.y) / 2) * box.height,
						];
					});
					applyNow.current();
					camera.updateMatrixWorld();
					return out;
				};
				return plateFit(
					from,
					box,
					insetsNow.current,
					baseNow.current.zoom,
					{
						above: padAbove,
						below: padBelow,
						max: padMax,
						side: padSide,
					},
					NO_CONTENT,
					toBase
				);
			};
			const fitNow = (from: Element, applied: ContentFit) =>
				plateFit(
					from,
					element.getBoundingClientRect(),
					insetsNow.current,
					camera.zoom,
					{
						above: padAbove,
						below: padBelow,
						max: padMax,
						side: padSide,
					},
					applied
				);
			let next: ContentFit | null = null;
			if (stage) {
				// Reduced motion: measure the plates with no nudges at all (put
				// back in the same task, so nothing paints), so the fit never
				// depends on what separation did before it.
				next = reducedMotion
					? withoutNudges(stage, () => fitAtBase(stage))
					: fitNow(stage, appliedContent.current);
			}
			if (next) {
				const was = appliedContent.current;
				const same =
					Math.abs(next.right - was.right) < 1e-3 &&
					Math.abs(next.up - was.up) < 1e-3 &&
					Math.abs(next.scale - was.scale) < 1e-4;
				if (same) {
					settleHere();
				} else {
					// The camera moves on commit; part the plates after it.
					fitted = true;
					awaiting.current = false;
					fitLanded.current = true;
					setContent(next);
				}
			} else if (tries < CONTENT_TRIES) {
				tries += 1;
				timer = window.setTimeout(measure, CONTENT_WAIT_MS);
			} else {
				// Still nothing to frame: keep the base camera and finish.
				settleHere();
			}
		};
		timer = window.setTimeout(measure, CONTENT_WAIT_MS);
		return () => {
			window.clearTimeout(timer);
			window.clearTimeout(settleTimer.current);
			quiet.disconnect();
			document.fonts?.removeEventListener("loadingdone", changed);
		};
	}, [
		baseKey,
		camera,
		element,
		fitPlates,
		invalidate,
		padAbove,
		padBelow,
		padMax,
		padSide,
		reducedMotion,
		frameloop,
		drawNow,
	]);
	const apply = useMemo(
		() =>
			(use: IsoFit = fit) => {
				const view = state.current;
				const zoom = use.zoom * view.factor;
				// Pan no further than the content's edges.
				const limitRight = Math.max(
					0.5,
					(use.across - (size.width - insets.left - insets.right) / zoom) / 2 +
						0.5
				);
				const limitUp = Math.max(
					0.5,
					(use.tall - (size.height - insets.top - insets.bottom) / zoom) / 2 +
						0.5
				);
				view.panRight = Math.max(
					-limitRight,
					Math.min(limitRight, view.panRight)
				);
				view.panUp = Math.max(-limitUp, Math.min(limitUp, view.panUp));
				// The content's middle lands in the middle of the uncovered area.
				const shiftX = (insets.left - insets.right) / 2 / zoom;
				const shiftY = (insets.top - insets.bottom) / 2 / zoom;
				const right = use.middle[0] - shiftX + view.panRight;
				const up = use.middle[1] + shiftY + view.panUp;
				const { right: axisRight, toward, up: axisUp } = basis;
				target.current ??= camera.position.clone();
				const look = target.current.set(
					axisRight[0] * right + axisUp[0] * up,
					axisUp[1] * up,
					axisRight[2] * right + axisUp[2] * up
				);
				camera.position.set(
					look.x + toward[0] * CAMERA_DISTANCE,
					look.y + toward[1] * CAMERA_DISTANCE,
					look.z + toward[2] * CAMERA_DISTANCE
				);
				camera.lookAt(look);
				camera.zoom = zoom;
				camera.updateProjectionMatrix();
				invalidate();
			},
		[basis, camera, fit, insets, invalidate, size.height, size.width]
	);
	// The base fit and the camera mover of the latest render, for the
	// reduced-motion fit's view through the base camera.
	const baseNow = useRef(base);
	baseNow.current = base;
	const applyNow = useRef(apply);
	applyNow.current = apply;
	// What the camera carries now (a reset may not have reached it yet).
	const appliedContent = useRef<ContentFit>(NO_CONTENT);
	// Reduced motion: once a fit moves the camera, draw it and re-part the
	// plates to rest in the same task (no later frame will), then mark the
	// canvas `data-iso-fit="done"` for checks and screenshots to wait on.
	const fitLanded = useRef(false);
	const settleAfterFit = useRef<() => void>(() => undefined);
	const settleTimer = useRef(0);
	const settleTries = useRef(0);
	settleAfterFit.current = () => {
		window.clearTimeout(settleTimer.current);
		if (awaiting.current) {
			// A refit is scheduled; it settles when it lands.
			return;
		}
		const stage = element.parentElement?.closest("[data-testid='iso-stage']");
		// Draw with the final camera, twice (a plate's wrapper follows its
		// anchor a frame late), then part the plates against that frame.
		if (getState().frameloop === "never") {
			// Nothing is drawn while covered or hidden; settle when it is shown.
			return;
		}
		drawNow();
		drawNow();
		let still = true;
		for (let pass = 0; stage && pass < SETTLE_PASSES; pass++) {
			still = !declutterPlates(stage, reducedMotion);
			if (still) {
				break;
			}
		}
		// Animated plates keep moving with the scene; reduced motion marks
		// done only once a pass moves nothing, and tries again until then.
		if (still || !reducedMotion) {
			settleTries.current = 0;
			markFit(stage, "done");
			return;
		}
		settleTries.current += 1;
		if (settleTries.current > SETTLE_RETRIES) {
			markFit(stage, "unsettled");
			return;
		}
		settleTimer.current = window.setTimeout(
			() => settleAfterFit.current(),
			CONTENT_WAIT_MS
		);
	};
	useLayoutEffect(() => {
		appliedContent.current = content;
		apply();
		if (fitLanded.current) {
			fitLanded.current = false;
			settleAfterFit.current();
		}
	}, [apply, content]);
	useEffect(
		() =>
			view?.listen((command) => {
				const current = state.current;
				if (command === "reset") {
					current.factor = 1;
					current.panRight = 0;
					current.panUp = 0;
				} else {
					const next =
						command === "in"
							? current.factor * ZOOM_STEP
							: current.factor / ZOOM_STEP;
					current.factor = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
				}
				apply();
			}),
		[apply, view]
	);
	// Focus: glide pan and zoom so a plate lands mid-stage.
	const glide = useRef(0);
	useEffect(
		() =>
			view?.listenFocus((targetId) => {
				const stage = element.parentElement?.closest(
					"[data-testid='iso-stage']"
				);
				const plate = stage?.querySelector<HTMLElement>(
					`[data-iso-focus="${CSS.escape(targetId)}"]`
				);
				if (!plate) {
					return;
				}
				const box = element.getBoundingClientRect();
				const rect = plate.getBoundingClientRect();
				const current = state.current;
				const zoom = fit.zoom * current.factor;
				// Ortho: screen offsets are world offsets over zoom, so the
				// plate's pan is exact (the insets' shift cancels out).
				const shiftX = (insets.left - insets.right) / 2 / zoom;
				const shiftY = (insets.top - insets.bottom) / 2 / zoom;
				const lookRight = fit.middle[0] - shiftX + current.panRight;
				const lookUp = fit.middle[1] + shiftY + current.panUp;
				const x = rect.left + rect.width / 2 - box.left - box.width / 2;
				const y = rect.top + rect.height / 2 - box.top - box.height / 2;
				const goal = {
					factor: Math.max(current.factor, focusZoom),
					panRight: lookRight + x / zoom - fit.middle[0],
					panUp: lookUp - y / zoom - fit.middle[1],
				};
				const from = { ...current };
				cancelAnimationFrame(glide.current);
				const start = performance.now();
				const step = (now: number) => {
					const t = reducedMotion
						? 1
						: Math.min(1, (now - start) / 1000 / FOCUS_SECONDS);
					const ease = t * t * (3 - 2 * t);
					current.factor = from.factor + (goal.factor - from.factor) * ease;
					current.panRight =
						from.panRight + (goal.panRight - from.panRight) * ease;
					current.panUp = from.panUp + (goal.panUp - from.panUp) * ease;
					apply();
					if (t < 1) {
						glide.current = requestAnimationFrame(step);
					}
				};
				glide.current = requestAnimationFrame(step);
			}),
		[apply, element, fit, insets, reducedMotion, view]
	);
	useEffect(() => () => cancelAnimationFrame(glide.current), []);
	useEffect(() => {
		let drag: { id: number; x: number; y: number } | null = null;
		let start: { x: number; y: number } | null = null;
		let dragged = false;
		const down = (event: PointerEvent) => {
			if (event.button !== 0) {
				return;
			}
			drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
			start = { x: event.clientX, y: event.clientY };
			dragged = false;
			cancelAnimationFrame(glide.current);
		};
		const move = (event: PointerEvent) => {
			if (!drag || drag.id !== event.pointerId) {
				return;
			}
			if (
				start &&
				Math.hypot(event.clientX - start.x, event.clientY - start.y) >
					CLICK_SLOP
			) {
				dragged = true;
			}
			const zoom = fit.zoom * state.current.factor;
			state.current.panRight -= (event.clientX - drag.x) / zoom;
			state.current.panUp += (event.clientY - drag.y) / zoom;
			drag = { id: drag.id, x: event.clientX, y: event.clientY };
			apply();
		};
		const up = () => {
			drag = null;
		};
		// A pan ends in a click on whatever is under the pointer: swallow it
		// before the scene's own click handlers see it.
		const click = (event: MouseEvent) => {
			// A keyboard activation (Enter on a plate) is no pan's click.
			if (event.detail === 0) {
				dragged = false;
				return;
			}
			if (dragged) {
				dragged = false;
				event.stopPropagation();
				event.preventDefault();
			}
		};
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			const current = state.current;
			current.factor = Math.max(
				MIN_ZOOM,
				Math.min(MAX_ZOOM, current.factor * Math.exp(-event.deltaY * 0.0015))
			);
			apply();
		};
		element.addEventListener("pointerdown", down);
		element.addEventListener("pointermove", move);
		element.addEventListener("pointerup", up);
		element.addEventListener("pointerleave", up);
		element.addEventListener("wheel", wheel, { passive: false });
		element.addEventListener("click", click, { capture: true });
		return () => {
			element.removeEventListener("click", click, { capture: true });
			element.removeEventListener("pointerdown", down);
			element.removeEventListener("pointermove", move);
			element.removeEventListener("pointerup", up);
			element.removeEventListener("pointerleave", up);
			element.removeEventListener("wheel", wheel);
		};
	}, [apply, element, fit.zoom]);
	return null;
}

/**
 * Sky light plus one shadow-casting sun (or moon), its shadow camera fitted
 * to the island so the whole diorama gets crisp, soft-edged shadows. The
 * cel ramp turns them into clean bands; the shared shade tint keeps the
 * shaded side cool blue or purple, never black.
 */
export function SceneLights({
	shadowMap,
	span,
	theme,
}: {
	shadowMap: number;
	span: number;
	theme: Scene3dTheme;
}) {
	const sun = useRef<DirectionalLight>(null);
	const reach = span / 2 + ISLAND_MARGIN + 2;
	const direction = sunDirection(theme);
	const position: Vec3 = [
		direction[0] * 30,
		direction[1] * 30,
		direction[2] * 30,
	];
	useEffect(() => {
		const light = sun.current;
		if (!light) {
			return;
		}
		const camera = light.shadow.camera;
		camera.left = -reach;
		camera.right = reach;
		camera.top = reach;
		camera.bottom = -reach;
		camera.near = 1;
		camera.far = 90;
		camera.updateProjectionMatrix();
		light.shadow.needsUpdate = true;
	}, [reach]);
	const mapSize = span > 24 ? shadowMap * 2 : shadowMap;
	return (
		<>
			<hemisphereLight
				args={[theme.hemiSky, theme.hemiGround, theme.hemiIntensity]}
			/>
			<ambientLight intensity={theme.ambient} />
			<directionalLight
				castShadow
				color={theme.sunColor}
				intensity={theme.sunIntensity}
				position={position}
				ref={sun}
				shadow-bias={-0.0004}
				shadow-mapSize={[mapSize, mapSize]}
				shadow-normalBias={0.03}
				shadow-radius={3}
			/>
			{theme.fillLight ? (
				// Soft moonlit fill from the camera side keeps faces readable;
				// near neutral, so the night is indigo without turning every
				// color blue.
				<directionalLight
					color={theme.fillLight}
					intensity={FILL_INTENSITY}
					position={[...FILL_DIRECTION]}
				/>
			) : null}
		</>
	);
}

const STAR_COUNT = 160;

/**
 * Night: stars mirrored on the still sea around the island, so the frame
 * reads as a starry night even looking down.
 */
export function SeaStars({
	glow,
	span,
}: {
	glow: HTMLCanvasElement | null;
	span: number;
}) {
	const positions = useMemo(() => {
		const buffer = new Float32Array(STAR_COUNT * 3);
		const reach = span * 1.6 + 12;
		for (let index = 0; index < STAR_COUNT; index++) {
			const angle = jitter(index, 5, 1) * Math.PI * 2;
			const radius = span / 2 + 3 + jitter(index, 7, 3) * reach;
			buffer.set(
				[Math.cos(angle) * radius, -0.9, Math.sin(angle) * radius],
				index * 3
			);
		}
		return buffer;
	}, [span]);
	if (!glow) {
		return null;
	}
	return (
		<points frustumCulled={false}>
			<bufferGeometry>
				<bufferAttribute args={[positions, 3]} attach="attributes-position" />
			</bufferGeometry>
			<CurvedPointsMaterial
				blending={ADDITIVE_BLENDING}
				color={[1.6, 1.6, 1.9]}
				depthWrite={false}
				opacity={0.8}
				size={4}
				sizeAttenuation={false}
				toneMapped={false}
				transparent
			>
				<canvasTexture args={[glow]} attach="map" />
			</CurvedPointsMaterial>
		</points>
	);
}

/** Calls `onReady` once the first frame is on the canvas. */
function FirstFrame({ onReady }: { onReady: () => void }) {
	const done = useRef(false);
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		invalidate();
	}, [invalidate]);
	useFrame(() => {
		if (done.current) {
			return;
		}
		done.current = true;
		setTimeout(onReady, 0);
	});
	return null;
}

/** A portrait stage's zoom on to its plates, on top of the fitted view. */
interface ContentFit {
	right: number;
	scale: number;
	up: number;
}

const NO_CONTENT: ContentFit = { right: 0, scale: 1, up: 0 };
/** The furthest a portrait stage zooms on to its plates. */
const MAX_CONTENT_ZOOM = 1.8;
/** World units kept around the plates: sides, above, and below (bodies). */
const CONTENT_PAD: Required<IsoPlateFit> = {
	above: 0.5,
	below: 2.4,
	max: MAX_CONTENT_ZOOM,
	side: 0.8,
};
const CONTENT_WAIT_MS = 150;
const CONTENT_TRIES = 60;
const CONTENT_FRAMES = 3;
/** Under reduced motion, plates must not have mounted for this long before the fit. */
const CONTENT_QUIET_MS = 450;

/**
 * How far to zoom and pan so the stage's plates (where the agents and the
 * things to press are) fill the room between the insets: `null` until
 * there are plates to measure.
 */
/**
 * The content fit that frames the plates, measured under the camera now in
 * use, which already carries the content fit `applied` (the result is
 * absolute, so a measure that runs before a reset reaches the camera still
 * lands on the same fit).
 */
export function plateFit(
	stage: Element,
	canvas: DOMRect,
	insets: IsoInsets,
	zoom: number,
	pad: Required<IsoPlateFit>,
	applied: ContentFit = NO_CONTENT,
	/** Maps plate centres (canvas px) into another camera's view first. */
	toView?: (points: [number, number][]) => [number, number][]
): ContentFit | null {
	holdPlateRoots(stage);
	const boxes: FitBox[] = [];
	for (const plate of stagePlates(stage)) {
		const own = plate.getBoundingClientRect();
		if (plate.offsetParent === null || own.width === 0) {
			continue;
		}
		// drei's root sits on the anchor the camera projects; a plate hung to
		// a side or a row up keeps a px offset from it that zoom must not scale.
		const root = plateRoot(plate)?.getBoundingClientRect();
		boxes.push(
			plateFitBox({
				anchor: root ? [root.left, root.top] : null,
				canvas,
				nudge: nudgeOf(plate),
				plate: own,
				reach: plateRect(plate),
			})
		);
	}
	return fitBoxes(
		boxes,
		{ height: canvas.height, insets, width: canvas.width },
		zoom,
		pad,
		applied,
		toView
	);
}

/** How often (ms) plates re-part while the scene moves. */
export const DECLUTTER_MS = 240;

/** The element to nudge for a plate: drei's centring wrapper, or itself. */
function plateHolder(plate: HTMLElement): HTMLElement {
	const parent = plate.parentElement;
	if (parent?.style.transform.startsWith("translate3d(-50%")) {
		return parent;
	}
	return plate;
}

const nudged = new WeakMap<HTMLElement, readonly [number, number]>();

/**
 * Runs `measure` with every plate's nudge removed, then restores them, all
 * in one task (no paint between). Only for instant nudges (reduced motion):
 * an animated nudge would start sliding.
 */
function withoutNudges<T>(stage: Element, measure: () => T): T {
	const saved: [HTMLElement, string, readonly [number, number] | undefined][] =
		[];
	for (const plate of stagePlates(stage)) {
		for (const target of [plate, plate.parentElement]) {
			if (target && (target.style.translate || nudged.has(target))) {
				saved.push([target, target.style.translate, nudged.get(target)]);
				// No slide: a leftover transition would report the old nudge.
				target.style.transition = "none";
				target.style.translate = "";
				nudged.delete(target);
			}
		}
	}
	try {
		return measure();
	} finally {
		for (const [target, translate, nudge] of saved) {
			target.style.translate = translate;
			if (nudge) {
				nudged.set(target, nudge);
			}
		}
	}
}

/** A `translate` value's x and y in px ("none" and "" read as 0). */
function translateOf(value: string | undefined): [number, number] {
	const [x = "0", y = "0"] = !value || value === "none" ? [] : value.split(" ");
	return [Number.parseFloat(x) || 0, Number.parseFloat(y) || 0];
}

/** Whether any plate's nudge is still sliding toward where it was set. */
function nudgeSliding(stage: Element): boolean {
	for (const plate of stagePlates(stage)) {
		const holder = plateHolder(plate);
		const target = nudged.get(holder);
		if (!target) {
			continue;
		}
		const [x, y] = translateOf(getComputedStyle(holder).translate);
		if (Math.abs(x - target[0]) > 0.5 || Math.abs(y - target[1]) > 0.5) {
			return true;
		}
	}
	return false;
}

/** An agent's name plate where it rests (its nudge taken out), in px. */
interface NamedPlate {
	agent: string;
	bottom: number;
	height: number;
	left: number;
	width: number;
}

/**
 * Every villager figure in `stage` as a fixed PlateBox. From the head and
 * feet probes (`data-act-figure`, `data-figure-edge`) where the kit marks
 * them: head to feet tall, a little over a quarter of that wide (at least
 * 24px). An agent with a name plate (`data-act-agent`) but no probes (a
 * game's own creatures or cars) gets the checker's estimate: the plate's
 * width, from its bottom down 2.5 plate heights.
 */
function figureBoxes(
	stage: Element,
	named: readonly NamedPlate[] = []
): PlateBox[] {
	const edges = new Map<string, { feet?: DOMRect; head?: DOMRect }>();
	for (const probe of stage.querySelectorAll<HTMLElement>(
		"[data-act-figure][data-figure-edge]"
	)) {
		// Its own drei root: hold it still too, so it measures where drei put it.
		const root = plateRoot(probe);
		if (root && root.style.transition !== "none") {
			root.style.transition = "none";
		}
		const id = probe.dataset.actFigure ?? "";
		const edge = probe.dataset.figureEdge;
		const entry = edges.get(id) ?? {};
		if (edge === "head" || edge === "feet") {
			entry[edge] = probe.getBoundingClientRect();
		}
		edges.set(id, entry);
	}
	const boxes: PlateBox[] = [];
	for (const plate of named) {
		if (!plate.agent || edges.has(plate.agent)) {
			continue;
		}
		const tall = plate.height * 2.5;
		boxes.push({
			figure: true,
			height: tall,
			width: plate.width,
			x: plate.left + plate.width / 2,
			y: plate.bottom + tall / 2,
		});
	}
	for (const { feet, head } of edges.values()) {
		if (!(feet && head)) {
			continue;
		}
		const tall = Math.max(8, feet.top - head.top);
		boxes.push({
			figure: true,
			height: tall,
			width: Math.max(24, tall * 0.56),
			x: (head.left + feet.left) / 2,
			y: head.top + tall / 2,
		});
	}
	return boxes;
}

/** Whether the element at `ref` is shorter than CRAMPED_STAGE (measured). */
function useCrampedStage(ref: RefObject<HTMLElement | null>): boolean {
	const [cramped, setCramped] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			const height = entry?.contentRect.height ?? 0;
			setCramped(height > 0 && height < CRAMPED_STAGE);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return cramped;
}

/** The stage's HUD insets (px), from `data-iso-insets` ("top right bottom left"). */
function stageInsets(stage: Element): IsoInsets {
	const [top = 0, right = 0, bottom = 0, left = 0] = (
		stage.getAttribute("data-iso-insets") ?? ""
	)
		.split(" ")
		.map(Number)
		.map((value) => (Number.isFinite(value) ? value : 0));
	return { bottom, left, right, top };
}

/** The nudge on a plate now: on the plate itself and/or drei's wrapper. */
function nudgeOf(plate: HTMLElement): [number, number] {
	const own = nudged.get(plate) ?? [0, 0];
	const holder = plateHolder(plate);
	const wrap = holder === plate ? [0, 0] : (nudged.get(holder) ?? [0, 0]);
	return [own[0] + (wrap[0] ?? 0), own[1] + (wrap[1] ?? 0)];
}

/**
 * A plate's box including its speech bubble, which hangs outside the plate
 * (absolutely placed) and moves with it.
 */
function plateRect(plate: HTMLElement): DOMRect {
	const rect = plate.getBoundingClientRect();
	const bubble = plate
		.querySelector("[data-life-bubble]")
		?.getBoundingClientRect();
	if (!bubble || bubble.width === 0 || rect.width === 0) {
		return rect;
	}
	const left = Math.min(rect.left, bubble.left);
	const top = Math.min(rect.top, bubble.top);
	return new DOMRect(
		left,
		top,
		Math.max(rect.right, bubble.right) - left,
		Math.max(rect.bottom, bubble.bottom) - top
	);
}

interface Box {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

const BUBBLE_SIDES = ["right", "left", "up"] as const;

function overlapArea(a: Box, b: Box): number {
	const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
	const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
	return x > 0 && y > 0 ? x * y : 0;
}

/** Where a bubble of `width` x `height` would sit on `side` of a plate box. */
function bubbleBox(
	plate: Box,
	side: (typeof BUBBLE_SIDES)[number],
	width: number,
	height: number
): Box {
	const middle = (plate.left + plate.right) / 2;
	// Matches LifeBubbleTag's offsets (16px off centre; 6px or 24px up).
	const bottom = plate.top - (side === "up" ? 24 : 6);
	let left = middle - width / 2;
	if (side === "right") {
		left = middle + 16;
	} else if (side === "left") {
		left = middle - 16 - width;
	}
	return { bottom, left, right: left + width, top: bottom - height };
}

/**
 * Hangs every `auto` bubble on the first side (right, left, up) whose box
 * meets no other plate and no bubble placed before it, in screen order
 * (the least crowded side when none is clear). Animated stages choose once
 * per bubble's words, so it never flickers; reduced motion picks afresh
 * each pass, so the frame depends on the scene alone.
 */
function chooseBubbleSides(stage: Element, reducedMotion: boolean) {
	const plates = [
		...stage.querySelectorAll<HTMLElement>(
			"[data-iso-target], [data-iso-plate]"
		),
	]
		.filter((plate) => plate.offsetParent !== null)
		.map((plate) => {
			const rect = plate.getBoundingClientRect();
			const [dx, dy] = nudgeOf(plate);
			return {
				box: {
					bottom: rect.bottom - dy,
					left: rect.left - dx,
					right: rect.right - dx,
					top: rect.top - dy,
				},
				bubble: plate.querySelector<HTMLElement>("[data-bubble-auto]"),
				name: plate.getAttribute("aria-label") ?? plate.textContent ?? "",
				plate,
			};
		})
		.filter((entry) => entry.box.right > entry.box.left);
	const placed: Box[] = [];
	const ordered = plates
		.filter((entry) => entry.bubble !== null)
		.sort(
			(a, b) =>
				Math.round(a.box.top) - Math.round(b.box.top) ||
				Math.round(a.box.left) - Math.round(b.box.left) ||
				a.name.localeCompare(b.name)
		);
	for (const entry of ordered) {
		const bubble = entry.bubble as HTMLElement;
		if (reducedMotion && bubble.style.transition !== "none") {
			// The reduced-motion catch-all's 0.01ms transition would leave a
			// bubble at its old side until the next paint, so separation would
			// part the plate as if it still hung there.
			bubble.style.transition = "none";
		}
		const size = bubble.getBoundingClientRect();
		const others = plates
			.filter((other) => other !== entry)
			.map((other) => other.box);
		const crowd = (side: (typeof BUBBLE_SIDES)[number]) => {
			const box = bubbleBox(entry.box, side, size.width, size.height);
			let area = 0;
			for (const other of [...others, ...placed]) {
				area += overlapArea(box, other);
			}
			return { area, box, side };
		};
		const options = BUBBLE_SIDES.map(crowd);
		const current = options.find(
			(option) => option.side === bubble.dataset.side
		);
		const clear = options.find((option) => option.area === 0);
		// Animated: a bubble keeps the side chosen for its words (plates
		// mid-slide would otherwise flip it, and each flip re-parts them).
		const words = bubble.textContent ?? "";
		const settled =
			!reducedMotion &&
			current !== undefined &&
			bubble.dataset.sideFor === words;
		let pick = settled ? current : clear;
		pick ??= options.reduce((best, option) =>
			option.area < best.area ? option : best
		);
		if (bubble.dataset.side !== pick.side) {
			bubble.dataset.side = pick.side;
		}
		bubble.dataset.sideFor = words;
		placed.push(pick.box);
	}
}

/**
 * Measures every plate in `stage` and nudges crowded ones apart; true when
 * any plate moved (so a static frame should measure again).
 */
export function declutterPlates(
	stage: Element,
	reducedMotion: boolean
): boolean {
	// Nothing moved and no words changed since the last pass: the result
	// would be the same, so skip the layout reads (the frame loop runs this
	// every DECLUTTER_MS while a scene animates).
	holdPlateRoots(stage);
	const signature = plateSignature(stage);
	if (lastSignature.get(stage) === signature) {
		return false;
	}
	if (!reducedMotion && nudgeSliding(stage)) {
		// A nudge is still sliding: measuring now would take its in-between
		// spot for its rest and push it again, so plates would drift for good.
		// Report movement so the caller parts again once it lands.
		return true;
	}
	lastSignature.set(stage, signature);
	chooseBubbleSides(stage, reducedMotion);
	let moved = false;
	const holders: HTMLElement[] = [];
	const boxes: PlateBox[] = [];
	const names: string[] = [];
	const named: NamedPlate[] = [];
	for (const plate of stagePlates(stage)) {
		if (plate.offsetParent === null) {
			continue;
		}
		const holder = plateHolder(plate);
		if (reducedMotion && holder.style.transition !== "none") {
			// A nudge from before reduced motion was known still slides; stop it
			// so this pass measures where the plate really is.
			// "none", not "": a plate's own classes may also animate translate.
			holder.style.transition = "none";
		}
		const [dx, dy] = nudgeOf(plate);
		const rect = plateRect(plate);
		if (rect.width === 0) {
			continue;
		}
		// A plate nudged before drei placed its wrapper holds that nudge
		// itself; it moves to the wrapper now, so the two never add up.
		const stale = holder === plate ? null : plate;
		if (stale && nudged.has(stale)) {
			stale.style.translate = "";
			nudged.delete(stale);
			nudged.set(holder, [0, 0]);
		}
		holders.push(holder);
		names.push(plate.getAttribute("aria-label") ?? plate.textContent ?? "");
		const namePlate =
			plate.hasAttribute("data-act-agent") &&
			!plate.hasAttribute("data-act-target");
		if (namePlate) {
			named.push({
				agent: plate.dataset.actAgent ?? "",
				bottom: rect.bottom - dy,
				height: rect.height,
				left: rect.left - dx,
				width: rect.width,
			});
		}
		boxes.push({
			clearsFigures: plate.dataset.actTarget === "alarm",
			namePlate,
			youSpot: plate.hasAttribute("data-you-spot"),
			height: rect.height,
			width: rect.width,
			x: rect.left + rect.width / 2 - dx,
			y: rect.top + rect.height / 2 - dy,
		});
	}
	// Villagers' figures, where the kit marks them: alarm plates keep off
	// them (their own agent's and a neighbour's), and nothing moves them.
	for (const figure of figureBoxes(stage, named)) {
		boxes.push(figure);
		names.push("");
	}
	// Plates join the DOM in mount order, which varies with timing; part them
	// in screen order instead, so the same scene always parts the same way.
	const order = boxes
		.map((_, index) => index)
		.sort((a, b) => {
			const p = boxes[a] as PlateBox;
			const q = boxes[b] as PlateBox;
			return (
				Math.round(p.y) - Math.round(q.y) ||
				Math.round(p.x) - Math.round(q.x) ||
				p.width - q.width ||
				p.height - q.height ||
				(names[a] ?? "").localeCompare(names[b] ?? "")
			);
		});
	// A plate hung left or right of its anchor (or a long one at the edge)
	// can reach past the stage, or under its HUD, where it is cut off or
	// hidden: part the plates inside the stage minus its insets.
	const area = stage.getBoundingClientRect();
	const insets = stageInsets(stage);
	const room =
		area.width > 0 && area.height > 0
			? {
					bottom: area.bottom - insets.bottom,
					left: area.left + insets.left,
					right: area.right - insets.right,
					top: area.top + insets.top,
				}
			: null;
	const parted = partOnStage(
		order.map((index) => boxes[index] as PlateBox),
		room
	);
	const nudges: [number, number][] = boxes.map(() => [0, 0]);
	for (const [rank, index] of order.entries()) {
		nudges[index] = parted[rank] ?? [0, 0];
	}
	for (const [index, holder] of holders.entries()) {
		const next = nudges[index] ?? [0, 0];
		const was = nudged.get(holder) ?? [0, 0];
		if (next[0] === was[0] && next[1] === was[1]) {
			continue;
		}
		holder.style.transition = reducedMotion
			? "none"
			: "translate 160ms ease-out";
		holder.style.translate = `${next[0]}px ${next[1]}px`;
		nudged.set(holder, next);
		moved = true;
	}
	if (moved) {
		// Measure again next pass even if nothing else changes: an animated
		// nudge is still sliding now, and this pass may have measured another
		// mid-slide; the scene is settled only once a pass moves nothing.
		lastSignature.delete(stage);
	}
	return moved;
}

const lastSignature = new WeakMap<Element, string>();

/**
 * Where every plate is and what it says, without a layout read: drei's
 * placement transform on each plate's Html root plus its words. Nudges are
 * set with `translate`, not `transform`, so they do not change it.
 */
function plateSignature(stage: Element): string {
	const parts: string[] = [];
	for (const plate of stagePlates(stage)) {
		const root = plateRoot(plate);
		parts.push(`${root?.style.transform ?? ""}|${plate.textContent ?? ""}`);
	}
	return parts.join("\n");
}

/**
 * drei's Html root for a plate: the element whose `translate3d(x, y, 0)`
 * puts the plate's anchor where the camera projects it. `null` for a plate
 * outside drei.
 */
function plateRoot(plate: HTMLElement): HTMLElement | null {
	let root: HTMLElement | null = plate;
	for (let depth = 0; root && depth < 4; depth++) {
		if (
			root.style.transform.startsWith("translate3d(") &&
			!root.style.transform.startsWith("translate3d(-50%")
		) {
			return root;
		}
		root = root.parentElement;
	}
	return null;
}

/**
 * Stops drei's Html roots from transitioning. The reduced-motion catch-all
 * gives every element a 0.01ms transition, which ends only on the browser's
 * next rendered frame: until then a root measures where the previous camera
 * put it, so a demand canvas would report (and part) plates at a stale spot
 * and see them jump a frame later. Without a transition the root is where
 * drei put it as soon as drei writes it.
 */
export function holdPlateRoots(stage: Element) {
	for (const plate of stagePlates(stage)) {
		const root = plateRoot(plate);
		if (root && root.style.transition !== "none") {
			root.style.transition = "none";
		}
	}
}

/**
 * What plate separation parts: kit plates, and any game-owned you-spot
 * overlay (a queue plate that is not a kit plate still keeps YOU_SPOT_GAP).
 */
const PLATE_OR_YOU_SPOT =
	"[data-iso-target], [data-iso-plate], [data-you-spot]";

/**
 * The plates separation, the content fit and the no-nudge measure all work
 * on (one list, so they never disagree): every kit plate and you-spot,
 * except a queue overlay inside a plate, which moves with that plate.
 */
export function stagePlates(stage: Element): HTMLElement[] {
	return [...stage.querySelectorAll<HTMLElement>(PLATE_OR_YOU_SPOT)].filter(
		(plate) => !plate.parentElement?.closest(PLATE_OR_YOU_SPOT)
	);
}

/** Separation passes after a change, until nothing moves (a static frame). */
const SETTLE_PASSES = 6;
/**
 * Reduced motion: settles retried (CONTENT_WAIT_MS apart) while plates still
 * move, before the stage reads `data-iso-fit="unsettled"`.
 */
const SETTLE_RETRIES = 40;

/**
 * The stage's fit status, for checks and screenshots to wait on: `pending`
 * (rendered from the start), `done` once a frame with the final camera is
 * drawn and its plates have parted (reduced motion: a pass moved nothing),
 * `unsettled` if they never stop, `none` with no WebGL.
 */
function markFit(
	stage: Element | null | undefined,
	status: "done" | "pending" | "unsettled"
) {
	if (stage instanceof HTMLElement && stage.dataset.isoFit !== status) {
		stage.dataset.isoFit = status;
	}
}

/**
 * Keeps the scene's plates apart: re-parts them when the camera moves and,
 * while the scene animates, a few times a second (never every frame). A
 * demand-driven canvas (reduced motion) can stop drawing while plates still
 * change (a bubble or board line mounts), so DOM changes in the stage also
 * re-part them, repeating until they settle (instant nudges there, so each
 * pass measures where the plates really are).
 */
export function PlateDeclutter({ reducedMotion }: { reducedMotion: boolean }) {
	const element = useThree((state) => state.gl.domElement);
	const seen = useRef({
		again: false,
		at: 0,
		follows: 0,
		frame: 0,
		trailing: 0,
		x: 0,
		y: 0,
		z: 0,
		zoom: 0,
	});
	useFrame(({ camera, frameloop }) => {
		const last = seen.current;
		const now = performance.now();
		const snapshot = () => {
			last.at = performance.now();
			last.zoom = camera.zoom;
			last.x = camera.position.x;
			last.y = camera.position.y;
			last.z = camera.position.z;
		};
		// One separation pass. On a demand canvas an animated nudge slides
		// with no frame after it, and the pass may have measured a plate
		// mid-slide: part again once the slide has landed, until a pass moves
		// nothing (an always-drawing canvas does this on its own frames).
		const part = () => {
			const stage = element.parentElement?.closest("[data-testid='iso-stage']");
			if (!stage) {
				return;
			}
			const shifted = declutterPlates(stage, reducedMotion);
			if (!shifted) {
				last.follows = 0;
				return;
			}
			if (
				reducedMotion ||
				frameloop === "always" ||
				last.follows >= SETTLE_PASSES
			) {
				return;
			}
			last.follows += 1;
			window.clearTimeout(last.trailing);
			last.trailing = window.setTimeout(() => {
				last.trailing = 0;
				snapshot();
				part();
			}, DECLUTTER_MS);
		};
		const moved =
			camera.zoom !== last.zoom ||
			camera.position.x !== last.x ||
			camera.position.y !== last.y ||
			camera.position.z !== last.z;
		if (!moved && now - last.at < DECLUTTER_MS) {
			// Throttled: on a demand canvas, part these positions once the
			// window closes, as it may draw no further frame (the last steps of
			// a walk would otherwise stay unparted). An always-drawing canvas
			// parts them on its next frame past the window: a timer there
			// would add a second pass a frame later, mid-slide.
			if (last.trailing === 0 && frameloop !== "always") {
				last.trailing = window.setTimeout(
					() => {
						last.trailing = 0;
						// This pass opens the next window.
						snapshot();
						part();
					},
					DECLUTTER_MS - (now - last.at)
				);
			}
			return;
		}
		window.clearTimeout(last.trailing);
		last.trailing = 0;
		last.follows = 0;
		snapshot();
		if (last.frame !== 0) {
			// A pass is pending but measures before this frame's moves land; a
			// reduced-motion canvas may draw no frame after it, so run once
			// more. (Animated nudges are still sliding then; the frame loop
			// re-parts them within DECLUTTER_MS anyway.)
			if (reducedMotion) {
				last.again = true;
			}
			return;
		}
		// After this frame, once the plates have moved with the camera.
		const run = () => {
			last.frame = 0;
			part();
			if (last.again) {
				last.again = false;
				last.frame = requestAnimationFrame(run);
			}
		};
		last.frame = requestAnimationFrame(run);
	});
	useEffect(() => {
		const last = seen.current;
		return () => {
			cancelAnimationFrame(last.frame);
			window.clearTimeout(last.trailing);
		};
	}, []);
	useEffect(() => {
		const stage = element.parentElement?.closest("[data-testid='iso-stage']");
		// Animated stages keep drawing and re-part on the frame loop; measuring
		// there mid-slide (the 160ms nudge transition) would make plates jitter.
		if (!(stage && reducedMotion) || typeof MutationObserver === "undefined") {
			return;
		}
		let frame = 0;
		let passes = 0;
		const pass = () => {
			frame = 0;
			const moved = declutterPlates(stage, reducedMotion);
			passes += 1;
			if (moved && passes < SETTLE_PASSES) {
				frame = requestAnimationFrame(pass);
			}
		};
		const schedule = () => {
			passes = 0;
			if (frame === 0) {
				frame = requestAnimationFrame(pass);
			}
		};
		// Content only: the nudges themselves are style writes, not observed.
		const observer = new MutationObserver(schedule);
		// A web font swapping in resizes plates with no DOM change.
		document.fonts?.addEventListener("loadingdone", schedule);
		observer.observe(stage, {
			characterData: true,
			childList: true,
			subtree: true,
		});
		schedule();
		return () => {
			observer.disconnect();
			document.fonts?.removeEventListener("loadingdone", schedule);
			cancelAnimationFrame(frame);
		};
	}, [element, reducedMotion]);
	return null;
}

/** Keeps a demand-driven canvas drawing while it animates. */
function KeepDrawing({ active }: { active: boolean }) {
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		if (active) {
			invalidate();
		}
	}, [active, invalidate]);
	return null;
}

/** Moves focus from the focused scene plate in reading order. */
function focusToward(root: HTMLElement, key: FocusKey): boolean {
	const targets = [
		...root.querySelectorAll<HTMLElement>("[data-iso-target]"),
	].filter((target) => target.tabIndex >= 0 && target.offsetParent !== null);
	if (targets.length === 0) {
		return false;
	}
	const plates: FocusPlate[] = targets.map((target) => {
		const box = target.getBoundingClientRect();
		const order = Number.parseFloat(target.dataset.isoOrder ?? "");
		return {
			order: Number.isFinite(order) ? order : undefined,
			x: box.left + box.width / 2,
			y: box.top + box.height / 2,
		};
	});
	const active = root.ownerDocument.activeElement;
	const current = active instanceof HTMLElement ? targets.indexOf(active) : -1;
	// Rows are plates within about half a plate's height of each other, so
	// a grid of small plates (quiz cells) keeps its rows apart.
	const heights = targets
		.map((target) => target.getBoundingClientRect().height)
		.sort((a, b) => a - b);
	const median = heights[Math.floor(heights.length / 2)] ?? ROW_TOLERANCE;
	const tolerance = Math.min(ROW_TOLERANCE, Math.max(6, median * 0.6));
	targets[nextFocus(plates, current, key, tolerance)]?.focus();
	return true;
}

/**
 * An interactive object's control in the scene: a kit plate billboarded at
 * `at` (a world point), focusable and clickable, reachable by Tab and the
 * arrow keys. Its children are the visible words; `label` is its name.
 */
export function IsoMarker({
	actAgent,
	activate,
	at,
	children,
	className,
	focusable = true,
	focusId,
	icon,
	iconOnly = false,
	label,
	onSelect,
	order,
	pressed,
	youSpot,
}: {
	/** The agent this marker is the per-agent target of (`data-act-agent`). */
	actAgent?: string;
	/**
	 * Called instead of `onSelect` (an asking agent's marker opens its ask
	 * card): the selection is left alone and `aria-pressed` is omitted.
	 */
	activate?: () => void;
	at: Vec3;
	children: ReactNode;
	className?: string;
	/**
	 * False keeps the marker clickable but out of the Tab order (a second
	 * marker for an agent whose per-agent Tab stop is elsewhere, S17).
	 */
	focusable?: boolean;
	/** What `IsoView.focusOnTarget` calls this marker's object. */
	focusId?: string;
	/** What an `iconOnly` marker shows (default: the label's initial). */
	icon?: ReactNode;
	/** Narrow stages: a 28px glyph target; `label` stays its full name. */
	iconOnly?: boolean;
	label: string;
	onSelect?: () => void;
	/** The game's order for arrow keys (door number, stop, cell). */
	order?: number;
	pressed?: boolean;
	/** This marker is a you-spot queue plate (`data-you-spot="slot"`). */
	youSpot?: "slot";
}) {
	return (
		<group position={at}>
			<Html center zIndexRange={[30, 0]}>
				<button
					aria-label={label}
					aria-pressed={activate ? undefined : pressed}
					className={cn(
						GAME_PLATE,
						GAME_FOCUS,
						"gk-display flex h-7 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full text-[13px] leading-none",
						iconOnly ? "min-w-7 [&_svg]:size-4" : "px-2.5",
						pressed && !activate && "bg-(--gk-accent) text-(--gk-accent-ink)",
						className
					)}
					data-act-agent={actAgent}
					data-icon-only={iconOnly ? "" : undefined}
					data-iso-focus={focusId}
					data-iso-order={order}
					data-iso-target=""
					data-you-spot={youSpot}
					onClick={activate ?? onSelect}
					tabIndex={focusable && (activate ?? onSelect) ? 0 : -1}
					type="button"
				>
					{iconOnly ? (icon ?? Array.from(label)[0] ?? "") : children}
				</button>
			</Html>
		</group>
	);
}

/** A name board in the scene (not a control): a kit plate at `at`. */
export function IsoLabel({ at, children }: { at: Vec3; children: ReactNode }) {
	return (
		<group position={at}>
			<Html center zIndexRange={[20, 0]}>
				<div
					className={cn(
						GAME_PLATE,
						"gk-display pointer-events-none flex h-7 select-none items-center whitespace-nowrap rounded-lg px-3 text-[13px] leading-none"
					)}
					data-iso-plate=""
				>
					{children}
				</div>
			</Html>
		</group>
	);
}

const ARROWS = new Set<string>([
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
]);

function isFocusKey(key: string): key is FocusKey {
	return ARROWS.has(key);
}

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
					<span className="sr-only">Loading {label}</span>
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
