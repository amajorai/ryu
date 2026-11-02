import { assignSlots, stableHash } from "./passport-model.ts";

/**
 * Inks that read alike on paper (blue and violet, blue and slate, green and
 * slate, oxblood and umber; see STAMP_INKS). Two countries with the same
 * stamp shape never take a pair from this list, so they stay told apart.
 */
const SIMILAR_INKS: readonly (readonly [number, number])[] = [
	[0, 3],
	[0, 4],
	[2, 4],
	[1, 5],
];

function inksAlike(a: number, b: number): boolean {
	return (
		a === b ||
		SIMILAR_INKS.some(
			([first, second]) =>
				(first === a && second === b) || (first === b && second === a)
		)
	);
}

/**
 * Hand out inks to one batch of at most `count` ids, each id trying slots
 * from its own hashed start. Backtracks so no two ids with the same shape
 * share an ink that reads alike; null when no such assignment exists.
 */
function inkBatch(
	ids: readonly string[],
	shapes: ReadonlyMap<string, number>,
	count: number
): number[] | null {
	const chosen: number[] = [];
	const place = (index: number): boolean => {
		const id = ids[index];
		if (id === undefined) {
			return true;
		}
		const start = stableHash(`ink:${id}`) % count;
		for (let step = 0; step < count; step += 1) {
			const slot = (start + step) % count;
			const clash = chosen.some(
				(ink, other) =>
					ink === slot ||
					(shapes.get(ids[other] ?? "") === shapes.get(id) &&
						inksAlike(ink, slot))
			);
			if (!clash) {
				chosen.push(slot);
				if (place(index + 1)) {
					return true;
				}
				chosen.pop();
			}
		}
		return false;
	};
	return place(0) ? chosen : null;
}

/**
 * Inks per agent: every ink once per `count` agents (in sorted id order, so
 * the result depends only on the set of ids), and countries that share a
 * stamp shape never share an ink that reads alike. If that cannot be met,
 * it falls back to plain distinct slots.
 */
export function assignInks(
	ids: readonly string[],
	shapes: ReadonlyMap<string, number>,
	count: number
): Map<string, number> {
	const sorted = [...ids].sort();
	const inks = new Map<string, number>();
	for (let start = 0; start < sorted.length; start += count) {
		const batch = sorted.slice(start, start + count);
		const chosen = inkBatch(batch, shapes, count);
		const fallback = chosen ? null : assignSlots(batch, count, "ink");
		batch.forEach((id, index) => {
			inks.set(id, chosen?.[index] ?? fallback?.get(id) ?? 0);
		});
	}
	return inks;
}
