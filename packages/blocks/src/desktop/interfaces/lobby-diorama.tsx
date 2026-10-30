/* eslint-disable react/no-unknown-property */
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgentAct,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ScrollText, Sparkles } from "lucide-react";
import { useMemo } from "react";
import { FlowerClusters } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import { InstancedParts } from "./game3d-instances.tsx";
import type { IslandShape } from "./game3d-island.ts";
import type { Rgb } from "./game3d-lawn.ts";
import { ToonMaterial } from "./game3d-materials.tsx";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import {
	Benches,
	Bushes,
	LampPosts,
	PROP_INK,
	TreeGrove,
} from "./game3d-props.tsx";
import { IsoLabel, IsoMarker } from "./game3d-stage.tsx";
import { linearRgb, type RenderQuality } from "./game3d-toon.ts";
import {
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
import { Podium, Portal, SelectedGlow } from "./lobby-diorama-landmarks.tsx";
import {
	boardParts,
	furniture,
	MATCH_ROW,
	scenery,
	TOWARD,
} from "./lobby-diorama-scenery.ts";
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

/** Where the match board's first row sits. */
const MATCH_TOP = 0.55 + MATCH_ROW * RECENT_MATCHES + 0.5 - 0.6;

const POSE: Record<SquadState, VillagerPose> = {
	downed: "failed",
	"in-match": "working",
	"needs-you": "needs-you",
	ready: "idle",
	waiting: "waiting",
};

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
	const tl = useLiteralMessages();
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
								? tl(
										"{openSlots} open slots: add agents from the squad roster",
										{
											openSlots: String(openSlots),
										}
									)
								: "Open slot: add an agent from the squad roster"
						}
						onSelect={onInvite}
					>
						{acts && openSlots > 1
							? tl("+ {openSlots} open slots", { openSlots: String(openSlots) })
							: "+ Open slot"}
					</IsoMarker>
				);
			})}
			<IsoMarker
				at={[world.questBoard[0], 2.5, world.questBoard[1]]}
				label={tl(
					"Daily quests, {ready} ready to claim. Open the quest board.",
					{
						ready: String(ready),
					}
				)}
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
					label={tl("Play portal: start a new thread with {name}", {
						name: selected.agent.name,
					})}
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
							{tl("{waiting} waiting", { waiting: String(waiting) })}
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
