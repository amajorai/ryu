/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	ThreadStatus,
	WorldEntity,
	WorldLayout,
} from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import { type ReactNode, useRef, useState } from "react";
import type { Vector3 } from "three";
import { BoardStatusDot } from "./board-status.tsx";
import { CurvedAnchor } from "./game3d-anchor.tsx";
import type { LifeBubble } from "./game3d-life.ts";
import { LifeBubbleTag } from "./game3d-life.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { curveDrop } from "./game3d-toon.ts";
import type { HouseBox } from "./world-3d-focus.ts";
import { Keycap } from "./world-3d-hud.tsx";
import { tileToWorld } from "./world-3d-theme.ts";

/** Height of the agents' name plates above their feet, in tiles. */
export const LABEL_HEIGHT = 1.5;

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

/** A plate's accessible name: talk to the agent, and what it waits on. */
function talkPlateName(
	name: string,
	status: ThreadStatus | null,
	tl: LiteralMessage
): string {
	switch (status) {
		case "attention":
			return tl("Talk to {name}, needs attention", { name });
		case "quiet":
			return tl("Talk to {name}, not started", { name });
		case "waiting":
			return tl("Talk to {name}, waiting on agent", { name });
		case "working":
			return tl("Talk to {name}, working", { name });
		case "your-turn":
			return tl("Talk to {name}, your turn", { name });
		default:
			return tl("Talk to {name}", { name });
	}
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
export function AgentLabel({
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
	const tl = useLiteralMessages();
	const working = entity.status === "working";
	const plateName = acted ? undefined : talkPlateName(entity.name, status, tl);
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
						<span className="max-w-32 truncate" data-ryu-i18n="off">
							{entity.name}
						</span>
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
export function StationSight({
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
