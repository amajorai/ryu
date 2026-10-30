/* eslint-disable react/no-unknown-property */

import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { Plus } from "lucide-react";
import { useMemo } from "react";
import { FlowerClusters } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland, MeshGeometry } from "./game3d-ground.tsx";
import { InstancedParts } from "./game3d-instances.tsx";
import type { IslandShape } from "./game3d-island.ts";
import { CurvedBasicMaterial, ToonMaterial } from "./game3d-materials.tsx";
import { ADDITIVE_BLENDING } from "./game3d-math.ts";
import type { Scene3dTheme } from "./game3d-palette.ts";
import { Bushes, PROP_INK, TreeGrove } from "./game3d-props.tsx";
import { IsoMarker } from "./game3d-stage.tsx";
import type { RenderQuality } from "./game3d-toon.ts";
import {
	type MemberLooks,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";
import { PathActProps, type PathActScene } from "./path-acts.tsx";
import {
	ACT_STONE_LIFT,
	crowdedSigns,
	Exclaim,
	plateLift,
	REVEAL_TITLE,
	stoneMark,
} from "./path-diorama-marks.tsx";
import {
	MASCOT_SCALE,
	needsYou,
	PAD_HEIGHT,
	POSE,
	padParts,
	scenery,
	signParts,
	stairParts,
	summitParts,
	TRAIL_HALF_WIDTH,
	terraceParts,
	trailRibbon,
} from "./path-diorama-parts.ts";
import type { PathUnit } from "./path-model.ts";
import { PATH_3D } from "./path-palette.ts";
import { stopAction, stopMeta, stopTitle } from "./path-stop.tsx";
import { type PathWorld, trailDistance } from "./path-world.ts";

/**
 * The Path diorama (see path-world.ts for the layout): a terraced hill on
 * an island with a narrow dirt trail winding up it in switchbacks, stairs
 * where it climbs onto the next terrace, and a chunky stepping-stone pad
 * per conversation whose state shows on the pad itself: a golden glow and
 * a check flag once done, a beacon (and the villager mascot) on the stop
 * to do next, a bouncing "!" where you are needed, a grey mossy stone
 * while it waits. A chunky wooden signpost starts each unit and a summit
 * flag crowns the hill. Every pad and signpost carries a kit plate that is
 * its control.
 */

export interface PathDioramaProps {
	activeThreadId: string | null;
	/** The act layer: hikers act out their acts; the stops carry its props. */
	actScene?: PathActScene | null;
	looks: ReadonlyMap<string, MemberLooks>;
	night: boolean;
	onOpen: (threadId: string) => void;
	onStart: (unit: PathUnit) => void;
	quality: RenderQuality;
	reducedMotion: boolean;
	shape: IslandShape;
	theme: Scene3dTheme;
	world: PathWorld;
}

/**
 * The arrow keys' order for unit signs: each sign just before its unit's
 * first stop, so the keys walk the trail sign, stops, next sign.
 */
function trailOrder(world: PathWorld): Map<string, number> {
	const order = new Map<string, number>();
	for (const stone of world.stones) {
		const first = order.get(stone.unit.id);
		if (first === undefined || stone.index - 0.5 < first) {
			order.set(stone.unit.id, stone.index - 0.5);
		}
	}
	for (const sign of world.signs) {
		if (!order.has(sign.unit.id)) {
			order.set(sign.unit.id, world.stones.length + order.size);
		}
	}
	return order;
}

export function PathDiorama({
	actScene = null,
	activeThreadId,
	looks,
	night,
	onOpen,
	onStart,
	quality,
	reducedMotion,
	shape,
	theme,
	world,
}: PathDioramaProps) {
	const tl = useLiteralMessages();
	const ribbon = useMemo(
		() => trailRibbon(world, night, theme),
		[night, theme, world]
	);
	const avoid = useMemo(() => {
		const firstFront = world.terraces[0]?.front ?? Number.NEGATIVE_INFINITY;
		return (x: number, z: number) =>
			trailDistance(world.trail, x, z) < TRAIL_HALF_WIDTH + 0.12 ||
			(z < firstFront + 0.2 &&
				x > world.width.minX - 0.2 &&
				x < world.width.maxX + 0.2) ||
			world.signs.some(
				(sign) => Math.hypot(sign.at[0] - x, sign.at[1] - z) < 0.3
			);
	}, [world]);
	const terraces = useMemo(() => terraceParts(world, theme), [theme, world]);
	const stairs = useMemo(() => stairParts(world), [world]);
	const pads = useMemo(() => padParts(world, night), [night, world]);
	const signs = useMemo(() => signParts(world), [world]);
	const summit = useMemo(() => summitParts(world), [world]);
	const green = useMemo(() => scenery(world, shape), [shape, world]);
	const mascot = world.mascot;
	const villagers = useMemo<VillagerSpec[]>(() => {
		const agent = mascot?.stone.stop.agents[0];
		const base = agent ? looks.get(agent.id) : undefined;
		if (!(mascot && agent && base)) {
			return [];
		}
		return [
			{
				id: mascot.stone.stop.thread.id,
				label: `${agent.name}: ${stopAction(mascot.stone.stop)} ${stopTitle(mascot.stone.stop)}`,
				looks: base,
				name: agent.name,
				pose: POSE[mascot.stone.stop.state],
				position: [mascot.at[0], mascot.stone.y + PAD_HEIGHT, mascot.at[1]],
				scale: MASCOT_SCALE,
			},
		];
	}, [looks, mascot]);
	const beacon = world.stones.find((stone) => stone.stop.state === "current");
	const crowded = useMemo(() => crowdedSigns(world), [world]);
	const signOrder = useMemo(() => trailOrder(world), [world]);
	return (
		<group>
			<IsoIsland shape={shape} theme={theme} />
			<IslandGrass
				avoid={avoid}
				quality={quality}
				reducedMotion={reducedMotion}
				shape={shape}
				theme={theme}
			/>
			{/* The terraced hill. */}
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={theme.cliff}
				items={terraces.bodies}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={terraces.tops} receiveShadow>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<TreeGrove theme={theme} trees={green.trees} />
			<Bushes bushes={green.bushes} theme={theme} />
			<FlowerClusters patches={green.flowers} />
			{/* The trail and its stairs. */}
			<mesh receiveShadow>
				<MeshGeometry data={ribbon} />
				<ToonMaterial polygonOffset polygonOffsetFactor={-2} vertexColors />
			</mesh>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={PATH_3D.stoneSide}
				items={stairs}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			{/* The pads, by state. */}
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={PATH_3D.stoneSide}
				items={pads.bodies}
				receiveShadow
			>
				<cylinderGeometry args={[1, 1.08, 1, 9]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={pads.tops} receiveShadow>
				<cylinderGeometry args={[1, 1, 1, 24]} />
				<ToonMaterial rim={0.2} />
			</InstancedParts>
			<InstancedParts items={pads.glows}>
				<cylinderGeometry args={[1, 1, 1, 24]} />
				<meshBasicMaterial toneMapped={false} />
			</InstancedParts>
			<InstancedParts items={pads.moss}>
				<sphereGeometry args={[1, 10, 8]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow items={pads.poles}>
				<cylinderGeometry args={[1, 1, 1, 6]} />
				<ToonMaterial color={PATH_3D.flagPole} />
			</InstancedParts>
			<InstancedParts castShadow items={pads.flags}>
				<boxGeometry args={[1, 1, 1]} />
				<meshBasicMaterial toneMapped={false} />
			</InstancedParts>
			{beacon ? (
				<mesh
					position={[beacon.at[0], beacon.y + PAD_HEIGHT + 1.6, beacon.at[1]]}
				>
					<cylinderGeometry args={[0.42, 0.62, 3.2, 24, 1, true]} />
					<CurvedBasicMaterial
						blending={ADDITIVE_BLENDING}
						color={PATH_3D.current}
						depthWrite={false}
						opacity={0.2}
						toneMapped={false}
						transparent
					/>
				</mesh>
			) : null}
			{world.stones
				.filter((stone) => needsYou(stone.stop.state))
				.map((stone) => (
					<Exclaim
						at={[stone.at[0], stone.y + PAD_HEIGHT + 0.35, stone.at[1]]}
						key={stone.stop.thread.id}
						reducedMotion={reducedMotion}
					/>
				))}
			{/* Signposts and the summit. */}
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={PATH_3D.signPost}
				items={signs.posts}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial planks />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={PATH_3D.signPost}
				items={signs.boards}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial planks />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={PATH_3D.stoneSide}
				items={summit.cairn}
				receiveShadow
			>
				<sphereGeometry args={[1, 10, 8]} />
				<ToonMaterial color={PATH_3D.stone} />
			</InstancedParts>
			<InstancedParts castShadow items={summit.pole}>
				<cylinderGeometry args={[1, 1, 1, 8]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={PATH_3D.flag}
				items={summit.cloth}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			{actScene ? (
				<>
					{/* With acts each agent's hiker plate is its one target. */}
					<Villagers
						iconOnly={actScene.handlers.iconOnly}
						paths={actScene.paths}
						reducedMotion={reducedMotion}
						villagers={actScene.villagers}
					/>
					<PathActProps
						acts={actScene.acts}
						handlers={actScene.handlers}
						offStage={actScene.offStage}
						onStage={actScene.onStage}
						owners={actScene.owners}
						slots={actScene.slots}
						stones={actScene.stones}
						world={world}
					/>
				</>
			) : (
				// Decorative: the stone's own plate is the control.
				<Villagers
					plates={false}
					reducedMotion={reducedMotion}
					villagers={villagers}
				/>
			)}
			{/* With acts the unit signs step aside (the HUD's New thread starts
			    one): the stops' props and the hikers' plates need the room. */}
			{(actScene ? [] : world.signs).map((sign) => (
				<IsoMarker
					at={[sign.at[0], sign.y + 1.06, sign.at[1]]}
					className={cn("h-8 text-[14px]", REVEAL_TITLE)}
					key={sign.unit.id}
					label={tl("Unit {index}, {title}: start a new thread here", {
						index: sign.unit.index,
						title: sign.unit.title,
					})}
					onSelect={() => onStart(sign.unit)}
					order={signOrder.get(sign.unit.id)}
				>
					<span className="text-(--gk-ink-muted) tabular-nums">
						{sign.unit.index}
					</span>
					<span
						className={
							actScene || crowded.has(sign.unit.id) ? "hidden" : "inline"
						}
						data-plate-title=""
					>
						{sign.unit.title}
					</span>
					<Plus
						aria-hidden="true"
						className="size-4 text-(--gk-ink-muted)"
						strokeWidth={3}
					/>
				</IsoMarker>
			))}
			{/* Later plates draw over earlier ones: the pinned stops come last. */}
			{[...world.stones]
				.sort(
					(a, b) => Number(stoneMark(a).pinned) - Number(stoneMark(b).pinned)
				)
				.map((stone) => {
					const mark = stoneMark(stone);
					const title = stopTitle(stone.stop);
					const current = stone.stop.state === "current";
					const action = current ? `${stopAction(stone.stop)}: ` : "";
					// With acts no mascot stands on the stone: its mark sits low, under
					// the hikers' plates and alarms.
					const lift = actScene ? ACT_STONE_LIFT : plateLift(stone);
					return (
						<IsoMarker
							at={[stone.at[0], stone.y + lift, stone.at[1]]}
							className={cn(mark.className, REVEAL_TITLE)}
							key={stone.stop.thread.id}
							label={`${action}${title}. ${stopMeta(stone.stop)}.`}
							onSelect={() => onOpen(stone.stop.thread.id)}
							order={stone.index}
							pressed={stone.stop.thread.id === activeThreadId}
						>
							{mark.body}
							<span
								// With acts the hikers and their props carry the words:
								// the stones keep only their marks.
								className={cn(
									"max-w-40 truncate",
									mark.pinned && !actScene ? "inline" : "hidden"
								)}
								data-plate-title=""
							>
								{current ? `${stopAction(stone.stop)}: ${title}` : title}
							</span>
						</IsoMarker>
					);
				})}
		</group>
	);
}
