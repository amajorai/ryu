import type { LanguagePack } from "./pack.ts";
import type { I18nRuntime } from "./runtime.ts";

/** Copy catalog data, so a host editing a pack in place still reads as a change. */
export function snapshotCatalogValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(snapshotCatalogValue);
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	const copy: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		copy[key] = snapshotCatalogValue(entry);
	}
	return copy;
}

/** Whether `value` holds exactly the catalog content captured in `snapshot`. */
export function sameCatalogValue(snapshot: unknown, value: unknown): boolean {
	if (Object.is(snapshot, value)) {
		return true;
	}
	if (
		snapshot === null ||
		value === null ||
		typeof snapshot !== "object" ||
		typeof value !== "object" ||
		Array.isArray(snapshot) !== Array.isArray(value)
	) {
		return false;
	}
	const keys = Object.keys(value);
	if (Object.keys(snapshot).length !== keys.length) {
		return false;
	}
	return keys.every(
		(key) =>
			Object.hasOwn(snapshot, key) &&
			sameCatalogValue(Reflect.get(snapshot, key), Reflect.get(value, key))
	);
}

/** The catalog content a runtime last applied, whether at construction or later. */
export interface AppliedCatalog {
	catalog: unknown;
	/** The array the catalog was last compared against, to spot a new read. */
	packs: readonly LanguagePack[];
	runtime: I18nRuntime;
}

const runtimeGenerations = new WeakMap<I18nRuntime, number>();
let lastRuntimeGeneration = 0;

/** A per-runtime number, so translations keyed on one runtime never match the next. */
export function runtimeGeneration(runtime: I18nRuntime | null): number {
	if (!runtime) {
		return 0;
	}
	let generation = runtimeGenerations.get(runtime);
	if (generation === undefined) {
		lastRuntimeGeneration += 1;
		generation = lastRuntimeGeneration;
		runtimeGenerations.set(runtime, generation);
	}
	return generation;
}
