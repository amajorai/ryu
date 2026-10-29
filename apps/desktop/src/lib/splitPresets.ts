/** Named pane layouts ("split presets") — the shape of a split, without the
 *  tabs.
 *
 *  A `Split` cannot be a preset: its leaves are tab ids, and tab ids are
 *  per-session (session restore regenerates them, which is exactly why the
 *  session snapshot serializes the tree over tab INDEXES). So a preset is a
 *  parallel, id-free tree: branches carry orientation + fractions like
 *  `SplitBranch`, but the leaves are `slot`s — "a pane goes here" — with an
 *  optional route the slot should open.
 *
 *  Geometric by default: "save this layout" means the arrangement, and a
 *  shape-only preset is portable (it means the same thing on every machine,
 *  which is what lets the collection ride settings sync). Capturing what each
 *  pane was showing is opt-in, and stores an app ROUTE, never a machine path.
 *
 *  Everything here is pure so the store, the menus and the tests can share one
 *  definition of "apply this preset".
 */

import { z } from "zod";
import {
	equalSizes,
	makeBranch,
	makeLeaf,
	normalizeNode,
	type SplitBranch,
	type SplitNode,
	type SplitOrientation,
} from "@/src/lib/splitTree.ts";

/** One pane of a preset. `path` pre-opens a route in that pane; when absent the
    pane is laid out empty and the user picks its contents. */
export interface PresetSlot {
	path?: string;
	type: "slot";
}

export interface PresetBranch {
	children: PresetNode[];
	orientation: SplitOrientation;
	/** One fraction per child along the main axis, summing to ~1. */
	sizes: number[];
	type: "branch";
}

export type PresetNode = PresetBranch | PresetSlot;

export interface SplitPreset {
	/** True for the shipped starter layouts — they live in code, are never
	    persisted, and cannot be renamed or deleted. */
	builtin?: boolean;
	createdAt: number;
	id: string;
	name: string;
	root: PresetBranch;
}

/** The route an empty pane opens: a picker that fills itself in. Declared here
    (not in TabsContext) because both the preset applier and the page itself
    need the string. */
export const PANE_CHOOSER_PATH = "/pane";

export function makeSlot(path?: string): PresetSlot {
	return path ? { type: "slot", path } : { type: "slot" };
}

export function makePresetBranch(
	orientation: SplitOrientation,
	children: PresetNode[],
	sizes?: number[]
): PresetBranch {
	return {
		type: "branch",
		orientation,
		children,
		sizes:
			sizes && sizes.length === children.length
				? sizes
				: equalSizes(children.length),
	};
}

/** Every slot in pane order (depth-first) — the order `applySplitPreset`
    consumes tab ids in, so slot i gets tab id i. */
export function presetSlots(node: PresetNode): PresetSlot[] {
	if (node.type === "slot") {
		return [node];
	}
	return node.children.flatMap(presetSlots);
}

/** How many panes the preset lays out. */
export function presetSlotCount(node: PresetNode): number {
	return presetSlots(node).length;
}

/** Whether the shape nests — a branch inside a branch, i.e. an arrangement no
    single axis describes ("one tall pane beside two stacked", a 2 × 2 grid). */
export function presetIsNested(node: PresetNode): boolean {
	return (
		node.type === "branch" &&
		node.children.some((c) => c.type === "branch" || presetIsNested(c))
	);
}

/** Human summary for a menu row ("3 panes · side by side"). A nested shape is
    called "tiled" rather than named after its root axis: a 2 × 2 grid has a
    `columns` root, but calling it "side by side" would describe the wrong
    layout. */
export function presetSummary(preset: SplitPreset): string {
	const panes = presetSlotCount(preset.root);
	let axis = preset.root.orientation === "columns" ? "side by side" : "stacked";
	if (presetIsNested(preset.root)) {
		axis = "tiled";
	}
	return `${panes} panes · ${axis}`;
}

/** Whether any slot pins a route (drives the "opens saved pages" hint). */
export function presetPinsRoutes(node: PresetNode): boolean {
	return presetSlots(node).some((s) => !!s.path);
}

/** Capture a live split's arrangement as a reusable shape. Leaves become slots;
    with `pinRoutes` each slot remembers the route its tab was showing (the
    "remember what each pane was showing" option), otherwise the preset is
    purely geometric. Query strings are dropped — a route is portable, a
    one-shot query is not. */
export function presetFromSplit(
	root: SplitBranch,
	pathOf: (tabId: string) => string | undefined,
	opts?: { pinRoutes?: boolean }
): PresetBranch {
	const walk = (node: SplitNode): PresetNode => {
		if (node.type === "leaf") {
			const path = opts?.pinRoutes ? pathOf(node.tabId) : undefined;
			// Never pin the chooser itself — a preset that reopens empty panes as
			// "remembered content" would be a confusing no-op.
			return makeSlot(
				path && path !== PANE_CHOOSER_PATH ? path.split("?")[0] : undefined
			);
		}
		return makePresetBranch(node.orientation, node.children.map(walk), [
			...node.sizes,
		]);
	};
	const walked = walk(root);
	return walked.type === "branch"
		? walked
		: makePresetBranch("columns", [walked]);
}

/** Build a real split tree from a preset shape by filling its slots with
    `tabIds` in pane order. Returns null when the ids don't cover every slot or
    the result degenerates to a single pane (which `reconcileSplits` would
    rebuild FLAT, silently throwing the preset's nesting away — so callers must
    treat null as "do not apply"). Pure: the caller owns membership. */
export function buildPresetTree(
	root: PresetBranch,
	tabIds: readonly string[]
): SplitBranch | null {
	if (tabIds.length < presetSlotCount(root)) {
		return null;
	}
	const queue = [...tabIds];
	const walk = (node: PresetNode): SplitNode => {
		if (node.type === "slot") {
			// SAFETY: the slot-count check above guarantees one queued string for every
			// leaf visited by this depth-first traversal.
			return makeLeaf(queue.shift() as string);
		}
		return makeBranch(node.orientation, node.children.map(walk), [
			...node.sizes,
		]);
	};
	const built = normalizeNode(walk(root));
	return built && built.type === "branch" ? built : null;
}

/** The starter layouts every user has. Ids are namespaced so a stored user
    preset can never collide with one. */
export const BUILTIN_PRESETS: SplitPreset[] = [
	{
		id: "builtin:side-by-side",
		name: "Side by side",
		builtin: true,
		createdAt: 0,
		root: makePresetBranch("columns", [makeSlot(), makeSlot()]),
	},
	{
		id: "builtin:stacked",
		name: "Stacked",
		builtin: true,
		createdAt: 0,
		root: makePresetBranch("rows", [makeSlot(), makeSlot()]),
	},
	{
		id: "builtin:three-columns",
		name: "Three columns",
		builtin: true,
		createdAt: 0,
		root: makePresetBranch("columns", [makeSlot(), makeSlot(), makeSlot()]),
	},
	{
		id: "builtin:main-and-two-stacked",
		name: "Main + two stacked",
		builtin: true,
		createdAt: 0,
		root: makePresetBranch(
			"columns",
			[makeSlot(), makePresetBranch("rows", [makeSlot(), makeSlot()])],
			[0.6, 0.4]
		),
	},
	{
		id: "builtin:grid",
		name: "2 × 2 grid",
		builtin: true,
		createdAt: 0,
		root: makePresetBranch("columns", [
			makePresetBranch("rows", [makeSlot(), makeSlot()]),
			makePresetBranch("rows", [makeSlot(), makeSlot()]),
		]),
	},
];

/** The most panes one preset may lay out. A preset applies by opening one real
    tab per slot, so an unbounded number (from hand-edited storage, or a synced
    value from another machine) would be a tab bomb. */
const MAX_PRESET_SLOTS = 12;
const MAX_PRESETS = 60;
const MAX_NAME_LENGTH = 64;

const storedPresetNodeSchema = z.object({
	type: z.enum(["slot", "branch"]),
	path: z.unknown().optional(),
	children: z.unknown().optional(),
	orientation: z.unknown().optional(),
	sizes: z.unknown().optional(),
});
const storedPresetSchema = z.object({
	id: z.string(),
	name: z.string(),
	root: z.unknown().optional(),
	createdAt: z.unknown().optional(),
});
const storedPresetArraySchema = z.array(z.unknown());
const presetSizeSchema = z.number().positive();
// The pure parser historically preserves any numeric creation time; JSON
// persistence turns non-finite values into null before the next read.
const presetCreationTimeSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
type StoredPresetInput = Parameters<typeof storedPresetSchema.parse>[0];

function parseNode(raw: StoredPresetInput, depth: number): PresetNode | null {
	const parsed = storedPresetNodeSchema.safeParse(raw);
	if (!parsed.success || depth > 8) {
		return null;
	}
	const row = parsed.data;
	if (row.type === "slot") {
		// A path is a route, never a filesystem path or a URL: anything that isn't
		// an app route is dropped rather than rejected, so one bad slot degrades to
		// an empty pane instead of losing the whole preset.
		const decodedPath = z.string().safeParse(row.path);
		const path =
			decodedPath.success &&
			decodedPath.data.startsWith("/") &&
			!decodedPath.data.startsWith("//")
				? decodedPath.data
				: undefined;

		return makeSlot(path);
	}
	const decodedChildren = storedPresetArraySchema.safeParse(row.children);
	if (row.type !== "branch" || !decodedChildren.success) {
		return null;
	}
	const children = decodedChildren.data
		.map((c) => parseNode(c, depth + 1))
		.filter((c): c is PresetNode => !!c);
	if (children.length < 2) {
		return null;
	}
	const orientation: SplitOrientation =
		row.orientation === "rows" ? "rows" : "columns";
	const rawSizes = storedPresetArraySchema.safeParse(row.sizes);
	const sizes: number[] = [];
	if (rawSizes.success) {
		for (const size of rawSizes.data) {
			const decoded = presetSizeSchema.safeParse(size);
			if (decoded.success) {
				sizes.push(decoded.data);
			}
		}
	}

	return makePresetBranch(
		orientation,
		children,
		sizes.length === children.length ? sizes : undefined
	);
}

/** Validate whatever came out of storage (or off settings sync). Anything that
    isn't a well-formed, id-free, bounded preset is dropped. */
export function parsePresets(raw: StoredPresetInput): SplitPreset[] {
	const parsed = storedPresetArraySchema.safeParse(raw);
	if (!parsed.success) {
		return [];
	}
	const out: SplitPreset[] = [];
	const seen = new Set<string>();
	for (const entry of parsed.data) {
		if (out.length >= MAX_PRESETS) {
			break;
		}
		const decoded = storedPresetSchema.safeParse(entry);
		if (!decoded.success) {
			continue;
		}
		const row = decoded.data;

		if (seen.has(row.id) || row.id.startsWith("builtin:")) {
			continue;
		}
		const root = parseNode(row.root, 0);
		if (root?.type !== "branch") {
			continue;
		}
		const slots = presetSlotCount(root);
		if (slots < 2 || slots > MAX_PRESET_SLOTS) {
			continue;
		}
		seen.add(row.id);
		const createdAt = presetCreationTimeSchema.safeParse(row.createdAt);
		out.push({
			id: row.id,
			name: row.name.slice(0, MAX_NAME_LENGTH),
			createdAt: createdAt.success ? createdAt.data : 0,
			root,
		});
	}
	return out;
}

export { MAX_NAME_LENGTH, MAX_PRESET_SLOTS, MAX_PRESETS };
