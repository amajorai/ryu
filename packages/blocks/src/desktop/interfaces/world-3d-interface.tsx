/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgentAct,
	type InterfacePort,
	layoutWorld,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
	type World3dParams,
	type WorldEntity,
	type WorldLayout,
} from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Group, Vector3 } from "three";
import { keepsActOverlay } from "./act-settings.ts";
import { BoardStatusDot } from "./board-status.tsx";
import { GAME_PLATE } from "./game-hud.tsx";
import { GAME_KIT_CSS } from "./game-palette.ts";
import {
	actBubble,
	actOverlays,
	actSummaryLine,
	actTotals,
	bubbleOverlayId,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "./game3d-acts.ts";
import { CurvedAnchor } from "./game3d-anchor.tsx";
import type { LifeBubble } from "./game3d-life.ts";
import { type LifeBody, LifeBubbleTag } from "./game3d-life.tsx";
import { queuePlateText } from "./game3d-meters.tsx";
import {
	type AgentSwatch,
	agentSwatches,
	type Scene3dTheme,
	sunDirection,
	swatchOf,
	type Vec3,
	villagerLooks,
} from "./game3d-palette.ts";
import { Bloom } from "./game3d-post.tsx";
import { useGameKitSettings } from "./game3d-settings.tsx";
import {
	Clouds,
	Glimmers,
	SkyDome,
	skyColors,
	useGlowCanvas,
} from "./game3d-sky.tsx";
import {
	SceneLights,
	useReducedMotion,
	useWebGLProbe,
} from "./game3d-stage.tsx";
import {
	curveDrop,
	QUALITY,
	type RenderQuality,
	setLook,
} from "./game3d-toon.ts";
import {
	ActAgentList,
	ActAnnouncer,
	AskQueueList,
	askOwners,
	BlindSpotCaption,
	NeedYouButton,
	openQueue,
	QueueButton,
	useActCards,
} from "./interface-ask-card.tsx";
import { isAskKey, useInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useActAnnouncement, useActClockOptions, useActs } from "./use-acts.ts";
import { useTalkingAgent, useWorldController } from "./use-world-controller.ts";
import {
	WorldActStage,
	type WorldActView,
	WorldHelpers,
	worldActorAt,
	worldCarry,
	worldYouSpot,
} from "./world-3d-acts.tsx";
import {
	BAND_HEIGHT,
	CHOICES_WIDTH,
	World3dDialog,
} from "./world-3d-dialog.tsx";
import {
	chooseFocusSide,
	conversationSpot,
	focusEye,
	type HouseBox,
	houseBoxes,
	occludingHouses,
	pairCenter,
	type TreeObstacle,
	treesInShot,
} from "./world-3d-focus.ts";
import { Flowers, Grass } from "./world-3d-grass.tsx";
import { Houses } from "./world-3d-houses.tsx";
import {
	Keycap,
	QuestTracker,
	Village3dEmpty,
	Village3dHud,
	Village3dMinimap,
	Village3dPrompt,
} from "./world-3d-hud.tsx";
import {
	agentUrgencies,
	askTrackerGoal,
	isUrgent,
	threadSpeaker,
	trackerGoal,
} from "./world-3d-model.ts";
import {
	type CameraFocus,
	FollowCamera,
	focusDistance,
	fogRange,
	type IsoFrame,
	OccluderFade,
	uncoveredSize,
	type ViewShift,
} from "./world-3d-scene.tsx";
import { type SpreadVillage, spreadVillage } from "./world-3d-spread.ts";
import { Island, Trees, treeObstacles } from "./world-3d-terrain.tsx";
import { SCENE_THEMES, tileToWorld, worldToTile } from "./world-3d-theme.ts";
import {
	AgentCrowd,
	type CrowdMember,
	NearRing,
	PlayerCharacter,
	WorkSparkles,
} from "./world-3d-villagers.tsx";
import { layoutVillage } from "./world-village.ts";

/** The rig's body language for an act (none for the rest). */
function bodyLanguage(act: InterfaceAgentAct | undefined): CrowdMember["act"] {
	if (act?.act === "asking" || act?.act === "limited") {
		return act.act;
	}
	if (act?.act === "blocked" && act.blockers[0]?.kind !== "interrupted") {
		return "blocked";
	}
	return undefined;
}

/** Height of the agents' name plates above their feet, in tiles. */
const LABEL_HEIGHT = 1.5;
const CHARACTER_LIFT = 0.05;

const THINKING_DOTS = ["first", "second", "third"] as const;

/** Three dots rising in turn: the agent is thinking (still while reduced). */
function ThinkingDots({ reducedMotion }: { reducedMotion: boolean }) {
	return (
		<>
			{THINKING_DOTS.map((dot, index) => (
				<motion.span
					animate={
						reducedMotion
							? { opacity: 1, y: 0 }
							: { opacity: [0.45, 1, 0.45, 0.45], y: [0, -3, 0, 0] }
					}
					className="size-1 rounded-full bg-muted-foreground"
					key={dot}
					transition={
						reducedMotion
							? { duration: 0 }
							: {
									delay: index * 0.15,
									duration: 1.1,
									ease: "easeInOut",
									repeat: Number.POSITIVE_INFINITY,
									times: [0, 0.3, 0.6, 1],
								}
					}
				/>
			))}
		</>
	);
}

/**
 * A cottage's roof seen from the street: the eaves and the ridge (with the
 * overhang and ridge cap), in tiles above the ground. The gable faces the
 * street, so the roof is highest along the cottage's middle.
 */
const ROOF_EAVE = 1.3;
const ROOF_RIDGE = 2.42;
/** Spacing of the points tested along the line from a name plate to the lens. */
const SIGHT_STEP = 0.35;
/** How far toward the lens the test looks; farther roofs are off screen. */
const SIGHT_REACH = 26;
/** Frames between occlusion checks for one name plate. */
const SIGHT_EVERY = 5;

/**
 * Whether a roof stands between the lens and `point` (both in the bent,
 * drawn space): the line is sampled toward the lens and every sample is
 * lifted back by the world's bend before it is tested against a cottage.
 */
function roofBetween(
	eye: Vector3,
	point: Vec3,
	boxes: readonly HouseBox[]
): boolean {
	const dx = eye.x - point[0];
	const dy = eye.y - point[1];
	const dz = eye.z - point[2];
	const length = Math.hypot(dx, dy, dz);
	const reach = Math.min(length, SIGHT_REACH);
	const minX = Math.min(point[0], point[0] + (dx / length) * reach);
	const maxX = Math.max(point[0], point[0] + (dx / length) * reach);
	const minZ = Math.min(point[2], point[2] + (dz / length) * reach);
	const maxZ = Math.max(point[2], point[2] + (dz / length) * reach);
	const nearby = boxes.filter(
		(box) =>
			box.maxX > minX && box.minX < maxX && box.maxZ > minZ && box.minZ < maxZ
	);
	if (nearby.length === 0) {
		return false;
	}
	for (let along = SIGHT_STEP; along < reach; along += SIGHT_STEP) {
		const x = point[0] + (dx / length) * along;
		const z = point[2] + (dz / length) * along;
		const y = point[1] + (dy / length) * along + curveDrop(x, z);
		if (y > ROOF_RIDGE) {
			continue;
		}
		for (const box of nearby) {
			if (!(x > box.minX && x < box.maxX && z > box.minZ && z < box.maxZ)) {
				continue;
			}
			const middle = (box.minX + box.maxX) / 2;
			const half = (box.maxX - box.minX) / 2;
			const roof =
				ROOF_EAVE +
				(ROOF_RIDGE - ROOF_EAVE) * (1 - Math.abs(x - middle) / half);
			if (y < roof) {
				return true;
			}
		}
	}
	return false;
}

/** Head height the plate checks for a clear view of its agent. */
const HEAD_HEIGHT = 1.05;
/**
 * Pixels from the stage's side edges inside which a plate's center hides: a
 * plate half off screen reads as a stray letter, not a name.
 */
const PLATE_EDGE = 40;

/**
 * Shows or hides a name plate. A hidden plate is see-through and leaves the
 * Tab order, so keyboard focus never lands on a button nobody can see.
 */
export function showPlate(node: HTMLElement, shown: boolean): void {
	const opacity = shown ? "1" : "0";
	if (node.style.opacity === opacity) {
		return;
	}
	node.style.opacity = opacity;
	node.style.pointerEvents = shown ? "" : "none";
	node.tabIndex = shown ? 0 : -1;
}

/**
 * Name plate (and a thought bubble while working); the accessible talk
 * target. A plate is only drawn while its agent's head can be seen: when a
 * cottage in a nearer row hides it, the plate fades out rather than sitting
 * on someone else's roof, unless that agent is the one in reach (the plate
 * then also carries the talk prompt, beside it as the genre places it).
 * While a conversation is open every plate steps out of the shot. Hidden
 * plates stay in the page but leave the Tab order (see showPlate); the talk
 * buttons (and the tracker, which walks to its agent) still work.
 */
function AgentLabel({
	acted = null,
	boxes,
	entity,
	follow,
	hidden,
	index,
	layout,
	near,
	onTalk,
	reducedMotion,
	status,
}: {
	/**
	 * The act layer: the plate follows its villager (`at`), carries its
	 * bubble, and is pointer-only (aria-hidden, out of the tab order; the
	 * DOM lists are the per-agent targets). Pressing an asking agent's
	 * plate opens its ask.
	 */
	acted?: {
		activate?: () => void;
		at: Vec3;
		bubble: LifeBubble | null;
	} | null;
	boxes: readonly HouseBox[];
	entity: WorldEntity;
	/** With acts, the villager's drawn body the plate stays over. */
	follow?: () => { x: number; z: number } | undefined;
	/** A conversation is open: the plate leaves the shot. */
	hidden: boolean;
	/** Staggers the occlusion checks across frames. */
	index: number;
	layout: WorldLayout;
	near: boolean;
	onTalk: (agentId: string) => void;
	reducedMotion: boolean;
	/** The agent's most urgent conversation, when it asks for the user. */
	status: ThreadStatus | null;
}) {
	const working = entity.status === "working";
	const urgent =
		status && !acted ? THREAD_STATUS_LABELS[status].toLowerCase() : null;
	let plateName: string | undefined;
	if (!acted) {
		plateName = urgent
			? `Talk to ${entity.name}, ${urgent}`
			: `Talk to ${entity.name}`;
	}
	const position: Vec3 = acted
		? [acted.at[0], LABEL_HEIGHT, acted.at[2]]
		: tileToWorld(layout, entity, LABEL_HEIGHT);
	const button = useRef<HTMLButtonElement>(null);
	const frame = useRef(index);
	const head = useRef<Vec3>([0, 0, 0]);
	// A scratch vector for the edge test (cloned from the camera: `three` is
	// only a type import here).
	const projected = useRef<Vector3 | null>(null);
	useFrame(({ camera, size }) => {
		const node = button.current;
		if (!node) {
			return;
		}
		frame.current += 1;
		// Every frame at first (a slow renderer may draw only a few), then
		// staggered across frames.
		const settled = frame.current > SIGHT_EVERY * 2;
		if (!hidden && settled && frame.current % SIGHT_EVERY !== 0) {
			return;
		}
		// Where the villager is drawn now (it may be walking), not where it is
		// headed.
		const body = acted ? follow?.() : undefined;
		const x = body?.x ?? position[0];
		const z = body?.z ?? position[2];
		const drop = curveDrop(x, z);
		head.current = [x, HEAD_HEIGHT - drop, z];
		projected.current ??= camera.position.clone();
		const screenX = projected.current
			.set(x, LABEL_HEIGHT - drop, z)
			.project(camera).x;
		const edge = 1 - (PLATE_EDGE * 2) / Math.max(size.width, 1);
		const out =
			hidden ||
			Math.abs(screenX) > edge ||
			(!near && roofBetween(camera.position, head.current, boxes));
		showPlate(node, !out);
	});
	return (
		<CurvedAnchor follow={acted ? follow : undefined} position={position}>
			<Html center zIndexRange={[60, 0]}>
				<button
					aria-hidden={acted ? true : undefined}
					aria-label={plateName}
					className="group relative flex -translate-y-2 cursor-pointer select-none items-center whitespace-nowrap font-sans outline-none"
					data-act-plate={acted ? entity.agentId : undefined}
					onClick={() =>
						acted?.activate ? acted.activate() : onTalk(entity.agentId)
					}
					// A pointer-only plate never takes focus (it is aria-hidden).
					onPointerDown={acted ? (event) => event.preventDefault() : undefined}
					ref={button}
					tabIndex={acted ? -1 : undefined}
					type="button"
				>
					{acted?.bubble ? <LifeBubbleTag bubble={acted.bubble} /> : null}
					{working && !near && !acted ? (
						// A thought bubble beside the plate, not stacked over it.
						<span
							aria-hidden="true"
							className="absolute bottom-[calc(100%-4px)] left-[calc(100%-8px)] flex h-5 items-center gap-0.5 rounded-full border border-border bg-background px-1.5"
						>
							<ThinkingDots reducedMotion={reducedMotion} />
						</span>
					) : null}
					<span
						className={cn(
							"flex h-6 items-center gap-1.5 rounded-full border border-border bg-background px-2.5 font-medium text-foreground text-xs shadow-sm transition-colors group-hover:border-ring",
							near && "border-primary ring-1 ring-primary",
							// Focus outranks reach: a full ring, offset from the pill.
							"group-focus-visible:border-ring group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background",
							status === "your-turn" && "font-semibold"
						)}
					>
						{status === "attention" ? (
							<BoardStatusDot pulse={false} status={status} />
						) : null}
						<span className="max-w-32 truncate">{entity.name}</span>
					</span>
					{near ? (
						// The interaction prompt rides beside the plate it acts on.
						<span
							aria-hidden="true"
							className="absolute top-1/2 left-[calc(100%+8px)] flex h-6 -translate-y-1/2 items-center gap-1.5 rounded-md border border-border bg-card pr-2 pl-0.5 font-medium text-card-foreground text-xs shadow-sm"
						>
							<Keycap className="h-5 min-w-5">E</Keycap>
							Talk
						</span>
					) : null}
				</button>
			</Html>
		</CurvedAnchor>
	);
}

/** Pixels round a station's anchor that must clear the HUD's panels. */
const STATION_HUD_MARGIN = 48;

/**
 * Draws an agent's station plates (board, alarms, marks) only while they
 * can be read where they stand: the agent's head is in sight (no nearer
 * roof hides it), the anchor is clear of the stage's side edges, and it is
 * not under the HUD's panels (the tracker column or the act column), so a
 * back-row station's words never sit behind the summary or on a
 * front-row neighbour's roof. Checked every few frames, not every frame.
 */
function StationSight({
	at,
	boxes,
	children,
	index,
}: {
	at: Vec3;
	boxes: readonly HouseBox[];
	children: ReactNode;
	index: number;
}) {
	const [shown, setShown] = useState(true);
	const frame = useRef(index);
	const projected = useRef<Vector3 | null>(null);
	useFrame(({ camera, gl, size }) => {
		frame.current += 1;
		if (frame.current > SIGHT_EVERY * 2 && frame.current % SIGHT_EVERY !== 0) {
			return;
		}
		const [x, , z] = at;
		const drop = curveDrop(x, z);
		projected.current ??= camera.position.clone();
		const point = projected.current
			.set(x, LABEL_HEIGHT - drop, z)
			.project(camera);
		const edge = 1 - (PLATE_EDGE * 2) / Math.max(size.width, 1);
		const canvas = gl.domElement.getBoundingClientRect();
		const px = canvas.left + ((point.x + 1) / 2) * canvas.width;
		const py = canvas.top + ((1 - point.y) / 2) * canvas.height;
		const root =
			gl.domElement.closest("[data-testid='interface-world-3d']") ?? document;
		const underHud = [...root.querySelectorAll("[data-hud-band]")].some(
			(band) => {
				const rect = band.getBoundingClientRect();
				return (
					rect.width > 0 &&
					px > rect.left - STATION_HUD_MARGIN &&
					px < rect.right + STATION_HUD_MARGIN &&
					py > rect.top - STATION_HUD_MARGIN &&
					py < rect.bottom + STATION_HUD_MARGIN
				);
			}
		);
		const next = !(
			Math.abs(point.x) > edge ||
			underHud ||
			roofBetween(camera.position, [x, HEAD_HEIGHT - drop, z], boxes)
		);
		if (next !== shown) {
			setShown(next);
		}
	});
	return shown ? children : null;
}

const NO_GHOSTS: ReadonlySet<string> = new Set();
/** Margin around the cottages the isometric view keeps in frame, in tiles. */
const ISO_MARGIN = 1.5;

/** The cottages, their doorsteps and the spawn point: what isometric fits. */
function villageFrame({ layout, village }: SpreadVillage): IsoFrame {
	const points: [number, number][] = [];
	for (const box of houseBoxes(layout, village.houses)) {
		points.push(
			[box.minX, box.minZ],
			[box.maxX, box.minZ],
			[box.minX, box.maxZ],
			// Agents stand on the doorstep, a tile in front of the cottage.
			[box.maxX, box.maxZ + 1]
		);
	}
	const [spawnX, , spawnZ] = tileToWorld(layout, layout.spawn);
	points.push([spawnX, spawnZ]);
	return { margin: ISO_MARGIN, points };
}

/** What steps out of a conversation shot: cottages and trees. */
interface FocusClearing {
	houses: ReadonlySet<string>;
	trees: ReadonlySet<number>;
}

const NO_CLEARING: FocusClearing = { houses: NO_GHOSTS, trees: new Set() };

/**
 * Cottages that would still stand between the conversation camera and
 * either face (drawn see-through), and trees in the shot (they step out)
 * while the pair is framed.
 */
function useFocusClearing(
	focus: CameraFocus | null,
	boxes: ReturnType<typeof houseBoxes>,
	trees: readonly TreeObstacle[],
	mode: World3dParams["camera"],
	viewShift: ViewShift
): FocusClearing {
	const size = useThree((state) => state.size);
	const fov = useThree((state) =>
		"fov" in state.camera ? (state.camera.fov as number) : 40
	);
	// Stable keys, so the scenery only rebuilds when a set changes.
	const keys = useMemo(() => {
		if (!focus || mode !== "orbit") {
			return { houses: "", trees: "" };
		}
		const visible = uncoveredSize(size.width, size.height, viewShift);
		const distance = focusDistance(focus, fov, visible.width, visible.height);
		const center = pairCenter(focus.agent, focus.player);
		const eye = focusEye(center, focus.side, distance);
		return {
			houses: [...occludingHouses(focus.agent, focus.player, eye, boxes)]
				.sort()
				.join("\n"),
			trees: [...treesInShot(center, eye, trees)].join(","),
		};
	}, [boxes, focus, fov, mode, size, trees, viewShift]);
	return useMemo(() => {
		if (!(keys.houses || keys.trees)) {
			return NO_CLEARING;
		}
		return {
			houses: keys.houses ? new Set(keys.houses.split("\n")) : NO_GHOSTS,
			trees: new Set(
				keys.trees ? keys.trees.split(",").map((index) => Number(index)) : []
			),
		};
	}, [keys]);
}

/** An agent's plate with acts: where its villager is, its bubble, its press. */
function actedPlate(
	acts: WorldActView | null,
	agentId: string,
	at: ReadonlyMap<string, Vec3>,
	talkOrAsk: (agentId: string) => void
): { activate?: () => void; at: Vec3; bubble: LifeBubble | null } | null {
	const act = acts?.acts.get(agentId);
	const position = at.get(agentId);
	if (!(acts && act && position)) {
		return null;
	}
	const bubbleId = bubbleOverlayId(act);
	return {
		activate:
			act.act === "asking" && act.ask ? () => talkOrAsk(agentId) : undefined,
		at: position,
		bubble: bubbleId && acts.shown.has(bubbleId) ? actBubble(act) : null,
	};
}

function VillageScene({
	acts = null,
	camera,
	nearId,
	onHover,
	onTalk,
	player,
	quality,
	reducedMotion,
	spread,
	swatches,
	talkingId,
	theme,
	urgent,
	viewShift,
}: {
	/** The act layer (a snapshot with `asks`): where agents stand, their props. */
	acts?: WorldActView | null;
	camera: World3dParams["camera"];
	nearId: string | null;
	onHover: (agentId: string | null) => void;
	onTalk: (agentId: string) => void;
	player: ReturnType<typeof useWorldController>;
	quality: RenderQuality;
	reducedMotion: boolean;
	spread: SpreadVillage;
	swatches: ReadonlyMap<string, AgentSwatch>;
	talkingId: string | null;
	theme: Scene3dTheme;
	/** Agents whose most urgent conversation asks for the user. */
	urgent: ReadonlyMap<string, ThreadStatus>;
	viewShift: ViewShift;
}) {
	const { layout, mapPoint, village } = spread;
	const budget = QUALITY[quality];
	const playerRef = useRef<Group>(null);
	const glow = useGlowCanvas();
	const span = Math.max(layout.width, layout.height);
	const [fogNear, fogFar] = fogRange(camera);
	useMemo(() => setLook({ ...theme, sun: sunDirection(theme) }), [theme]);
	const working = useMemo(
		() =>
			new Set(
				layout.entities
					.filter((entity) => entity.status === "working")
					.map((entity) => entity.agentId)
			),
		[layout]
	);
	const you = useMemo(() => worldYouSpot(layout), [layout]);
	// A working agent's plan or workflow steps light its cottage's windows
	// (never an estimate's guess). Keyed by the counts, not the acts map (a
	// new one every second), so the cottages rebuild only when they change.
	const pipsKey = acts
		? [...acts.acts.values()]
				.flatMap((act) =>
					act.act === "working" &&
					(act.progress?.kind === "plan" || act.progress?.kind === "workflow")
						? [`${act.agentId}:${act.progress.done}:${act.progress.total}`]
						: []
				)
				.sort()
				.join("|")
		: "";
	const pips = useMemo(
		() =>
			new Map(
				pipsKey
					.split("|")
					.filter(Boolean)
					.map((entry) => {
						const [agentId = "", done = "0", total = "0"] = entry.split(":");
						return [agentId, { done: Number(done), total: Number(total) }];
					})
			),
		[pipsKey]
	);
	// Each villager's looks, stable while the cast and theme are.
	const looksById = useMemo(
		() =>
			new Map(
				layout.entities.map((entity) => [
					entity.agentId,
					villagerLooks(entity.agentId, swatchOf(swatches, entity.agentId)),
				])
			),
		[layout, swatches]
	);
	// Where each villager is drawn as it walks: its plate follows it.
	const bodies = useRef(new Map<string, LifeBody>());
	const followBody = useCallback(
		(agentId: string) => () => bodies.current.get(agentId),
		[]
	);
	const members = useMemo<CrowdMember[]>(() => {
		// Answers wait in the basket in a row, one place per deliverer.
		const delivering = [...(acts?.acts.values() ?? [])]
			.filter((act) => act.act === "delivering")
			.map((act) => act.agentId);
		return layout.entities.map((entity) => {
			const home = tileToWorld(layout, entity, CHARACTER_LIFT);
			const act = acts?.acts.get(entity.agentId);
			return {
				agentId: entity.agentId,
				looks:
					looksById.get(entity.agentId) ??
					villagerLooks(entity.agentId, swatchOf(swatches, entity.agentId)),
				// With acts an asking agent queues on your doorstep; the one you
				// talk to comes home to talk, where the conversation is framed.
				position:
					act && acts && entity.agentId !== talkingId
						? worldActorAt(
								act,
								home,
								you.points,
								acts.slots.slots,
								reducedMotion,
								delivering.indexOf(entity.agentId)
							)
						: home,
				act: bodyLanguage(act),
				carry: act ? worldCarry(act) : null,
				working: acts ? act?.act === "working" : entity.status === "working",
			};
		});
	}, [acts, layout, looksById, reducedMotion, swatches, talkingId, you]);
	const memberAt = useMemo(
		() => new Map(members.map((member) => [member.agentId, member.position])),
		[members]
	);
	// With acts an asking agent is answered, not talked to.
	const talkOrAsk = useCallback(
		(agentId: string) => {
			const askId = acts?.acts.get(agentId)?.ask?.id;
			if (acts && acts.acts.get(agentId)?.act === "asking" && askId) {
				acts.onAsk(askId);
				return;
			}
			onTalk(agentId);
		},
		[acts, onTalk]
	);
	const workingSpots = useMemo(
		() =>
			members
				.filter((member) => member.working)
				.map((member) => member.position),
		[members]
	);
	const nearEntity = layout.entities.find(
		(entity) => entity.agentId === nearId
	);
	// The ring follows the drawn body: an asker stands in your queue.
	const nearBody = nearId ? memberAt.get(nearId) : undefined;
	let nearPosition: Vec3 | null = null;
	if (nearEntity) {
		nearPosition = nearBody
			? [nearBody[0], 0, nearBody[2]]
			: tileToWorld(layout, nearEntity);
	}
	const talkingEntity = layout.entities.find(
		(entity) => entity.agentId === talkingId
	);
	const talkingAt = talkingEntity ? tileToWorld(layout, talkingEntity) : null;
	// In a conversation the player steps beside the agent, so the two face
	// each other side by side; walking away steps back onto the grid.
	const playerTarget = talkingEntity
		? conversationSpot(tileToWorld(layout, talkingEntity, CHARACTER_LIFT))
		: tileToWorld(layout, mapPoint(player.player), CHARACTER_LIFT);
	const boxes = useMemo(
		() => houseBoxes(layout, village.houses),
		[layout, village]
	);
	const trees = useMemo(
		() => treeObstacles(layout, village, theme),
		[layout, theme, village]
	);
	const bounds = useMemo(() => villageFrame(spread), [spread]);
	const focus: CameraFocus | null = talkingAt
		? {
				agent: talkingAt,
				player: playerTarget,
				side: chooseFocusSide(talkingAt, playerTarget, boxes, trees),
			}
		: null;
	const clearing = useFocusClearing(focus, boxes, trees, camera, viewShift);
	const outdoors = theme.rim === "forest";
	// Fireflies gather around doorsteps (the lamps) and flower beds.
	const glimmerSpots = useMemo<Vec3[]>(
		() =>
			theme.night
				? [
						...layout.entities.map((entity) => tileToWorld(layout, entity)),
						...village.flowers.map((tile) => tileToWorld(layout, tile)),
					]
				: [],
		[layout, theme.night, village]
	);

	return (
		<>
			<color args={[skyColors(theme).horizon]} attach="background" />
			<fog args={[theme.skyHorizon, fogNear, fogFar]} attach="fog" />
			<SkyDome reducedMotion={reducedMotion} theme={theme} />
			<SceneLights shadowMap={budget.shadowMap} span={span} theme={theme} />
			{theme.clouds && camera === "orbit" ? (
				<Clouds reducedMotion={reducedMotion} theme={theme} />
			) : null}
			<Island layout={layout} theme={theme} village={village} />
			{outdoors ? (
				<Grass
					layout={layout}
					max={budget.maxGrass}
					perTile={budget.grassPerTile}
					reducedMotion={reducedMotion}
					theme={theme}
					village={village}
				/>
			) : null}
			{outdoors ? <Flowers layout={layout} village={village} /> : null}
			<Trees
				hidden={clearing.trees}
				layout={layout}
				theme={theme}
				village={village}
			/>
			<Houses
				ghosts={clearing.houses}
				layout={layout}
				pips={pips}
				reducedMotion={reducedMotion}
				swatches={swatches}
				theme={theme}
				village={village}
				working={working}
			/>
			{reducedMotion || !outdoors ? null : (
				<Glimmers
					count={theme.night ? Math.round(budget.pollen * 2.5) : budget.pollen}
					glow={glow}
					height={layout.height}
					spots={glimmerSpots}
					theme={theme}
					width={layout.width}
				/>
			)}
			{acts ? (
				<WorldActStage
					layout={layout}
					reduced={reducedMotion}
					sight={(at, index, station) => (
						<StationSight at={at} boxes={boxes} index={index}>
							{station}
						</StationSight>
					)}
					view={acts}
				/>
			) : null}
			<AgentCrowd
				bodies={bodies.current}
				members={members}
				nearId={nearId}
				onHover={onHover}
				onTalk={talkOrAsk}
				playerRef={playerRef}
				reducedMotion={reducedMotion}
				talkingId={talkingId}
				walk={acts !== null}
			/>
			{acts ? (
				<WorldHelpers
					acts={acts.acts}
					follow={followBody}
					ground={CHARACTER_LIFT}
					hidden={talkingEntity !== undefined}
					looks={looksById}
					reduced={reducedMotion}
				/>
			) : null}
			{reducedMotion ? null : (
				<WorkSparkles glow={glow} positions={workingSpots} />
			)}
			{layout.entities.map((entity, index) => (
				<AgentLabel
					acted={actedPlate(acts, entity.agentId, memberAt, talkOrAsk)}
					boxes={boxes}
					entity={entity}
					follow={() => bodies.current.get(entity.agentId)}
					hidden={talkingEntity !== undefined}
					index={index}
					key={entity.agentId}
					layout={layout}
					near={entity.agentId === nearId}
					onTalk={onTalk}
					reducedMotion={reducedMotion}
					status={urgent.get(entity.agentId) ?? null}
				/>
			))}
			{nearEntity && nearPosition && !talkingEntity ? (
				<NearRing
					color={swatchOf(swatches, nearEntity.agentId).dot}
					position={nearPosition}
					reducedMotion={reducedMotion}
				/>
			) : null}
			<PlayerCharacter
				faceToward={talkingAt}
				facing={player.facing}
				groupRef={playerRef}
				marker={!(nearEntity || talkingEntity)}
				reducedMotion={reducedMotion}
				target={playerTarget}
			/>
			<OccluderFade focus={focus} playerRef={playerRef} />
			<FollowCamera
				bounds={bounds}
				focus={focus}
				indoors={!outdoors}
				mode={camera}
				playerRef={playerRef}
				reducedMotion={reducedMotion}
				shoreZ={tileToWorld(layout, { x: 0, y: layout.height })[2] - 0.5}
				span={span}
				viewShift={viewShift}
			/>
			<Bloom samples={quality === "high" ? 4 : 2} strength={theme.bloom} />
		</>
	);
}

/**
 * Frames before the world counts as shown: the first frame compiles the
 * shaders and draws in the same tick, before React hides the cover.
 */
const READY_FRAMES = 1;

/** Calls `onReady` once the scene has drawn its first frames. */
function FirstFrames({ onReady }: { onReady: () => void }) {
	const frames = useRef(0);
	useFrame(() => {
		frames.current += 1;
		if (frames.current === READY_FRAMES) {
			onReady();
		}
	});
	return null;
}

/**
 * Covers the stage until the scene has drawn (compiling the cel shaders
 * takes a moment, longest on software renderers), so the world never
 * flashes an empty or white frame. The cover is the theme's sky, with the
 * HUD's places held by placeholders, so the scene lands in place.
 */
function LoadingWorld({
	minimapSize,
	sky,
}: {
	minimapSize: number;
	sky: string;
}) {
	return (
		<div
			className="pointer-events-none absolute inset-0 z-[300] font-sans"
			role="status"
			style={{ background: sky }}
		>
			<span className="sr-only">Loading world</span>
			<div className="absolute top-3 left-3 flex flex-col gap-3">
				<Skeleton
					// Where the minimap's ring lands on the 12px gutter.
					className="@max-[480px]:hidden"
					radius="pill"
					style={{ height: minimapSize, width: minimapSize }}
				/>
				<Skeleton className="h-14 w-64" radius="row" />
			</div>
			<Skeleton
				className="absolute right-3 bottom-3 @max-[480px]:hidden h-8 w-56"
				radius="row"
			/>
		</div>
	);
}

/**
 * The port the shared world controller drives: talking to an agent closes
 * the open thread first, which is only news to the host when one is open.
 */
function useWorldPort(
	port: InterfacePort,
	activeThreadId: string | null
): InterfacePort {
	const open = useRef(activeThreadId !== null);
	open.current = activeThreadId !== null;
	return useMemo(
		() => ({
			...port,
			closeThread: () => {
				if (open.current) {
					port.closeThread();
				}
			},
		}),
		[port]
	);
}

/**
 * Three-dimensional twin of the 2D world: the same village (a cottage per
 * agent, paths, a plaza and a forest rim) as a cel-shaded island that rolls
 * away over a curved horizon under an anime sky. The player walks up to an
 * agent (or clicks one) to talk; the dialogue offers past conversations and
 * a composer, and an open conversation shows the host's chat surface.
 */
export function World3dInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<World3dParams>) {
	const actsView = useActs(snapshot);
	const { acts, enabled: withActs, nowMs, privacy, unowned } = actsView;
	// With acts an agent works (lit windows, sparkles, plate dots, the
	// minimap's count) only when its act says so.
	// Keyed by who works, not by the acts map (a new one every second), so
	// the village only rebuilds when that changes.
	const workingKey = withActs
		? [...acts.values()]
				.filter((act) => act.act === "working")
				.map((act) => act.agentId)
				.sort()
				.join("|")
		: null;
	const layout = useMemo(() => {
		const laid = layoutWorld(snapshot);
		if (workingKey === null) {
			return laid;
		}
		const working = new Set(workingKey.split("|"));
		return {
			...laid,
			entities: laid.entities.map((entity) => {
				let status = entity.status;
				if (working.has(entity.agentId)) {
					status = "working";
				} else if (status === "working") {
					status = "idle";
				}
				return { ...entity, status };
			}),
		};
	}, [snapshot, workingKey]);
	const village = useMemo(() => layoutVillage(layout), [layout]);
	const spread = useMemo(
		() => spreadVillage(layout, village),
		[layout, village]
	);
	// The canvas act stage: every agent with a cottage is on stage.
	const placed = useMemo(
		() => new Set(layout.entities.map((entity) => entity.agentId)),
		[layout]
	);
	const staged = useMemo(() => {
		const inWorld = new Map(
			[...acts].filter(([agentId]) => placed.has(agentId))
		);
		return stageAgents(inWorld, Number.POSITIVE_INFINITY);
	}, [acts, placed]);
	const slots = useMemo(
		() =>
			youSpotSlots(
				acts,
				unowned,
				staged.onStage.map((act) => act.agentId)
			),
		[acts, staged, unowned]
	);
	const reducedMotion = useReducedMotion();
	// The village as you walk it: with acts an asking villager is drawn in
	// your queue, so you bump into, stand by and answer it there, not at its
	// empty cottage (see VillageScene's `members`).
	const actLayout = useMemo(() => {
		if (!withActs) {
			return layout;
		}
		const you = worldYouSpot(layout);
		return {
			...layout,
			entities: layout.entities.map((entity) => {
				const act = acts.get(entity.agentId);
				if (act?.act !== "asking") {
					return entity;
				}
				const at = worldActorAt(
					act,
					tileToWorld(layout, entity, CHARACTER_LIFT),
					you.points,
					slots.slots,
					reducedMotion
				);
				return { ...entity, ...worldToTile(layout, at) };
			}),
		};
	}, [acts, layout, reducedMotion, slots, withActs]);
	const worldPort = useWorldPort(port, activeThreadId);
	const world = useWorldController(actLayout, worldPort, village.blocked);
	useMeetActiveThreadAgent(snapshot, activeThreadId, world);
	const probe = useWebGLProbe();
	const { stageRef, stageWidth } = useStageWidth();
	// Without WebGL (and with acts) the agents are a plain list: no HUD over
	// it, and the map is not a keyboard surface.
	const listOnly = withActs && probe?.supported === false;
	const rootRef = useRef<HTMLDivElement>(null);
	const covered = useInterfaceCovered(rootRef);
	const [drawn, setDrawn] = useState(false);
	const onDrawn = useCallback(() => setDrawn(true), []);
	const [hovered, setHovered] = useState<string | null>(null);
	const { talkingAgent, talkingThreads } = useTalkingAgent(
		snapshot,
		world.talkingTo,
		activeThreadId
	);
	const theme = SCENE_THEMES[params.theme];
	const swatches = useMemo(
		() =>
			agentSwatches(
				layout.entities.map((entity) => entity.agentId),
				theme.night
			),
		[layout, theme.night]
	);
	const isometric = params.camera === "isometric";
	const urgent = useMemo(() => {
		const statuses = new Map<string, ThreadStatus>();
		if (withActs) {
			// With acts the plates flag what the acts say: an ask, a stop.
			for (const act of acts.values()) {
				if (act.act === "asking") {
					statuses.set(act.agentId, "your-turn");
				} else if (
					act.act === "blocked" &&
					act.blockers[0]?.kind !== "interrupted"
				) {
					statuses.set(act.agentId, "attention");
				}
			}
			return statuses;
		}
		for (const [agentId, urgency] of agentUrgencies(snapshot.threads)) {
			if (isUrgent(urgency.status)) {
				statuses.set(agentId, urgency.status);
			}
		}
		return statuses;
	}, [acts, snapshot.threads, withActs]);
	const sentence = useActAnnouncement(snapshot, actsView);
	const clock = useActClockOptions();
	const worldHeadingRef = useRef<HTMLHeadingElement>(null);
	const cards = useActCards({
		acts,
		clock,
		fallbackFocus: worldHeadingRef,
		nowMs,
		port,
		snapshot,
	});
	const queueOpener = useRef<(() => void) | null>(null);
	const totals = actTotals(snapshot, acts);
	const owners = useMemo(() => askOwners(acts), [acts]);
	// The kit settings (overlay density, work bubbles) for its own pieces too.
	const kitSettings = useGameKitSettings();
	const stageBudget = overlayBudget(stageWidth, { domTargets: false });
	const shownKey = withActs
		? [
				...stageBudget.fill(
					actOverlays(staged.onStage, slots, staged.offStage, null, {
						reduced: reducedMotion,
					}).filter((item) => keepsActOverlay(item, kitSettings))
				),
			]
				.sort()
				.join("|")
		: "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the chosen ids, not the set's identity.
	const shown = useMemo(() => new Set(shownKey.split("|")), [shownKey]);
	const onAsk = (askId: string, opener?: HTMLElement) =>
		cards.openAsk(askId, opener);
	const onBlocker = (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => cards.openBlocker(threadId, agentName, opener);
	// With acts the tracker leads to the first blocking ask, else it sums up.
	const goal = withActs
		? (askTrackerGoal(
				snapshot.asks ?? [],
				snapshot.agents,
				privacy,
				(ask, name) =>
					queuePlateText(
						name,
						{
							approx: ask.sinceApprox,
							since: ask.since,
							until: ask.expiresAt ?? null,
							untilApprox: ask.expiresApprox,
						},
						nowMs
					).slice(name.length),
				placed
			) ?? {
				agentId: null,
				agentName: null,
				detail: "",
				status: null,
				// Asks nobody owns wait in the queue; the summary line beside it
				// already counts them, so the tracker never repeats it.
				title: (() => {
					if (loading) {
						return "Loading agents";
					}
					return totals.needYou > 0
						? "Open the queue to see what needs you"
						: "Nothing needs you right now";
				})(),
			})
		: trackerGoal({
				entities: layout.entities,
				loading,
				player: world.player,
				threads: snapshot.threads,
			});
	const { openAsk: openAskCard, openBlocker: openBlockerCard } = cards;
	const mapRef = world.mapRef;
	const actView = useMemo<WorldActView | null>(
		() =>
			withActs
				? {
						acts,
						clock,
						iconOnly: stageBudget.iconOnly,
						nowMs,
						offStage: staged.offStage,
						// Cards opened from the canvas return focus to the map.
						onAsk: (askId) => openAskCard(askId, mapRef.current ?? undefined),
						onBlocker: (threadId, agentName) =>
							openBlockerCard(threadId, agentName, mapRef.current ?? undefined),
						onQueue: () => openQueue(queueOpener),
						onStage: staged.onStage,
						owners,
						privacy,
						shown,
						slots,
						snapshot,
						talking: world.talkingTo !== null,
					}
				: null,
		[
			acts,
			clock,
			nowMs,
			mapRef,
			openAskCard,
			openBlockerCard,
			owners,
			privacy,
			shown,
			slots,
			snapshot,
			staged,
			stageBudget.iconOnly,
			withActs,
			world.talkingTo,
		]
	);
	// With acts an asking agent is answered, not walked to or talked to:
	// the tracker and the talk keys open its ask (it waits on your step).
	const askOf = (agentId: string) => {
		const act = withActs ? acts.get(agentId) : undefined;
		return act?.act === "asking" ? act.ask : null;
	};
	const talkOrAnswer = (
		agentId: string,
		opener?: HTMLElement,
		askId?: string
	) => {
		const ask = askOf(agentId);
		// The tracker names one ask: it opens exactly that one, and focus
		// returns to the tracker when the card closes.
		const id = askId ?? ask?.id;
		if (id) {
			cards.openAsk(id, opener ?? world.mapRef.current ?? undefined);
			return;
		}
		world.talkTo(agentId);
	};
	const onMapKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const ask = world.nearby ? askOf(world.nearby.agentId) : null;
		// E, Enter and Space beside an asker answer it (the controller's talk
		// keys would visit it), past its own guards.
		if (ask && isAskKey(event)) {
			event.preventDefault();
			cards.openAsk(ask.id, world.mapRef.current ?? undefined);
			return;
		}
		world.onKeyDown(event);
	};
	const actButtons = (
		<div className="flex gap-2">
			<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={totals} />
			<QueueButton
				acts={acts}
				clock={clock}
				narrow={stageWidth < 640}
				nowMs={nowMs}
				onAsk={onAsk}
				onBlocker={onBlocker}
				openRef={queueOpener}
				snapshot={snapshot}
				totals={totals}
				unowned={unowned}
			/>
		</div>
	);
	const summary = (
		<p
			className={cn(
				GAME_PLATE,
				"pointer-events-auto w-fit max-w-full truncate rounded-xl px-3 py-1.5 font-semibold text-[13px]"
			)}
			data-act-summary=""
		>
			{actSummaryLine(totals)}
		</p>
	);
	const askQueue = (mode: "reveal" | "sheet") => (
		<AskQueueList
			acts={acts}
			clock={clock}
			fallbackFocus={worldHeadingRef}
			mode={mode}
			nowMs={nowMs}
			onAsk={onAsk}
			onBlocker={onBlocker}
			snapshot={snapshot}
			unowned={unowned}
		/>
	);
	const agentList = (revealOnFocus: boolean) => (
		<ActAgentList
			acts={acts}
			clock={clock}
			nowMs={nowMs}
			onAsk={onAsk}
			onBlocker={onBlocker}
			onOpenThread={port.openThread}
			revealOnFocus={revealOnFocus}
			snapshot={snapshot}
		/>
	);
	const empty = !loading && layout.entities.length === 0;
	const nearby = world.nearby;
	// The dialogue already says who you are talking to.
	const showPrompt = !(talkingAgent && nearby?.agentId === talkingAgent.id);
	const viewShift = useMemo<ViewShift>(() => {
		if (!talkingAgent) {
			return { x: 0, y: 0 };
		}
		if (threadView) {
			// Panel docked on the right: clamp(360px, 46vw, 680px).
			const panel = Math.min(680, Math.max(360, stageWidth * 0.46));
			return { x: panel / 2, y: 0 };
		}
		return {
			x: stageWidth > 720 ? CHOICES_WIDTH / 2 : 0,
			y: BAND_HEIGHT / 2,
		};
	}, [stageWidth, talkingAgent, threadView]);
	const minimapSize = stageWidth < 900 ? 96 : 120;
	const hud =
		talkingAgent || listOnly ? null : (
			<Village3dHud
				acts={
					// Without WebGL the list overlay carries them instead.
					withActs && !empty && !listOnly ? (
						<>
							{summary}
							<BlindSpotCaption snapshot={snapshot} />
							{actButtons}
						</>
					) : undefined
				}
				empty={
					empty ? (
						<Village3dEmpty
							onStart={() => port.startThread({})}
							place={theme.place}
						/>
					) : undefined
				}
				minimap={
					// The "Minimap" setting (shown unless turned off).
					layout.entities.length > 0 && params.minimap !== false ? (
						<Village3dMinimap
							entities={layout.entities}
							facing={world.facing}
							layout={layout}
							nearbyId={nearby?.agentId ?? null}
							player={world.player}
							size={minimapSize}
							swatches={swatches}
							theme={theme}
							village={village}
						/>
					) : undefined
				}
				prompt={
					showPrompt && !empty ? (
						<Village3dPrompt
							answer={nearby ? askOf(nearby.agentId) !== null : false}
							loading={loading}
							nearbyName={nearby?.name ?? null}
							orbit={!isometric}
						/>
					) : undefined
				}
				talkReady={Boolean(nearby)}
				tracker={
					empty ? undefined : <QuestTracker goal={goal} onGo={talkOrAnswer} />
				}
			/>
		);
	const sky = `linear-gradient(${theme.skyZenith}, ${theme.skyHorizon})`;

	return (
		<div
			className="relative flex size-full min-h-0"
			// The act layer's plates and buttons are game-kit pieces: with acts
			// the world carries the kit's tokens (old hosts are unchanged).
			data-game-accent={withActs ? "sky" : undefined}
			data-game-shell={withActs ? "" : undefined}
			data-testid="interface-world-3d"
			ref={rootRef}
		>
			{withActs ? <style>{GAME_KIT_CSS}</style> : null}
			<div
				className="@container relative isolate min-w-0 flex-1 overflow-hidden"
				ref={stageRef}
				style={{ background: sky }}
			>
				{/* The HUD comes first in the tab order: the tracker sits top left. */}
				{hud}
				{withActs ? (
					// Siblings of the map (never inside role="application"), so its
					// keys never see theirs.
					<>
						<h1 className="sr-only" ref={worldHeadingRef} tabIndex={-1}>
							World 3D
						</h1>
						{/* Above the HUD when revealed by focus, so its rows and rings
						    show. Without WebGL the list column carries both, visibly. */}
						{listOnly ? null : (
							<div className="pointer-events-none absolute inset-0 z-[450] [&_button]:pointer-events-auto [&_ul]:pointer-events-auto">
								{askQueue("reveal")}
								{probe?.supported ? agentList(true) : null}
							</div>
						)}
					</>
				) : null}
				<div
					aria-busy={loading}
					aria-hidden={listOnly ? true : undefined}
					aria-label={
						listOnly
							? undefined
							: "Agent world in 3D: a village with a house per agent. Use arrow keys or WASD to walk, E to talk to the agent in front of you, Escape to walk away."
					}
					className={cn(
						// The ring rides an overlay above the canvas, which would cover an
						// inset ring painted on this element.
						"relative size-full outline-none after:pointer-events-none after:absolute after:inset-0 after:z-10 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset",
						hovered && "cursor-pointer"
					)}
					onKeyDown={listOnly ? undefined : onMapKeyDown}
					ref={world.mapRef}
					role={listOnly ? undefined : "application"}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the scene is a keyboard-driven game surface (role="application").
					tabIndex={listOnly ? undefined : 0}
				>
					{probe?.supported ? (
						<Canvas
							camera={
								isometric
									? { far: 400, near: 0.1, position: [16, 18, 16], zoom: 60 }
									: { far: 1000, fov: 40, near: 0.1, position: [3, 6.2, 12] }
							}
							dpr={QUALITY[probe.quality].dpr}
							// Under a page the host opened over this interface, draw nothing.
							frameloop={covered ? "never" : "always"}
							gl={{ antialias: false }}
							key={params.camera}
							orthographic={isometric}
							shadows="soft"
						>
							<VillageScene
								acts={actView}
								camera={params.camera}
								nearId={nearby?.agentId ?? null}
								onHover={setHovered}
								onTalk={world.talkTo}
								player={world}
								quality={probe.quality}
								reducedMotion={reducedMotion}
								spread={spread}
								swatches={swatches}
								talkingId={talkingAgent?.id ?? null}
								theme={theme}
								urgent={urgent}
								viewShift={viewShift}
							/>
							<FirstFrames onReady={onDrawn} />
						</Canvas>
					) : null}
					{probe && !probe.supported && !withActs ? (
						<div className="flex size-full items-center justify-center bg-background p-6">
							<p className="max-w-sm text-center text-muted-foreground text-sm">
								World 3D needs WebGL, which is not available here. Switch to
								World 2D to see the same agents.
							</p>
						</div>
					) : null}
				</div>
				{probe === null || (probe.supported && !drawn) ? (
					<LoadingWorld minimapSize={minimapSize} sky={sky} />
				) : null}
				{listOnly ? (
					// Without WebGL the agents are a list: the text equivalent,
					// with nothing drawn over it.
					<div className="absolute inset-0 z-[400] flex flex-col gap-3 overflow-y-auto bg-background p-4">
						{summary}
						<BlindSpotCaption snapshot={snapshot} />
						<p className="text-muted-foreground text-sm">
							3D needs WebGL; switch to World 2D for the map.
						</p>
						{actButtons}
						{askQueue("sheet")}
						{agentList(false)}
						{/* No agents: the empty state lives in the list column, never
						    under it as a hidden Tab stop. */}
						{empty ? (
							<Village3dEmpty
								onStart={() => port.startThread({})}
								place={theme.place}
							/>
						) : null}
					</div>
				) : null}
				{talkingAgent ? (
					<World3dDialog
						activeThreadId={activeThreadId}
						acts={
							withActs && acts.get(talkingAgent.id)
								? {
										act: acts.get(talkingAgent.id) as NonNullable<
											ReturnType<typeof acts.get>
										>,
										agentName: talkingAgent.name,
										asks: (snapshot.asks ?? []).filter(
											(ask) => ask.agentId === talkingAgent.id
										),
										nowMs,
										onAsk,
										privacy,
									}
								: undefined
						}
						agent={talkingAgent}
						onClose={world.walkAway}
						port={port}
						threads={talkingThreads}
						threadView={threadView}
					/>
				) : null}
				{withActs ? <ActAnnouncer sentence={sentence} /> : null}
				{cards.element}
			</div>
		</div>
	);
}

/**
 * When a thread is opened from outside the world (or was open as it
 * mounted), walk the player up to that thread's agent so the framing and the
 * open panel agree. A thread opened from a conversation keeps its speaker:
 * when the agent the player is talking to is in the thread, nobody moves.
 * Runs once per newly opened thread.
 */
function useMeetActiveThreadAgent(
	snapshot: InterfaceRendererProps<World3dParams>["snapshot"],
	activeThreadId: string | null,
	world: { meet: (agentId: string) => void; talkingTo: string | null }
): void {
	const agentIds = activeThreadId
		? (snapshot.threads.find((thread) => thread.id === activeThreadId)
				?.agentIds ?? null)
		: null;
	const met = useRef<string | null>(null);
	const { meet, talkingTo } = world;
	useEffect(() => {
		const agentId = agentIds ? threadSpeaker(agentIds, talkingTo) : null;
		if (!(activeThreadId && agentId)) {
			met.current = null;
			return;
		}
		// Keyed by thread: walking away clears the speaker a beat before the
		// host closes the thread, which must not send the player elsewhere.
		if (met.current === activeThreadId) {
			return;
		}
		met.current = activeThreadId;
		if (talkingTo !== agentId) {
			meet(agentId);
		}
	}, [activeThreadId, agentIds, meet, talkingTo]);
}

/** Width of the world's stage, kept in sync on resize. */
function useStageWidth() {
	const [stage, setStage] = useState<HTMLDivElement | null>(null);
	const [stageWidth, setStageWidth] = useState(1024);
	const stageRef = useCallback((node: HTMLDivElement | null) => {
		setStage(node);
		if (node) {
			setStageWidth(node.getBoundingClientRect().width);
		}
	}, []);
	useEffect(() => {
		if (!stage || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			if (entry) {
				setStageWidth(entry.contentRect.width);
			}
		});
		observer.observe(stage);
		return () => observer.disconnect();
	}, [stage]);
	return { stageRef, stageWidth };
}
