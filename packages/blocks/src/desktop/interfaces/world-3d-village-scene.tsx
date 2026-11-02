/* eslint-disable react/no-unknown-property */
import type { ThreadStatus, World3dParams } from "@ryuhq/protocol/interfaces";
import { useCallback, useMemo, useRef } from "react";
import type { Group } from "three";
import type { LifeBody } from "./game3d-life.tsx";
import {
	type AgentSwatch,
	type Scene3dTheme,
	sunDirection,
	swatchOf,
	type Vec3,
	villagerLooks,
} from "./game3d-palette.ts";
import { Bloom } from "./game3d-post.tsx";
import {
	Clouds,
	Glimmers,
	SkyDome,
	skyColors,
	useGlowCanvas,
} from "./game3d-sky.tsx";
import { SceneLights } from "./game3d-stage.tsx";
import { QUALITY, type RenderQuality, setLook } from "./game3d-toon.ts";
import type { useWorldController } from "./use-world-controller.ts";
import {
	WorldActStage,
	type WorldActView,
	WorldHelpers,
	worldActorAt,
	worldCarry,
	worldYouSpot,
} from "./world-3d-acts.tsx";
import {
	chooseFocusSide,
	conversationSpot,
	houseBoxes,
} from "./world-3d-focus.ts";
import { Flowers, Grass } from "./world-3d-grass.tsx";
import { Houses } from "./world-3d-houses.tsx";
import { AgentLabel, StationSight } from "./world-3d-plate.tsx";
import {
	type CameraFocus,
	FollowCamera,
	fogRange,
	OccluderFade,
	type ViewShift,
} from "./world-3d-scene.tsx";
import type { SpreadVillage } from "./world-3d-spread.ts";
import { Island, Trees, treeObstacles } from "./world-3d-terrain.tsx";
import { tileToWorld } from "./world-3d-theme.ts";
import {
	actedPlate,
	bodyLanguage,
	CHARACTER_LIFT,
	useFocusClearing,
	villageFrame,
} from "./world-3d-village-helpers.ts";
import {
	AgentCrowd,
	type CrowdMember,
	NearRing,
	PlayerCharacter,
	WorkSparkles,
} from "./world-3d-villagers.tsx";

export function VillageScene({
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
