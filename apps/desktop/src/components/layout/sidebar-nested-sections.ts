import {
	type ReorderShift,
	useReorderShift,
} from "@ryu/ui/hooks/use-reorder-shift.tsx";
import { useMemo, useState } from "react";
import { z } from "zod";
import type {
	VisibilityDragPayload,
	VisibilityResourceType,
} from "@/src/lib/resource-visibility.ts";
import { loadIdSet, saveIdSet } from "./sidebar-panel-state.tsx";

/** Chat history — loose chats only (folder-scoped chats live nested under the
 *  single Projects section, rendered as ProjectsSection above this one). */
// ---------------------------------------------------------------------------
// Nested sub-sections (date buckets under Chats, folders under Projects)
//
// These reuse the exact section-header visual (chevron + grab-to-reorder + hover)
// but nest one level under a parent section, with their own per-child collapse
// and drag-order state. Two localStorage keys per surface: an order array and a
// "toggled" set (keys flipped away from the surface's default collapse state).
// ---------------------------------------------------------------------------

export const CHAT_VISIBILITY_ORDER_KEY = "ryu:sidebar-chat-visibility-order";
export const CHAT_VISIBILITY_COLLAPSED_KEY =
	"ryu:sidebar-collapsed-chat-visibility";
export const PROJECT_ORDER_KEY = "ryu:sidebar-project-order";

/** Persisted ordering for a set of nested sub-sections (keys the user dragged). */
function loadOrder(key: string): string[] {
	try {
		const stored = localStorage.getItem(key);
		if (!stored) {
			return [];
		}
		const parsed = JSON.parse(stored);
		const rows = z.array(z.unknown()).safeParse(parsed);
		return rows.success
			? rows.data.flatMap((row) => {
					const value = z.string().safeParse(row);
					return value.success ? [value.data] : [];
				})
			: [];
	} catch {
		return [];
	}
}

function saveOrder(key: string, order: string[]) {
	try {
		localStorage.setItem(key, JSON.stringify(order));
	} catch {
		// best-effort
	}
}

/** The date-bucketing primitive itself lives in `lib/sidebar/date-buckets.ts` —
 *  generic over the row type, so every list below can use it rather than only
 *  Chats. {@link DateGroupedRows} is the render half. */

/** Drag-and-drop wiring for the nested sub-sections (mirrors SectionDnd, but
 *  string-keyed and self-contained rather than threaded from the top level). */
export interface SubSectionDnd {
	draggingKey: string | null;
	dragOverKey: string | null;
	/** Present when the surface supports nesting sub-sections in each other. */
	nesting?: SubSectionNesting;
	/** The header the drag is hovering over in its "drop inside" band. */
	nestOverKey: string | null;
	onDragEnd: () => void;
	onDragOver: (key: string, intoTarget?: boolean) => void;
	onDragStart: (key: string) => void;
	onDrop: (key: string) => void;
	order: string[];
	/** Slides sibling sub-sections apart to preview a reorder. */
	shift: ReorderShift;
}

/**
 * Zen-style nesting for one surface's sub-sections: dropping a header on the
 * middle of another header moves it inside; dropping on an edge places it
 * beside the target, adopting the target's parent.
 */
export interface SubSectionNesting {
	canNestInto: (dragKey: string, targetKey: string) => boolean;
	canPlaceBeside: (dragKey: string, targetKey: string) => boolean;
	onNestInto: (dragKey: string, targetKey: string) => void;
	onPlaceBeside: (dragKey: string, targetKey: string) => void;
}

/** Share of a header's height, from each edge, that reorders instead of nesting. */
export const SUBSECTION_REORDER_EDGE = 0.25;

export interface VisibilitySubSectionDrop {
	accept: VisibilityResourceType;
	canDrop: (payload: VisibilityDragPayload) => boolean;
	canDropOnDragOver?: () => boolean;
	onDrop: (payload: VisibilityDragPayload) => void;
}

interface NestedSectionsState {
	dnd: SubSectionDnd;
	/** Show `key`'s children (no-op when already expanded). */
	expand: (key: string) => void;
	isCollapsed: (key: string) => boolean;
	orderedKeys: string[];
	toggle: (key: string) => void;
}

/** Owns per-child collapse + drag-order for one parent's sub-sections. The
 *  `toggled` set holds keys flipped away from `defaultCollapsed`, so the same
 *  storage serves a default-expanded surface (date buckets) and a
 *  default-collapsed one (projects). */
export function useNestedSections(
	orderKey: string,
	collapseKey: string,
	keys: string[],
	defaultCollapsed: boolean,
	nesting?: SubSectionNesting
): NestedSectionsState {
	const [order, setOrder] = useState<string[]>(() => loadOrder(orderKey));
	const [nestOverKey, setNestOverKey] = useState<string | null>(null);
	const [toggled, setToggled] = useState<Set<string>>(() =>
		loadIdSet(collapseKey)
	);
	const [draggingKey, setDraggingKey] = useState<string | null>(null);
	const [dragOverKey, setDragOverKey] = useState<string | null>(null);
	// Nesting into a header highlights it instead of opening a gap.
	const shift = useReorderShift({
		activeId: draggingKey,
		axis: "y",
		overId: nestOverKey ? null : dragOverKey,
	});

	// Keep the user's stored order for keys still present, append newcomers in
	// their natural (incoming) order, and drop keys that no longer exist.
	const orderedKeys = useMemo(() => {
		const present = new Set(keys);
		const known = order.filter((k) => present.has(k));
		const knownSet = new Set(known);
		const extras = keys.filter((k) => !knownSet.has(k));
		return [...known, ...extras];
	}, [order, keys]);

	const isCollapsed = (key: string) =>
		defaultCollapsed ? !toggled.has(key) : toggled.has(key);

	const toggle = (key: string) =>
		setToggled((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			saveIdSet(collapseKey, next);
			return next;
		});

	// Expanded means `toggled.has(key) === defaultCollapsed`. Reads `prev`, not
	// the render closure, so it composes with a toggle in the same batch.
	const expand = (key: string) =>
		setToggled((prev) => {
			if (prev.has(key) === defaultCollapsed) {
				return prev;
			}
			const next = new Set(prev);
			if (defaultCollapsed) {
				next.add(key);
			} else {
				next.delete(key);
			}
			saveIdSet(collapseKey, next);
			return next;
		});

	const reorder = (dragKey: string, dropKey: string) => {
		if (dragKey === dropKey) {
			return;
		}
		const base = [...orderedKeys];
		const from = base.indexOf(dragKey);
		const to = base.indexOf(dropKey);
		if (from < 0 || to < 0) {
			return;
		}
		base.splice(from, 1);
		const insertAt = base.indexOf(dropKey) + (from < to ? 1 : 0);
		base.splice(insertAt, 0, dragKey);
		setOrder(base);
		saveOrder(orderKey, base);
	};

	const clearDrag = () => {
		setDraggingKey(null);
		setDragOverKey(null);
		setNestOverKey(null);
	};

	const drop = (dragKey: string, key: string) => {
		if (!nesting) {
			reorder(dragKey, key);
			return;
		}
		if (nestOverKey === key && nesting.canNestInto(dragKey, key)) {
			nesting.onNestInto(dragKey, key);
			// Children render only under an expanded parent: open the target so
			// the section just nested into it stays visible.
			expand(key);
			return;
		}
		if (dragKey !== key && nesting.canPlaceBeside(dragKey, key)) {
			nesting.onPlaceBeside(dragKey, key);
			reorder(dragKey, key);
		}
	};

	return {
		dnd: {
			draggingKey,
			dragOverKey,
			nesting,
			nestOverKey,
			onDragEnd: clearDrag,
			onDragOver: (key, intoTarget = false) => {
				setDragOverKey(key);
				setNestOverKey(intoTarget ? key : null);
			},
			onDragStart: setDraggingKey,
			onDrop: (key) => {
				// The resolved target, not the (possibly shifted) element under
				// the pointer at release.
				if (draggingKey) {
					drop(draggingKey, dragOverKey ?? key);
				}
				clearDrag();
			},
			order: orderedKeys,
			shift,
		},
		expand,
		isCollapsed,
		orderedKeys,
		toggle,
	};
}
