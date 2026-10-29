/* eslint-disable react/no-unknown-property */
import { useFrame } from "@react-three/fiber";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgentAct,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ScrollText, Sparkles } from "lucide-react";
import { useMemo, useRef } from "react";
import type { Group } from "three";
import { FlowerClusters, type FlowerPatch } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, onIsland } from "./game3d-island.ts";
import type { Rgb } from "./game3d-lawn.ts";
import { CurvedBasicMaterial, ToonMaterial } from "./game3d-materials.tsx";
import { ADDITIVE_BLENDING, jitter } from "./game3d-math.ts";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import {
	Benches,
	Bushes,
	LampPosts,
	type PlacedBush,
	type PlacedProp,
	type PlantedTree,
	PROP_INK,
	TreeGrove,
} from "./game3d-props.tsx";
import { IsoLabel, IsoMarker } from "./game3d-stage.tsx";
import { linearRgb, type RenderQuality } from "./game3d-toon.ts";
import {
	FACE_CAMERA,
	type MemberLooks,
	type VillagerPose,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";
import { compactAge } from "./interface-renderer.ts";
import {
	LobbyActProps,
	type LobbyActView,
	lobbyMember,
	lobbyPaths,
	lobbyYouSpot,
} from "./lobby-acts.tsx";
import {
	type LobbyMember,
	SQUAD_STATE_DESCRIPTIONS,
	type SquadState,
	threadTitle,
} from "./lobby-model.ts";
import { LOBBY_3D } from "./lobby-palette.ts";
import { STATUS_DOT } from "./lobby-parts.tsx";
import {
	type LobbyWorld,
	PLAZA_RADIUS,
	PODIUM_HEIGHT,
	PODIUM_RADIUS,
	RECENT_MATCHES,
} from "./lobby-world.ts";

/**
 * The Lobby diorama (see lobby-world.ts for the layout): a paved plaza on
 * an island, the squad on a lit round podium with a level plaque at each
 * member's feet, the quest board with its pinned notes, the glowing play
 * portal and the recent-matches board. Every interactive object carries a
 * kit plate in the scene that is its control.
 */

/** The squad stands a head taller than ordinary villagers, to read at a glance. */
const VILLAGER_SCALE = 1.3;

/** Toward the camera on the ground, as a unit vector. */
const TOWARD: [number, number] = [Math.SQRT1_2, Math.SQRT1_2];
/** Height of one recent match's row on the board. */
const MATCH_ROW = 0.7;
/** Where the match board's first row sits. */
const MATCH_TOP = 0.55 + MATCH_ROW * RECENT_MATCHES + 0.5 - 0.6;

const POSE: Record<SquadState, VillagerPose> = {
	downed: "failed",
	"in-match": "working",
	"needs-you": "needs-you",
	ready: "idle",
	waiting: "waiting",
};

/** A box part of a board standing at `at`, turned to face the camera. */
function boardBox(
	at: [number, number],
	local: Vec3,
	size: Vec3,
	color?: string
): InstanceSpec {
	// Local x runs along screen right; local z toward the camera.
	const across: [number, number] = [Math.SQRT1_2, -Math.SQRT1_2];
	return {
		color,
		position: [
			at[0] + across[0] * local[0] + TOWARD[0] * local[2],
			local[1],
			at[1] + across[1] * local[0] + TOWARD[1] * local[2],
		],
		rotation: [0, FACE_CAMERA, 0],
		scale: size,
	};
}

/** The quest board and the matches board: posts, frames, cork and notes. */
function boardParts(
	world: LobbyWorld,
	/** A phone with the act layer has no room for the matches board. */
	withMatches = true
) {
	const posts: InstanceSpec[] = [];
	const frames: InstanceSpec[] = [];
	const corks: InstanceSpec[] = [];
	const notes: InstanceSpec[] = [];
	const boards = [
		{ at: world.questBoard, height: 1.25, notes: 5, width: 2 },
		{
			at: world.matches.at,
			height: MATCH_ROW * RECENT_MATCHES + 0.5,
			notes: 0,
			width: 3,
		},
	].slice(0, withMatches ? 2 : 1);
	for (const [index, board] of boards.entries()) {
		const half = board.width / 2;
		const centre = 0.55 + board.height / 2;
		for (const side of [-1, 1]) {
			posts.push(
				boardBox(
					board.at,
					[side * (half - 0.08), (centre + board.height / 2 + 0.1) / 2, -0.04],
					[0.12, centre + board.height / 2 + 0.1, 0.12]
				)
			);
		}
		frames.push(
			boardBox(
				board.at,
				[0, centre, 0],
				[board.width, board.height + 0.14, 0.1],
				LOBBY_3D.boardFrame
			)
		);
		corks.push(
			boardBox(
				board.at,
				[0, centre, 0.03],
				[board.width - 0.2, board.height - 0.08, 0.08],
				LOBBY_3D.boardCork
			)
		);
		for (let note = 0; note < board.notes; note++) {
			const column = note % 3;
			const row = Math.floor(note / 3);
			notes.push(
				boardBox(
					board.at,
					[
						(column - 1) * 0.55 + (jitter(note, index, 3) - 0.5) * 0.12,
						centre + 0.25 - row * 0.5,
						0.08,
					],
					[0.42, 0.34, 0.02],
					LOBBY_3D.notes[note % LOBBY_3D.notes.length]
				)
			);
		}
	}
	return { corks, frames, notes, posts };
}

/** Trees round the island's rim, shrubs and flowers, clear of the plaza. */
function scenery(world: LobbyWorld, shape: IslandShape) {
	const trees: PlantedTree[] = [];
	const bushes: PlacedBush[] = [];
	const flowers: FlowerPatch[] = [];
	const columns = Math.ceil(shape.halfWidth);
	const rows = Math.ceil(shape.halfDepth);
	const clear = [world.questBoard, world.portal, world.matches.at];
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const hash = jitter(x, y, 3);
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.5;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.5;
			const radius = Math.hypot(fx, fz);
			if (!onIsland(shape, fx, fz, 0.6) || radius < PLAZA_RADIUS + 0.4) {
				continue;
			}
			if (clear.some(([cx, cz]) => Math.hypot(cx - fx, cz - fz) < 2)) {
				continue;
			}
			// Woods at the back; the front corner (toward the camera) stays lawn.
			const front = fx + fz > 2;
			const woods = front
				? radius > PLAZA_RADIUS + 1.8 && hash < 0.3
				: radius > PLAZA_RADIUS + 0.9 && hash < 0.72;
			if (woods) {
				let kind: PlantedTree["kind"] = "fruit";
				if (hash < 0.26) {
					kind = "cedar";
				} else if (hash > 0.6) {
					kind = "blossom";
				}
				trees.push({
					at: [fx, 0, fz],
					kind,
					scale: 0.8 + jitter(x, y, 9) * 0.35,
					seed: Math.round(hash * 1000),
				});
			} else if (hash > (front ? 0.78 : 0.84)) {
				bushes.push({ at: [fx, 0, fz], scale: 0.8, seed: x * 31 + y });
			} else if (hash > (front ? 0.48 : 0.62)) {
				flowers.push({ at: [fx, 0, fz], x, y });
			}
		}
	}
	return { bushes, flowers, trees };
}

/** Lamps and benches round the plaza's edge, between the landmarks. */
function furniture() {
	const lamps: Vec3[] = [];
	for (let index = 0; index < 8; index++) {
		const angle = (index / 8) * Math.PI * 2 + Math.PI / 8;
		lamps.push([
			Math.cos(angle) * (PLAZA_RADIUS - 0.5),
			0,
			Math.sin(angle) * (PLAZA_RADIUS - 0.5),
		]);
	}
	const benches: PlacedProp[] = [
		{ at: [4.3, 0, 0.9], yaw: -Math.PI / 2 },
		{ at: [0.9, 0, 4.3], yaw: 0 },
		{ at: [3.4, 0, -3], yaw: -Math.PI * 0.75 },
	];
	return { benches, lamps };
}

/** The play portal: a stone base, a gold ring and a glowing gate. */
function Portal({
	at,
	night,
	reducedMotion,
}: {
	at: [number, number];
	night: boolean;
	reducedMotion: boolean;
}) {
	const sparks = useRef<Group>(null);
	useFrame(({ clock }) => {
		const group = sparks.current;
		if (!group || reducedMotion) {
			return;
		}
		group.rotation.z = clock.elapsedTime * 0.6;
	});
	const sparkles = useMemo<InstanceSpec[]>(
		() =>
			Array.from({ length: 8 }, (_, index) => {
				const angle = (index / 8) * Math.PI * 2;
				return {
					color: LOBBY_3D.portalCore,
					position: [Math.cos(angle) * 0.86, Math.sin(angle) * 0.86, 0.06],
					scale: index % 2 === 0 ? 0.07 : 0.045,
				};
			}),
		[]
	);
	return (
		<group position={[at[0], 0, at[1]]} rotation={[0, FACE_CAMERA, 0]}>
			<mesh castShadow position={[0, 0.14, 0]} receiveShadow>
				<cylinderGeometry args={[1.2, 1.32, 0.28, 32]} />
				<ToonMaterial color={LOBBY_3D.portalBase} />
			</mesh>
			<mesh castShadow position={[0, 0.34, 0]} receiveShadow>
				<cylinderGeometry args={[0.9, 1, 0.14, 32]} />
				<ToonMaterial color={LOBBY_3D.podiumStep} />
			</mesh>
			<group position={[0, 1.55, 0]}>
				<mesh castShadow>
					<torusGeometry args={[1.08, 0.13, 14, 48]} />
					<ToonMaterial color={LOBBY_3D.portalRing} rim={0.3} />
				</mesh>
				<mesh>
					<circleGeometry args={[0.98, 40]} />
					<CurvedBasicMaterial
						color={night ? LOBBY_3D.portalGlowNight : LOBBY_3D.portalGlow}
						opacity={0.9}
						toneMapped={false}
						transparent
					/>
				</mesh>
				<mesh position={[0, 0, 0.02]}>
					<circleGeometry args={[0.5, 32]} />
					<CurvedBasicMaterial
						blending={ADDITIVE_BLENDING}
						color={LOBBY_3D.portalCore}
						depthWrite={false}
						opacity={0.55}
						toneMapped={false}
						transparent
					/>
				</mesh>
				<group ref={sparks}>
					<InstancedParts items={sparkles}>
						<sphereGeometry args={[1, 10, 8]} />
						<meshBasicMaterial toneMapped={false} />
					</InstancedParts>
				</group>
			</group>
		</group>
	);
}

/** The podium: a wide step, the drum, a gold rim and a lit top. */
function Podium({ night }: { night: boolean }) {
	return (
		<group>
			<mesh castShadow position={[0, 0.08, 0]} receiveShadow>
				<cylinderGeometry
					args={[PODIUM_RADIUS + 0.4, PODIUM_RADIUS + 0.5, 0.16, 56]}
				/>
				<ToonMaterial color={LOBBY_3D.podiumStep} />
			</mesh>
			<mesh castShadow position={[0, PODIUM_HEIGHT / 2, 0]} receiveShadow>
				<cylinderGeometry
					args={[PODIUM_RADIUS, PODIUM_RADIUS + 0.06, PODIUM_HEIGHT, 56]}
				/>
				<ToonMaterial
					color={night ? LOBBY_3D.podiumNight : LOBBY_3D.podium}
					rim={0.2}
				/>
			</mesh>
			<mesh position={[0, PODIUM_HEIGHT + 0.006, 0]} receiveShadow>
				<cylinderGeometry
					args={[PODIUM_RADIUS - 0.12, PODIUM_RADIUS - 0.12, 0.02, 56]}
				/>
				<ToonMaterial
					color={night ? LOBBY_3D.podiumTopNight : LOBBY_3D.podiumTop}
				/>
			</mesh>
			<mesh position={[0, PODIUM_HEIGHT, 0]} rotation={[-Math.PI / 2, 0, 0]}>
				<torusGeometry args={[PODIUM_RADIUS - 0.06, 0.06, 8, 72]} />
				<ToonMaterial color={LOBBY_3D.podiumRim} rim={0.3} />
			</mesh>
		</group>
	);
}

/** A lit disc on the podium under the selected member (they stay fully opaque). */
function SelectedGlow({ at }: { at: [number, number] }) {
	return (
		<mesh
			position={[at[0], PODIUM_HEIGHT + 0.02, at[1]]}
			rotation={[-Math.PI / 2, 0, 0]}
		>
			<circleGeometry args={[0.62, 40]} />
			<CurvedBasicMaterial
				blending={ADDITIVE_BLENDING}
				color={LOBBY_3D.spotlight}
				depthWrite={false}
				opacity={0.45}
				toneMapped={false}
				transparent
			/>
		</mesh>
	);
}

export interface LobbyDioramaProps {
	activeThreadId: string | null;
	/** The act layer (a snapshot with `asks`); without it, today's plaza. */
	acts?: { onStage: readonly InterfaceAgentAct[]; view: LobbyActView } | null;
	looks: ReadonlyMap<string, MemberLooks>;
	members: readonly LobbyMember[];
	night: boolean;
	now: number;
	onInvite: () => void;
	onOpen: (threadId: string) => void;
	onSelect: (agentId: string) => void;
	onShowQuests: () => void;
	onStart: (agentId: string) => void;
	quality: RenderQuality;
	ready: number;
	reducedMotion: boolean;
	selected: LobbyMember | undefined;
	shape: IslandShape;
	theme: Scene3dTheme;
	waiting: number;
	world: LobbyWorld;
}

export function LobbyDiorama({
	acts = null,
	activeThreadId,
	looks,
	members,
	night,
	now,
	onInvite,
	onOpen,
	onSelect,
	onShowQuests,
	onStart,
	quality,
	ready,
	reducedMotion,
	selected,
	shape,
	theme,
	waiting,
	world,
}: LobbyDioramaProps) {
	const paint = useMemo(() => {
		const paving = linearRgb(night ? LOBBY_3D.pavingNight : LOBBY_3D.paving);
		const alternate = linearRgb(
			night ? LOBBY_3D.pavingAltNight : LOBBY_3D.pavingAlt
		);
		const ring = linearRgb(
			night ? LOBBY_3D.pavingRingNight : LOBBY_3D.pavingRing
		);
		return (x: number, z: number): Rgb | null => {
			const radius = Math.hypot(x, z);
			if (radius > PLAZA_RADIUS) {
				return null;
			}
			const band = radius > PLAZA_RADIUS - 0.4 || Math.abs(radius - 4.6) < 0.16;
			if (band) {
				return ring;
			}
			// Flagstones: rings of slabs, alternating like a checkerboard.
			const course = Math.floor(radius / 1.15);
			const slab = Math.floor(
				((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * (8 + course * 6)
			);
			return (course + slab) % 2 === 0 ? paving : alternate;
		};
	}, [night]);
	const avoid = useMemo(
		() => (x: number, z: number) => Math.hypot(x, z) < PLAZA_RADIUS + 0.2,
		[]
	);
	const narrow = acts?.view.iconOnly ?? false;
	const bareBoards = acts !== null && narrow;
	const boards = useMemo(
		() => boardParts(world, !bareBoards),
		[bareBoards, world]
	);
	const green = useMemo(() => scenery(world, shape), [shape, world]);
	const props = useMemo(() => furniture(), []);
	const stations = useMemo(() => {
		const map = new Map<string, Vec3>();
		for (const spot of world.spots) {
			if (spot.member) {
				map.set(spot.member.agent.id, [spot.at[0], PODIUM_HEIGHT, spot.at[1]]);
			}
		}
		return map;
	}, [world]);
	const you = useMemo(() => lobbyYouSpot(narrow), [narrow]);
	const paths = useMemo(
		() =>
			acts
				? lobbyPaths(stations, PODIUM_HEIGHT, PODIUM_RADIUS, you.points)
				: undefined,
		[acts, stations, you]
	);
	const actOf = useMemo(
		() => new Map((acts?.onStage ?? []).map((act) => [act.agentId, act])),
		[acts?.onStage]
	);
	const actView = acts?.view ?? null;
	const villagers = useMemo<VillagerSpec[]>(() => {
		const out: VillagerSpec[] = [];
		for (const spot of world.spots) {
			const member = spot.member;
			const base = member ? looks.get(member.agent.id) : undefined;
			if (!(member && base)) {
				continue;
			}
			const act = actOf.get(member.agent.id);
			if (act && actView && paths) {
				const [squadMember, ...helpers] = lobbyMember({
					act,
					base: {
						id: member.agent.id,
						position: [spot.at[0], PODIUM_HEIGHT, spot.at[1]],
					},
					looks: base,
					paths,
					reduced: reducedMotion,
					view: actView,
				});
				if (squadMember) {
					out.push({ ...squadMember, scale: VILLAGER_SCALE }, ...helpers);
				}
				continue;
			}
			out.push({
				id: member.agent.id,
				label: `${member.agent.name}, ${SQUAD_STATE_DESCRIPTIONS[member.state]}, level ${member.level.level}`,
				looks: base,
				name: member.agent.name,
				pose: POSE[member.state],
				position: [spot.at[0], PODIUM_HEIGHT, spot.at[1]],
				scale: VILLAGER_SCALE,
			});
		}
		return out;
	}, [actOf, actView, looks, paths, reducedMotion, world]);
	const firstOpen = world.spots.findIndex((spot) => !spot.member);
	const openSlots = world.spots.filter((spot) => !spot.member).length;
	const selectedSpot = world.spots.find(
		(spot) => spot.member && spot.member.agent.id === selected?.agent.id
	);
	const lead = (agentId: string | undefined) =>
		members.find((member) => member.agent.id === agentId)?.agent;
	const matchAt = (row: number): Vec3 => [
		world.matches.at[0] + TOWARD[0] * 0.2,
		MATCH_TOP - row * MATCH_ROW,
		world.matches.at[1] + TOWARD[1] * 0.2,
	];
	return (
		<group>
			<IsoIsland paint={paint} shape={shape} theme={theme} />
			<IslandGrass
				avoid={avoid}
				quality={quality}
				reducedMotion={reducedMotion}
				shape={shape}
				theme={theme}
			/>
			<TreeGrove theme={theme} trees={green.trees} />
			<Bushes bushes={green.bushes} theme={theme} />
			<FlowerClusters patches={green.flowers} />
			<LampPosts lamps={props.lamps} night={night} />
			<Benches benches={props.benches} />
			<Podium night={night} />
			{selectedSpot ? <SelectedGlow at={selectedSpot.at} /> : null}
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={LOBBY_3D.boardPost}
				items={boards.posts}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={LOBBY_3D.boardPost} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={LOBBY_3D.boardFrame}
				items={boards.frames}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial planks />
			</InstancedParts>
			<InstancedParts items={boards.corks} receiveShadow>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={boards.notes}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<Portal at={world.portal} night={night} reducedMotion={reducedMotion} />
			{acts ? (
				<LobbyActProps
					onStage={acts.onStage}
					reduced={reducedMotion}
					stations={stations}
					view={acts.view}
					you={you}
				/>
			) : null}
			<Villagers
				iconOnly={acts?.view.iconOnly ?? false}
				onSelect={onSelect}
				paths={paths}
				reducedMotion={reducedMotion}
				selectedId={selected?.agent.id ?? null}
				villagers={villagers}
			/>
			{world.spots.map((spot, index) => {
				if (spot.member && acts) {
					// With acts the squad walks off its places, and the you-spot
					// plates need the room: the level plaques stay in the roster.
					return null;
				}
				if (!spot.member && acts && index > firstOpen) {
					// One open-slot marker is enough: side by side they overlap.
					return null;
				}
				return spot.member ? (
					<IsoLabel
						at={[
							spot.at[0] + TOWARD[0] * 1.15,
							PODIUM_HEIGHT * 0.5,
							spot.at[1] + TOWARD[1] * 1.15,
						]}
						key={spot.member.agent.id}
					>
						<span className="text-(--gk-ink-muted) text-[11px] uppercase">
							Lv
						</span>
						<span className="ps-1 tabular-nums">{spot.member.level.level}</span>
					</IsoLabel>
				) : (
					<IsoMarker
						at={[spot.at[0], PODIUM_HEIGHT + 0.5, spot.at[1]]}
						className="border-dashed text-(--gk-ink-muted)"
						// biome-ignore lint/suspicious/noArrayIndexKey: open places have no identity.
						key={`open-${index}`}
						label={
							acts && openSlots > 1
								? `${openSlots} open slots: add agents from the squad roster`
								: "Open slot: add an agent from the squad roster"
						}
						onSelect={onInvite}
					>
						{acts && openSlots > 1
							? `+ ${openSlots} open slots`
							: "+ Open slot"}
					</IsoMarker>
				);
			})}
			<IsoMarker
				at={[world.questBoard[0], 2.5, world.questBoard[1]]}
				label={`Daily quests, ${ready} ready to claim. Open the quest board.`}
				onSelect={onShowQuests}
			>
				<ScrollText aria-hidden="true" className="size-3.5" />
				Daily quests
				<span className="grid h-5 min-w-5 place-items-center rounded-full border-(--gk-edge) border-2 bg-(--gk-warn) px-1 text-(--gk-edge) text-[11px] tabular-nums">
					{ready}
				</span>
			</IsoMarker>
			{selected ? (
				<IsoMarker
					at={[world.portal[0], 3.15, world.portal[1]]}
					label={`Play portal: start a new thread with ${selected.agent.name}`}
					onSelect={() => onStart(selected.agent.id)}
				>
					<Sparkles aria-hidden="true" className="size-3.5" />
					Portal
				</IsoMarker>
			) : null}
			{/* With acts the board is plain shortcuts: what waits is the
			    queue's (and on a phone the board gives way to the queue). */}
			{acts && narrow ? null : (
				<IsoLabel at={matchAt(-1)}>
					Recent matches
					{acts ? null : (
						<span className="ps-1.5 text-(--gk-ink-muted) text-[12px]">
							{waiting} waiting
						</span>
					)}
				</IsoLabel>
			)}
			{acts && narrow ? null : world.matches.threads.length === 0 ? (
				<IsoLabel at={matchAt(1)}>
					<span className="text-(--gk-ink-muted)">No matches yet</span>
				</IsoLabel>
			) : null}
			{(acts && narrow ? [] : world.matches.threads).map((thread, row) => {
				const status = threadStatus(thread);
				const title = threadTitle(thread);
				const open = thread.id === activeThreadId;
				const agent = lead(thread.agentIds[0]);
				return (
					<IsoMarker
						at={matchAt(row)}
						className="font-sans font-semibold text-[12px]"
						key={thread.id}
						label={`${title}${agent ? ` with ${agent.name}` : ""}${acts ? "" : `, ${THREAD_STATUS_LABELS[status]}`}. ${open ? "Open now." : "Open thread."}`}
						onSelect={() => onOpen(thread.id)}
						pressed={open}
					>
						{acts ? null : (
							<span
								aria-hidden="true"
								className={cn(
									"size-2 shrink-0 rounded-full",
									STATUS_DOT[status]
								)}
							/>
						)}
						<span className="max-w-36 truncate">{title}</span>
						{acts ? null : (
							<span className="text-(--gk-ink-muted) tabular-nums">
								{compactAge(thread.updatedAt, now)}
							</span>
						)}
					</IsoMarker>
				);
			})}
		</group>
	);
}
