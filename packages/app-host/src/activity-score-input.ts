import { z } from "zod";

const activityTextSchema = z.string();
const activityNumberSchema = z.number();
const activityCallableSchema = z.function();

/** Request limits apply before recursive validation or JSON serialization. */
export const ACTIVITY_SCORE_JSON_LIMITS = {
	depth: 32,
	nodes: 4096,
	serializedChars: 1_000_000,
} as const;

function boundedJson<Input>(
	value: Input,
	limits: { depth: number; nodes: number; serializedChars: number },
	allowUndefined: boolean
): boolean {
	let nodes = limits.nodes;
	let characters = limits.serializedChars;
	const ancestors = new Set<object>();
	const consume = (count: number) => {
		characters -= count;
		return characters >= 0;
	};
	const string = (text: string) =>
		text.length <= characters && consume(JSON.stringify(text).length);
	const visit = <Item>(item: Item, depth: number): boolean => {
		if (--nodes < 0 || depth > limits.depth) {
			return false;
		}
		if (item === null) {
			return consume(4);
		}
		if (isActivityText(item)) {
			return string(item);
		}
		if (item === true || item === false) {
			return consume(item ? 4 : 5);
		}
		if (isActivityNumber(item)) {
			return Number.isFinite(item) && consume(JSON.stringify(item).length);
		}
		if (item === undefined) {
			return allowUndefined && consume(4);
		}
		const boxedItem = new Object(item);
		if (boxedItem !== item || nativeCallable(item)) {
			return false;
		}
		// SAFETY: Native Object identity rejects primitives; the native Function
		// schema rejects callables. Only the remaining object brand is asserted,
		// and every child descriptor is still validated within the work budget.
		const container = item as object;
		if (ancestors.has(container) || !consume(2)) {
			return false;
		}
		if (
			!Array.isArray(container) &&
			Object.getPrototypeOf(container) !== Object.prototype &&
			Object.getPrototypeOf(container) !== null
		) {
			return false;
		}
		ancestors.add(container);
		try {
			if (Array.isArray(container)) {
				if (container.length > nodes) {
					return false;
				}
				for (let index = 0; index < container.length; index++) {
					const entry = Object.getOwnPropertyDescriptor(
						container,
						String(index)
					);
					if (
						!(entry && "value" in entry) ||
						(index > 0 && !consume(1)) ||
						!visit(entry.value, depth + 1)
					) {
						return false;
					}
				}
				return true;
			}
			let entries = 0;
			for (const key in container) {
				if (!Object.hasOwn(container, key)) {
					continue;
				}
				const entry = Object.getOwnPropertyDescriptor(container, key);
				if (
					!(entry && "value" in entry) ||
					(entries++ > 0 && !consume(1)) ||
					!string(key) ||
					!consume(1) ||
					!visit(entry.value, depth + 1)
				) {
					return false;
				}
			}
			// The response validator also checks this own entry when non-enumerable.
			const prototypeEntry = Object.getOwnPropertyDescriptor(
				container,
				"__proto__"
			);
			return (
				!prototypeEntry ||
				prototypeEntry.enumerable ||
				("value" in prototypeEntry && visit(prototypeEntry.value, depth + 1))
			);
		} finally {
			ancestors.delete(container);
		}
	};
	// Count each reference again: a small shared DAG may serialize as a huge tree.
	return visit(value, 0);
}

export function isBoundedActivityJson<Input>(value: Input): boolean {
	return boundedJson(value, ACTIVITY_SCORE_JSON_LIMITS, false);
}

/** Desktop validates the complete forwarded request, including additive fields. */
export function isBoundedActivityScoreRequest<Input>(value: Input): boolean {
	return boundedJson(
		value,
		{
			depth: ACTIVITY_SCORE_JSON_LIMITS.depth + 1,
			nodes: ACTIVITY_SCORE_JSON_LIMITS.nodes * 5 + 1000,
			serializedChars: ACTIVITY_SCORE_JSON_LIMITS.serializedChars * 5 + 65_536,
		},
		true
	);
}

// Run only installed synchronous scalar schemas. Avoid issue finalization, which
// would add unrelated error-map or opaque-value observations to this budget gate.
function isActivityText<Input>(
	value: Input
): value is Input & z.output<typeof activityTextSchema> {
	const payload = { value, issues: [] };
	activityTextSchema._zod.run(payload, { async: false });
	return payload.issues.length === 0;
}
function isActivityNumber<Input>(
	value: Input
): value is Input & z.output<typeof activityNumberSchema> {
	const payload = { value, issues: [] };
	activityNumberSchema._zod.run(payload, { async: false });
	return payload.issues.length === 0;
}
function nativeCallable<Input>(value: Input): boolean {
	const payload = { value, issues: [] };
	activityCallableSchema._zod.run(payload, { async: false });
	return payload.issues.length === 0;
}
