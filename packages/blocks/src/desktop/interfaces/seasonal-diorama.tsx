/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { Check, Gift, Plus, Snowflake } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useMemo, useRef } from "react";
import type { InstancedMesh } from "three";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import {
	InstancedParts,
	type InstanceSpec,
	writeInstances,
} from "./game3d-instances.tsx";
import type { IslandShape } from "./game3d-island.ts";
import type { LifePaths } from "./game3d-life.ts";
import { ToonMaterial } from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import type { RenderQuality } from "./game3d-toon.ts";
import {
	type MemberLooks,
	type VillagerPose,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";
import type { Season, SeasonDoor } from "./seasonal-model.ts";
import { SEASON_3D } from "./seasonal-palette.ts";
import { PumpkinPatch } from "./seasonal-patch.tsx";
import { LanternStreet } from "./seasonal-street.tsx";
import { AdventSquare } from "./seasonal-village.tsx";
import {
	type SeasonWorld,
	villagerSpot,
	type WorldDoor,
} from "./seasonal-world.ts";

/**
 * The seasonal dioramas (see seasonal-world.ts for the layouts): the night
 * pumpkin patch, the snowy advent square and the lantern festival street.
 * Each of the 24 places carries a number plate in the scene that is its
 * door: the conversation's control, with the same state, today mark and
 * gift card wiring as the plain board.
 */

/** What a season's scene is drawn from. */
export interface SeasonSceneProps {
	doors: readonly SeasonDoor[];
	night: boolean;
	quality: RenderQuality;
	reducedMotion: boolean;
	shape: IslandShape;
	theme: Scene3dTheme;
	/** Snow over the advent square (the `weather` setting); on by default. */
	weather?: boolean;
	world: SeasonWorld;
}

/** A door's number plate: its control in the scene. */
export function DoorPlate({
	active,
	at,
	door,
	giftId,
	label,
	onActivate,
	numbered = true,
	onKeyDown,
	today,
}: {
	active: boolean;
	at: Vec3;
	/** Shows the number; off where the number is painted on the door. */
	numbered?: boolean;
	door: SeasonDoor;
	giftId: string | undefined;
	label: string;
	onActivate: (number: number, element: HTMLButtonElement) => void;
	onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
	today: boolean;
}) {
	const filled = door.thread !== null;
	const open = door.opened || active;
	let tone = numbered ? "" : "h-6 min-w-6 justify-center px-1.5 text-[12px]";
	if (active) {
		tone = cn(tone, "bg-(--gk-accent) text-(--gk-accent-ink)");
	} else if (door.mark === "needs-you") {
		tone = cn(tone, "bg-(--gk-bad) text-white");
	} else if (!filled) {
		tone = "h-6 px-2 text-(--gk-ink-muted) text-[12px] opacity-85";
	}
	return (
		<group position={at}>
			<Html center zIndexRange={[30, 0]}>
				<button
					aria-controls={giftId}
					aria-expanded={filled ? giftId !== undefined : undefined}
					aria-label={label}
					className={cn(
						GAME_PLATE,
						GAME_FOCUS,
						"gk-display flex h-7 cursor-pointer select-none items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-[14px] tabular-nums leading-none",
						today && "outline-(--gk-gold) outline-3 outline-solid",
						tone
					)}
					data-door={door.number}
					data-empty-door={filled ? undefined : ""}
					data-iso-order={door.number}
					data-iso-target=""
					data-state={open ? "open" : "closed"}
					onClick={(event) => onActivate(door.number, event.currentTarget)}
					onKeyDown={onKeyDown}
					type="button"
				>
					{numbered ? door.number : null}
					{numbered || filled ? null : (
						<Plus aria-hidden="true" className="size-3.5" strokeWidth={3} />
					)}
					{!numbered && filled && door.mark === null && !door.opened ? (
						<Gift aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
					) : null}
					{door.mark === "needs-you" && !active ? (
						<span aria-hidden="true" className="font-black">
							!
						</span>
					) : null}
					{door.mark === "stopped" ? (
						<Snowflake
							aria-hidden="true"
							className="size-3.5 text-(--gk-ink-muted)"
							data-stopped-mark=""
							strokeWidth={3}
						/>
					) : null}
					{door.mark === "working" ? (
						<span
							aria-hidden="true"
							className="font-black text-(--gk-good) text-[11px] tracking-tight"
						>
							•••
						</span>
					) : null}
					{door.opened && door.mark === null && filled ? (
						<Check
							aria-hidden="true"
							className="size-3.5 text-(--gk-gold)"
							strokeWidth={3.5}
						/>
					) : null}
					{today ? (
						<span
							className="ps-0.5 text-[10px] uppercase tracking-wide"
							data-today-word=""
						>
							Today
						</span>
					) : null}
				</button>
			</Html>
		</group>
	);
}

const FLAKES = 420;
const FALL_SPEED = 0.55;

/** Snow drifting down over the square (still under reduced motion). */
export function Snowfall({
	color,
	height,
	reducedMotion,
	span,
}: {
	color: string;
	height: number;
	reducedMotion: boolean;
	span: number;
}) {
	const ref = useRef<InstancedMesh>(null);
	const flakes = useMemo(
		() =>
			Array.from({ length: FLAKES }, (_, index) => ({
				drift: jitter(index, 4, 11) * Math.PI * 2,
				size: 0.035 + jitter(index, 5, 13) * 0.035,
				x: (jitter(index, 1, 7) - 0.5) * span,
				y: jitter(index, 2, 9) * height,
				z: (jitter(index, 3, 5) - 0.5) * span,
			})),
		[height, span]
	);
	const items = useMemo<InstanceSpec[]>(
		() =>
			flakes.map((flake) => ({
				position: [flake.x, flake.y, flake.z],
				scale: flake.size,
			})),
		[flakes]
	);
	useFrame(({ clock }) => {
		const mesh = ref.current;
		if (!mesh) {
			return;
		}
		if (reducedMotion) {
			return;
		}
		const time = clock.elapsedTime;
		for (const [index, flake] of flakes.entries()) {
			const item = items[index];
			if (!item) {
				continue;
			}
			const y = (((flake.y - time * FALL_SPEED) % height) + height) % height;
			item.position[0] = flake.x + Math.sin(time * 0.7 + flake.drift) * 0.25;
			item.position[1] = y;
		}
		writeInstances(mesh, items);
	});
	return (
		<instancedMesh
			args={[undefined, undefined, items.length]}
			ref={(mesh) => {
				ref.current = mesh;
				if (mesh) {
					writeInstances(mesh, items);
				}
			}}
		>
			<sphereGeometry args={[1, 6, 4]} />
			<meshBasicMaterial color={color} toneMapped={false} />
		</instancedMesh>
	);
}

/** What each agent's villager is doing, from what its conversations need. */
function agentPose(
	doors: readonly SeasonDoor[],
	agentId: string
): VillagerPose {
	const own = doors.filter((door) =>
		door.agents.some((agent) => agent.id === agentId)
	);
	if (own.some((door) => door.status === "attention")) {
		return "failed";
	}
	if (own.some((door) => door.mark === "needs-you")) {
		return "needs-you";
	}
	if (own.some((door) => door.mark === "working")) {
		return "working";
	}
	return "idle";
}

/** ICU select keys for each pose (select keys stay identifier-shaped). */
const POSE_KEYS: Record<VillagerPose, string> = {
	failed: "failed",
	idle: "idle",
	"needs-you": "needsYou",
	waiting: "waiting",
	working: "working",
};

/** Each agent with a conversation on the board, by its first item. */
function seasonVillagers(
	season: Season,
	doors: readonly SeasonDoor[],
	places: ReadonlyMap<number, WorldDoor>,
	looks: ReadonlyMap<string, MemberLooks>,
	tl: LiteralMessage
): { first: Map<string, number>; specs: VillagerSpec[] } {
	const specs: VillagerSpec[] = [];
	const first = new Map<string, number>();
	const crowd = new Map<number, number>();
	// Each agent takes its first item no other villager stands by yet, so
	// the villagers spread out over the board.
	const agents = new Map<string, SeasonDoor["agents"][number]>();
	for (const door of doors) {
		for (const agent of door.agents) {
			agents.set(agent.id, agent);
		}
	}
	for (const agent of agents.values()) {
		const own = doors.filter((door) =>
			door.agents.some((item) => item.id === agent.id)
		);
		const door = own.find((item) => !crowd.has(item.number)) ?? own[0];
		if (!door) {
			continue;
		}
		const place = places.get(door.number);
		const base = looks.get(agent.id);
		if (!(place && base)) {
			continue;
		}
		first.set(agent.id, door.number);
		const shared = crowd.get(door.number) ?? 0;
		crowd.set(door.number, shared + 1);
		const [x, z] = villagerSpot(season, place, shared);
		const pose = agentPose(doors, agent.id);
		specs.push({
			id: agent.id,
			label: tl(
				"{name}, {pose, select, failed {a run failed} idle {idle} needsYou {needs you} waiting {waiting} other {working}}: open their conversation",
				{ name: agent.name, pose: POSE_KEYS[pose] }
			),
			looks: base,
			name: agent.name,
			pose,
			position: [x, 0, z],
		});
	}
	return { first, specs };
}

/** What each villager carries: a pumpkin, a wreath, a lantern on a stick. */
function carriedParts(season: Season, villagers: readonly VillagerSpec[]) {
	const items: InstanceSpec[] = [];
	const sticks: InstanceSpec[] = [];
	for (const villager of villagers) {
		const [x, , z] = villager.position;
		// In the right hand, toward the camera.
		const hand: Vec3 = [x + 0.3, 0.55, z + 0.18];
		if (season === "halloween") {
			items.push({
				color: SEASON_3D.halloween.pumpkin,
				position: hand,
				scale: [0.17, 0.14, 0.17],
			});
		} else if (season === "lunar-new-year") {
			sticks.push({
				color: SEASON_3D["lunar-new-year"].pole,
				position: [hand[0], hand[1] + 0.28, hand[2]],
				rotation: [0, 0, -0.35],
				scale: [0.015, 0.6, 0.015],
			});
			items.push({
				color: SEASON_3D["lunar-new-year"].lantern,
				position: [hand[0] + 0.12, hand[1] + 0.42, hand[2]],
				scale: [0.13, 0.11, 0.13],
			});
		} else {
			items.push({
				color: SEASON_3D.advent.needles,
				position: hand,
				rotation: [0, Math.PI / 4, 0],
				scale: [0.17, 0.17, 0.06],
			});
		}
	}
	return { items, sticks };
}

/** The act layer's cast and props, when the snapshot carries acts. */
export interface SeasonActors {
	/** Each agent's focus door: its plate opens that door. */
	doorOf: ReadonlyMap<string, number>;
	iconOnly: boolean;
	paths: LifePaths;
	props: ReactNode;
	villagers: readonly VillagerSpec[];
}

export function SeasonDiorama({
	activeNumber,
	actors,
	giftNumber,
	giftId,
	labelOf,
	looks,
	onActivate,
	onKeyDown,
	season,
	today,
	...scene
}: SeasonSceneProps & {
	activeNumber: number | null;
	giftId: string;
	giftNumber: number | null;
	labelOf: (door: SeasonDoor) => string;
	looks: ReadonlyMap<string, MemberLooks>;
	onActivate: (number: number, element: HTMLButtonElement) => void;
	onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
	season: Season;
	today: number | null;
	/** The act layer (absent: today's poses and first doors). */
	actors?: SeasonActors;
}) {
	const tl = useLiteralMessages();
	const places = useMemo(
		() => new Map(scene.world.doors.map((door) => [door.number, door])),
		[scene.world]
	);
	const villagers = useMemo(
		() =>
			actors
				? { first: new Map(actors.doorOf), specs: [...actors.villagers] }
				: seasonVillagers(season, scene.doors, places, looks, tl),
		[actors, looks, places, scene.doors, season, tl]
	);
	// Act villagers walk, so the seasonal items stay with the still cast.
	const carried = useMemo(
		() =>
			actors
				? { items: [], sticks: [] }
				: carriedParts(season, villagers.specs),
		[actors, season, villagers]
	);
	// A villager's plate opens its first conversation, like that item's own
	// (with acts, its focus thread's door).
	const openFirst = (agentId: string) => {
		const number = villagers.first.get(agentId);
		const element =
			number === undefined
				? null
				: globalThis.document?.querySelector<HTMLButtonElement>(
						`[data-door="${number}"]`
					);
		if (number !== undefined && element) {
			onActivate(number, element);
		}
	};
	let body = <AdventSquare {...scene} />;
	if (season === "halloween") {
		body = <PumpkinPatch {...scene} />;
	} else if (season === "lunar-new-year") {
		body = <LanternStreet {...scene} />;
	}
	return (
		<group>
			{body}
			<Villagers
				iconOnly={actors?.iconOnly}
				onSelect={openFirst}
				paths={actors?.paths}
				reducedMotion={scene.reducedMotion}
				villagers={villagers.specs}
			/>
			{actors?.props}
			<InstancedParts castShadow items={carried.items}>
				{season === "advent" ? (
					<torusGeometry args={[1, 0.38, 8, 18]} />
				) : (
					<sphereGeometry args={[1, 12, 10]} />
				)}
				<ToonMaterial rim={0.2} />
			</InstancedParts>
			<InstancedParts items={carried.sticks}>
				<cylinderGeometry args={[1, 1, 1, 6]} />
				<ToonMaterial />
			</InstancedParts>
			{scene.doors.map((door) => {
				const place: WorldDoor | undefined = places.get(door.number);
				// The advent house keeps its facade clear: empty doors carry no
				// badge (Add a door is in the HUD); with acts no board shows
				// its empty places' badges, so the cast's plates read.
				if (
					!place ||
					((season === "advent" || actors) && door.thread === null)
				) {
					return null;
				}
				return (
					<DoorPlate
						active={activeNumber === door.number}
						at={place.plate}
						door={door}
						giftId={giftNumber === door.number ? giftId : undefined}
						key={door.number}
						label={labelOf(door)}
						numbered={season !== "advent"}
						onActivate={onActivate}
						onKeyDown={onKeyDown}
						today={today === door.number}
					/>
				);
			})}
		</group>
	);
}
