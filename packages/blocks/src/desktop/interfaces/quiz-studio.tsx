/* eslint-disable react/no-unknown-property */
import { useMemo } from "react";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import { InstancedParts } from "./game3d-instances.tsx";
import { CurvedBasicMaterial, ToonMaterial } from "./game3d-materials.tsx";
import { ADDITIVE_BLENDING, DOUBLE_SIDE } from "./game3d-math.ts";
import type { Vec3 } from "./game3d-palette.ts";
import { PROP_INK, TreeGrove } from "./game3d-props.tsx";
import { FACE_CAMERA, Villagers } from "./game3d-villager.tsx";
import {
	podiumWords,
	QuizActProps,
	quizPaths,
	quizYouSpot,
} from "./quiz-acts.tsx";
import { QUIZ_ROWS } from "./quiz-model.ts";
import { QUIZ_3D } from "./quiz-palette.ts";
import {
	HOST_ID,
	STAGE_HEIGHT,
	STAGE_RADIUS,
	STAGE_STRETCH,
	studioExtras,
} from "./quiz-studio-cast.ts";
import {
	boardCells,
	cellSize,
	cellWords,
	FACE,
	headerLines,
	Panel,
	panelCanvas,
	TileChip,
} from "./quiz-studio-panel.tsx";
import {
	ACT_SCREEN,
	marqueeBulbs,
	podiumParts,
	rigParts,
	rimTrees,
	scoreCanvas,
	seatParts,
} from "./quiz-studio-parts.ts";
import type { QuizStudioProps } from "./quiz-studio-props.ts";
import { useQuizStars } from "./quiz-studio-stars.ts";
import {
	categoryCentre,
	FLOOR_RADIUS,
	hostSpot,
	podiumSpots,
	TOWARD,
	WALL,
	wallPoint,
} from "./quiz-world.ts";

// biome-ignore lint/performance/noBarrelFile: keeps the studio's public import path stable after the split.
export { AUDIENCE_IDS, HOST_ID, studioExtras } from "./quiz-studio-cast.ts";
export type { QuizStudioProps } from "./quiz-studio-props.ts";

/**
 * The Quiz Show studio (see quiz-world.ts for the layout): the board as a
 * wall of bevelled, glowing tiles facing the camera, each painted with its
 * value (played ones dimmed, the ones that need you brightest) under lit
 * category headers, all inside a curved backdrop lined with marquee bulbs.
 * Clicking a tile picks it; a small status chip on each tile is its
 * keyboard control. The contestants stand as villagers behind chunky
 * podiums whose fronts carry lit score screens, the host at a lectern,
 * under lamps hung on the backdrop whose beams pool on a glossy floor, with the
 * audience in theatre rows along the front edge.
 */

const NO_HEADLINES: ReadonlyMap<string, string> = new Map();

export function QuizStudio({
	acts = null,
	audience = true,
	board,
	contestants,
	handlers,
	headlines = NO_HEADLINES,
	inPlayId,
	isRevealed,
	looks,
	night,
	onAsk,
	openId,
	quality,
	reducedMotion,
	shape,
	theme,
}: QuizStudioProps) {
	const [floorX, , floorZ] = wallPoint(0.9, 3.6, 0);
	const avoid = useMemo(
		() => (x: number, z: number) =>
			Math.hypot(x - floorX, z - floorZ) < FLOOR_RADIUS + 0.2,
		[floorX, floorZ]
	);
	const cells = useMemo(
		() => boardCells(board, isRevealed, inPlayId, openId),
		[board, inPlayId, isRevealed, openId]
	);
	// Each panel's face is painted once per state; keys keep them current.
	const faces = useMemo(
		() =>
			cells.map((cell) => {
				const words = cellWords(cell, board, headlines);
				const glow = cell.state === "lit" || cell.state === "open";
				return {
					canvas: panelCanvas(
						FACE[cell.state],
						words,
						cellSize(cell, words),
						glow
					),
					key: `${cell.column}:${cell.row}:${cell.state}:${words.join("")}`,
				};
			}),
		[board, cells, headlines]
	);
	const headers = useMemo(
		() =>
			board.columns.map((category, column) => ({
				canvas: panelCanvas(
					category ? QUIZ_3D.header : QUIZ_3D.tileOff,
					category ? headerLines(category.name) : [],
					34,
					false
				),
				key: `${column}:${category?.name ?? ""}`,
			})),
		[board]
	);
	const actWords = useMemo(
		() =>
			new Map(
				(acts?.onStage ?? []).map((act) => [act.agentId, podiumWords(act)])
			),
		[acts?.onStage]
	);
	const scores = useMemo(
		() =>
			contestants.map((contestant) => {
				const words =
					actWords.get(contestant.agent.id) ?? String(contestant.score);
				return {
					canvas: scoreCanvas(words, actWords.has(contestant.agent.id)),
					key: `${contestant.agent.id}:${words}`,
				};
			}),
		[actWords, contestants]
	);
	const podiums = useMemo(
		() => podiumParts(contestants, acts != null),
		[acts, contestants]
	);
	const rig = useMemo(() => rigParts(), []);
	const seats = useMemo(() => seatParts(), []);
	const trees = useMemo(() => rimTrees(shape), [shape]);
	const wallWidth = board.columns.length * WALL.column + 0.5;
	const wallTop = WALL.floor + QUIZ_ROWS * WALL.row + 0.7;
	const backdrop = { height: wallTop + 0.25, radius: 6.4 };
	const bulbs = useMemo(
		() => marqueeBulbs(backdrop.radius, backdrop.height),
		[backdrop.height, backdrop.radius]
	);
	const spots = useMemo(() => podiumSpots(), []);
	const stations = useMemo(() => {
		const map = new Map<string, Vec3>();
		for (const [index, contestant] of contestants.entries()) {
			const spot = spots[index];
			if (spot) {
				map.set(contestant.agent.id, [
					spot[0] - TOWARD[0] * 0.8,
					STAGE_HEIGHT,
					spot[1] - TOWARD[1] * 0.8,
				]);
			}
		}
		return map;
	}, [contestants, spots]);
	const narrow = acts?.view.iconOnly ?? false;
	const you = useMemo(() => quizYouSpot(narrow), [narrow]);
	const paths = useMemo(
		() => (acts ? quizPaths(stations, you.points) : undefined),
		[acts, stations, you]
	);
	const actOf = useMemo(
		() => new Map((acts?.onStage ?? []).map((act) => [act.agentId, act])),
		[acts?.onStage]
	);
	const actView = acts?.view ?? null;
	const stars = useQuizStars({
		actOf,
		actView,
		contestants,
		looks,
		paths,
		reducedMotion,
		spots,
		stations,
	});
	const [hostX, hostZ] = hostSpot();
	const extras = useMemo(
		() => studioExtras(looks, [hostX, hostZ], audience),
		[audience, hostX, hostZ, looks]
	);
	// With acts the host (you) wears a name plate: the queue's bubbles and
	// plates then keep clear of its head, as they do of any plate.
	const hostPlated = acts != null;
	const host = hostPlated ? extras.filter((extra) => extra.id === HOST_ID) : [];
	const unplated = hostPlated
		? extras.filter((extra) => extra.id !== HOST_ID)
		: extras;
	const stageAt = wallPoint(0.9, 4.1, 0);
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
			<TreeGrove theme={theme} trees={trees} />
			{/* The glossy floor, the stage on it and its gold ring. */}
			<mesh position={[floorX, 0.03, floorZ]} receiveShadow>
				<cylinderGeometry args={[FLOOR_RADIUS, FLOOR_RADIUS, 0.06, 64]} />
				<ToonMaterial
					color={night ? QUIZ_3D.floorNight : QUIZ_3D.floor}
					sheen={0.6}
				/>
			</mesh>
			<group
				position={[stageAt[0], 0, stageAt[2]]}
				rotation={[0, FACE_CAMERA, 0]}
			>
				<mesh
					castShadow
					position={[0, STAGE_HEIGHT / 2, 0]}
					receiveShadow
					scale={[STAGE_STRETCH, 1, 1]}
				>
					<cylinderGeometry
						args={[STAGE_RADIUS, STAGE_RADIUS + 0.1, STAGE_HEIGHT, 64]}
					/>
					<ToonMaterial color={QUIZ_3D.stage} rim={0.15} sheen={0.5} />
				</mesh>
				<mesh
					position={[0, STAGE_HEIGHT + 0.006, 0]}
					rotation={[-Math.PI / 2, 0, 0]}
					scale={[STAGE_STRETCH, 1, 1]}
				>
					<ringGeometry args={[STAGE_RADIUS - 0.45, STAGE_RADIUS - 0.3, 72]} />
					<meshBasicMaterial color={QUIZ_3D.ring} toneMapped={!night} />
				</mesh>
			</group>
			<InstancedParts items={rig.pools}>
				<circleGeometry args={[1, 32]} />
				<CurvedBasicMaterial
					blending={ADDITIVE_BLENDING}
					depthWrite={false}
					opacity={night ? 0.3 : 0.16}
					toneMapped={false}
					transparent
				/>
			</InstancedParts>
			{/* The curved backdrop with its marquee bulbs. */}
			<mesh position={wallPoint(0, 2, backdrop.height / 2)}>
				<cylinderGeometry
					args={[
						backdrop.radius,
						backdrop.radius,
						backdrop.height,
						48,
						1,
						true,
						FACE_CAMERA + Math.PI - 1.15,
						2.3,
					]}
				/>
				<ToonMaterial
					color={night ? QUIZ_3D.backdropNight : QUIZ_3D.backdrop}
					side={DOUBLE_SIDE}
				/>
			</mesh>
			<InstancedParts items={bulbs}>
				<sphereGeometry args={[1, 10, 8]} />
				<meshBasicMaterial toneMapped={false} />
			</InstancedParts>
			{/* The board wall: its bezel and rim, and every painted panel. */}
			<mesh
				castShadow
				position={wallPoint(0, -0.06, wallTop / 2 + 0.2)}
				receiveShadow
				rotation={[0, FACE_CAMERA, 0]}
			>
				<boxGeometry args={[wallWidth, wallTop + 0.2, 0.3]} />
				<ToonMaterial color={QUIZ_3D.bezel} />
			</mesh>
			<mesh
				position={wallPoint(0, 0.1, wallTop + 0.32)}
				rotation={[0, FACE_CAMERA, 0]}
			>
				<boxGeometry args={[wallWidth + 0.1, 0.08, 0.1]} />
				<meshBasicMaterial color={QUIZ_3D.rim} toneMapped={false} />
			</mesh>
			{cells.map((cell, index) => {
				const face = faces[index];
				const tile = cell.tile;
				return face ? (
					<Panel
						at={cell.at}
						canvas={face.canvas}
						height={WALL.cellHeight}
						key={face.key}
						onSelect={
							tile && cell.state !== "off"
								? () => handlers.onPick(tile.thread.id)
								: undefined
						}
						width={WALL.cellWidth}
					/>
				) : null;
			})}
			{headers.map((header, column) => (
				<Panel
					at={categoryCentre(column)}
					canvas={header.canvas}
					height={WALL.cellHeight + 0.1}
					key={header.key}
					width={WALL.cellWidth}
				/>
			))}
			{/* Podiums with their score screens, and the host's lectern. */}
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={QUIZ_3D.podium}
				items={podiums.bodies}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial rim={0.15} />
			</InstancedParts>
			<InstancedParts castShadow items={podiums.desks}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={podiums.lamps}>
				<boxGeometry args={[1, 1, 1]} />
				<meshBasicMaterial toneMapped={false} />
			</InstancedParts>
			{scores.map((score, index) => {
				const spot = spots[index];
				return spot ? (
					<Panel
						at={[
							spot[0] + TOWARD[0] * 0.4,
							STAGE_HEIGHT + 0.5,
							spot[1] + TOWARD[1] * 0.4,
						]}
						canvas={score.canvas}
						height={acts ? ACT_SCREEN.height : 0.46}
						key={score.key}
						width={acts ? ACT_SCREEN.width : 0.92}
					/>
				) : null;
			})}
			<mesh
				castShadow
				position={[hostX, STAGE_HEIGHT + 0.42, hostZ]}
				rotation={[0, FACE_CAMERA, 0]}
			>
				<boxGeometry args={[0.8, 0.84, 0.52]} />
				<ToonMaterial color={QUIZ_3D.lectern} rim={0.2} />
			</mesh>
			{/* The lighting rig. */}
			<InstancedParts castShadow items={rig.truss}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={rig.lamps}>
				<cylinderGeometry args={[0.7, 1, 1, 12]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={rig.beams}>
				<cylinderGeometry args={[0.14, 0.9, 1, 20, 1, true]} />
				<CurvedBasicMaterial
					blending={ADDITIVE_BLENDING}
					depthWrite={false}
					opacity={night ? 0.12 : 0.07}
					toneMapped={false}
					transparent
				/>
			</InstancedParts>
			{/* The audience's theatre rows. */}
			{audience ? (
				<>
					<InstancedParts
						castShadow
						ink={PROP_INK * 0.7}
						inkColor={QUIZ_3D.seatFrame}
						items={seats.frames}
						receiveShadow
					>
						<boxGeometry args={[1, 1, 1]} />
						<ToonMaterial color={QUIZ_3D.seatFrame} />
					</InstancedParts>
					<InstancedParts castShadow items={seats.velvet}>
						<boxGeometry args={[1, 1, 1]} />
						<ToonMaterial color={QUIZ_3D.velvet} />
					</InstancedParts>
				</>
			) : null}
			{acts ? (
				<QuizActProps
					onStage={acts.onStage}
					reduced={reducedMotion}
					stations={stations}
					view={acts.view}
					youLayout={you.layout}
				/>
			) : null}
			<Villagers
				iconOnly={narrow}
				onSelect={onAsk}
				paths={paths}
				reducedMotion={reducedMotion}
				villagers={stars}
			/>
			{host.length > 0 ? (
				<Villagers
					iconOnly={narrow}
					reducedMotion={reducedMotion}
					villagers={host}
				/>
			) : null}
			<Villagers
				plates={false}
				reducedMotion={reducedMotion}
				villagers={unplated}
			/>
			{/* Each live clue's status chip, at its tile's top right corner. */}
			{cells.map((cell) => {
				const tile = cell.tile;
				if (!tile || tile.thread.id === openId) {
					return null;
				}
				const corner = wallPoint(
					(cell.column - (board.columns.length - 1) / 2) * WALL.column +
						WALL.cellWidth / 2 -
						0.1,
					0.14,
					cell.at[1] + WALL.cellHeight / 2 - 0.1
				);
				return (
					<TileChip
						at={corner}
						handlers={handlers}
						key={tile.thread.id}
						state={cell.state}
						tile={tile}
					/>
				);
			})}
		</group>
	);
}
