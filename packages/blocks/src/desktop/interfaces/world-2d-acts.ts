import type {
	InterfaceAgentAct,
	WorldLayout,
	WorldPoint,
} from "@ryuhq/protocol/interfaces";
import {
	actorTarget,
	slotOf,
	YOU_SLOTS,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";

/**
 * The 2D village's act places, in tiles: your doorstep is the tile you
 * start on. Asking villagers path to the queue places either side of you
 * along your row (nearest first, alternating sides; as many as fit in a
 * thin view), notice posts on the free tiles left; answers wait in the
 * chest beside you, deliverers on the free tiles nearest it. A place
 * that finds no free tile is `null`, and whoever would stand there stays
 * home, as do askers past the four places: no two share a tile, none
 * stands on you or on a cottage. Pure, so it is testable.
 */
export interface World2dYouSpot {
	slots: Record<YouSlot, WorldPoint | null>;
	/** The chest of answers. */
	tray: WorldPoint | null;
	/** Where deliverers stand, nearest the chest first. */
	trayRow: readonly WorldPoint[];
	you: WorldPoint;
}

/** How many deliverers get a tile by the chest; the rest stay home. */
const TRAY_ROW = 4;
/** How far (in tiles) from the chest a deliverer may stand. */
const TRAY_REACH = 3;
/** On a narrow stage a tile sideways costs this many tiles up or down. */
const NARROW_SIDEWAYS = 3;

/** Which queue slots a villager carries and which hold a notice post. */
export interface World2dQueueUse {
	posts: readonly YouSlot[];
	villagers: readonly YouSlot[];
}

const ALL_VILLAGERS: World2dQueueUse = { posts: [], villagers: YOU_SLOTS };

/**
 * Your doorstep's places, on free tiles beside `layout.spawn` (pass the
 * start layout). On a narrow stage the queue runs down your column instead
 * of along your row, so it stays inside the tall, thin view. `use` says
 * which slots are villagers and which notice posts (default: all
 * villagers); unused slots get no place.
 */
export function world2dYouSpot(
	layout: WorldLayout,
	free: (point: WorldPoint) => boolean,
	narrow = false,
	use: World2dQueueUse = ALL_VILLAGERS
): World2dYouSpot {
	const you = layout.spawn;
	const taken = new Set([key(you)]);
	const open = (point: WorldPoint) =>
		point.x >= 0 &&
		point.x < layout.width &&
		point.y >= 0 &&
		point.y < layout.height &&
		!taken.has(key(point)) &&
		free(point);
	const take = (point: WorldPoint) => {
		taken.add(key(point));
		return point;
	};
	const homes = new Set(layout.entities.map((entity) => key(entity)));
	// Never just south of a home, where it would cover that villager.
	const usable = (point: WorldPoint) =>
		open(point) && !homes.has(key({ x: point.x, y: point.y - 1 }));
	const villagerPlaces = queuePlaces(
		candidates(layout, you, narrow, 2).filter(usable),
		use.villagers.length
	);
	// A thin view has little room: if the villagers do not all fit, they
	// may also stand on the tiles diagonal to you.
	const roomier =
		narrow && villagerPlaces.length < use.villagers.length
			? queuePlaces(
					candidates(layout, you, narrow, 1)
						.filter((point) => point.x !== you.x && point.y !== you.y)
						.concat(candidates(layout, you, narrow, 2))
						.filter(usable),
					use.villagers.length
				)
			: [];
	const villagers = (
		roomier.length > villagerPlaces.length ? roomier : villagerPlaces
	).map(take);
	// A notice post has no "!" over it, so it may stand beside a villager,
	// but never just north of one (that villager's "!" rises into it).
	const posts: WorldPoint[] = [];
	for (const point of candidates(layout, you, narrow, 1)) {
		if (posts.length >= use.posts.length) {
			break;
		}
		const besideYou =
			Math.max(Math.abs(point.x - you.x), Math.abs(point.y - you.y)) <= 1;
		const overVillager = villagers.some(
			(place) => place.x === point.x && place.y === point.y + 1
		);
		if (!(besideYou || overVillager) && usable(point)) {
			posts.push(take(point));
		}
	}
	const places = new Map<YouSlot, WorldPoint>();
	for (const [index, slot] of use.villagers.entries()) {
		const place = villagers[index];
		if (place) {
			places.set(slot, place);
		}
	}
	for (const [index, slot] of use.posts.entries()) {
		const place = posts[index];
		if (place) {
			places.set(slot, place);
		}
	}
	// The chest sits right beside you; deliverers on the free tiles
	// nearest it.
	// Open ground south of it too, so no roof covers the chest.
	const tray =
		[
			{ x: you.x - 1, y: you.y },
			{ x: you.x + 1, y: you.y },
		].find((point) => open(point) && free({ x: point.x, y: point.y + 1 })) ??
		null;
	const trayRow: WorldPoint[] = [];
	if (tray) {
		take(tray);
		const near: WorldPoint[] = [];
		for (let dy = -TRAY_REACH; dy <= TRAY_REACH; dy++) {
			for (let dx = -TRAY_REACH; dx <= TRAY_REACH; dx++) {
				near.push({ x: tray.x + dx, y: tray.y + dy });
			}
		}
		// On a narrow stage, nearest your column first: the view is thin.
		const away = (point: WorldPoint) =>
			narrow
				? Math.abs(point.x - you.x) * NARROW_SIDEWAYS +
					Math.abs(point.y - tray.y)
				: Math.abs(point.x - tray.x) + Math.abs(point.y - tray.y);
		near.sort((first, second) => away(first) - away(second));
		// A tile of room left round you, as for the queue.
		const roomy = (point: WorldPoint) =>
			Math.max(Math.abs(point.x - you.x), Math.abs(point.y - you.y)) > 1;
		for (const point of near) {
			if (trayRow.length < TRAY_ROW && roomy(point) && open(point)) {
				trayRow.push(take(point));
			}
		}
	}
	const slots = Object.fromEntries(
		YOU_SLOTS.map((slot) => [slot, places.get(slot) ?? null])
	) as Record<YouSlot, WorldPoint | null>;
	return { slots, tray, trayRow, you };
}

/**
 * The queue's candidate tiles, best first: from `first` tiles out along
 * your row (or column), then the lines beside it, alternating sides, a
 * step out before a step further.
 */
function candidates(
	layout: WorldLayout,
	you: WorldPoint,
	narrow: boolean,
	first: number
): WorldPoint[] {
	const length = narrow ? layout.height : layout.width;
	const out: WorldPoint[] = [];
	for (let step = first; step < length; step++) {
		for (const line of [0, 1, -1]) {
			for (const side of [1, -1]) {
				out.push(
					narrow
						? { x: you.x + line, y: you.y + side * step }
						: { x: you.x + side * step, y: you.y + line }
				);
			}
		}
	}
	return out;
}

/**
 * Up to `count` places from `options` (best first), never two side by side
 * on a row or column (so one asker's "!" never sits on the next; diagonal
 * neighbours clear each other). Nearest first, unless starting further
 * along fits more of them.
 */
function queuePlaces(
	options: readonly WorldPoint[],
	count: number
): WorldPoint[] {
	let best: WorldPoint[] = [];
	for (const [start, first] of options.entries()) {
		const places = [first];
		for (const point of options.slice(start + 1)) {
			if (places.length >= count) {
				break;
			}
			if (
				places.every(
					(place) =>
						Math.abs(place.x - point.x) + Math.abs(place.y - point.y) > 1
				)
			) {
				places.push(point);
			}
		}
		if (places.length > best.length) {
			best = places;
		}
		if (best.length >= count) {
			break;
		}
	}
	return best.slice(0, count);
}

function key(point: WorldPoint): string {
	return `${point.x},${point.y}`;
}

/**
 * The tile a villager stands on for its act: home, its queue place, or the
 * `trayIndex`th tile by the chest; home again under reduced motion for a
 * deliverer (its chest still fills), for an asker without a queue place
 * and for anyone whose place found no free tile.
 */
export function world2dActorTile(
	act: InterfaceAgentAct,
	home: WorldPoint,
	spot: World2dYouSpot,
	slots: readonly YouSpotSlot[],
	still: boolean,
	trayIndex = 0
): WorldPoint {
	const vec = (point: WorldPoint | null): [number, number, number] => [
		(point ?? home).x,
		0,
		(point ?? home).y,
	];
	const points: Record<string, [number, number, number]> = {
		[`home:${act.agentId}`]: vec(home),
		you: vec(home),
		"you-tray": vec(spot.trayRow[trayIndex] ?? null),
	};
	for (const slot of YOU_SLOTS) {
		points[slot] = vec(spot.slots[slot]);
	}
	const [x, , y] = actorTarget(
		act,
		{
			paths: { links: [], points },
			slot: slotOf(slots, act.agentId),
			station: `home:${act.agentId}`,
		},
		still
	).position;
	return { x, y };
}
