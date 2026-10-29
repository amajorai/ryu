import {
	type CSSProperties,
	createContext,
	type ReactNode,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";
import { EASE_OUT_CSS } from "../lib/ease.ts";
import {
	computeReorderShifts,
	type ReorderSlot,
} from "../lib/reorder-shift.ts";
import { useIsomorphicLayoutEffect } from "./use-isomorphic-layout-effect.ts";

// Drag-reorder preview for a list: rather than a drop line, the neighbours of
// the drop point slide apart and the dragged item glides into the gap. The
// surface keeps its own drag state (native HTML drag events, keys, persistence)
// and feeds this hook the dragged id, the hovered id and the side; each item
// registers its element and applies the returned style. Geometry lives in
// `lib/reorder-shift.ts`.
//
// Surfaces must keep the hovered target sticky while the pointer is over the
// dragged item itself — it slides under the pointer as the gap opens — and
// treat a drop on it as a drop on the current target.

const SHIFT_TRANSITION = `transform 200ms ${EASE_OUT_CSS}`;

export interface ReorderShiftOptions {
	/** The item being dragged, or null when no reorder drag is in flight. */
	activeId: string | null;
	axis: "x" | "y";
	/** Side of `overId` the drop lands on; omit for take-the-slot lists. */
	before?: boolean | undefined;
	/** The item the drop currently targets. */
	overId: string | null;
}

export interface ReorderShift {
	/**
	 * Whether the current target can be previewed by shifting: the dragged item
	 * and the target are measured in the same group. Surfaces fall back to their
	 * own marker otherwise (e.g. dropping into a different bracket).
	 */
	previewing: boolean;
	/**
	 * Callback ref for an item. Items only shift within their `group`; without
	 * one, items in the same list element (siblings, looking through
	 * single-child wrappers) shift together.
	 */
	register: (id: string, group?: string) => (el: HTMLElement | null) => void;
	/**
	 * The target for a take-the-slot list: the item whose resting slot holds
	 * the pointer when the hovered item shares the dragged item's group (and
	 * the pointer is over it), else the hovered item itself. Resolving against resting slots instead of
	 * whatever (shifted) element is under the pointer is what lets the dragged
	 * item follow the pointer back to where it started.
	 */
	resolveOver: <Id extends string>(
		hoveredId: Id,
		clientX: number,
		clientY: number
	) => Id;
	/** Transform for an item; undefined while no drag is in flight. */
	styleFor: (id: string) => CSSProperties | undefined;
	/** Whether `id` was measured for the drag in flight (it is in this list). */
	tracks: (id: string) => boolean;
}

/**
 * A reorder shift with no drag in flight: nothing previews or moves. For
 * surfaces rendered outside a live drag context (fixtures and static stories).
 */
export const IDLE_REORDER_SHIFT: ReorderShift = {
	previewing: false,
	register: () => () => undefined,
	resolveOver: (hoveredId) => hoveredId,
	styleFor: () => undefined,
	tracks: () => false,
};

interface Registered {
	el: HTMLElement;
	group: string | undefined;
}

interface Snapshot {
	/** Where each group's container sat, to follow scrolling mid-drag. */
	anchors: Map<string, { el: HTMLElement; start: number }>;
	groupOf: Map<string, string>;
	reducedMotion: boolean;
	slotsByGroup: Map<string, ReorderSlot[]>;
	/** Each item's own resting transition, so the shift adds to it. */
	transitions: Map<string, string>;
}

/** The list an item belongs to, skipping single-child wrappers (context-menu
 *  triggers, tooltip anchors) that each item may sit in. */
function listContainer(el: HTMLElement): HTMLElement | null {
	let container = el.parentElement;
	while (container?.parentElement && container.childElementCount === 1) {
		container = container.parentElement;
	}
	return container;
}

function measure(
	items: ReadonlyMap<string, Registered>,
	axis: "x" | "y"
): Snapshot {
	const slotsByGroup = new Map<string, ReorderSlot[]>();
	const groupOf = new Map<string, string>();
	const transitions = new Map<string, string>();
	const anchors = new Map<string, { el: HTMLElement; start: number }>();
	const startOf = (rect: DOMRect) => (axis === "x" ? rect.left : rect.top);
	const parentGroups = new Map<Element | null, string>();
	for (const [id, registered] of items) {
		const { el } = registered;
		if (!el.isConnected) {
			continue;
		}
		const parent = listContainer(el);
		let group = registered.group;
		if (group === undefined) {
			group = parentGroups.get(parent) ?? `parent:${parentGroups.size}`;
			parentGroups.set(parent, group);
		}
		const rect = el.getBoundingClientRect();
		if (parent && !anchors.has(group)) {
			anchors.set(group, {
				el: parent,
				start: startOf(parent.getBoundingClientRect()),
			});
		}
		const slot =
			axis === "x"
				? { id, start: rect.left, end: rect.right }
				: { id, start: rect.top, end: rect.bottom };
		const slots = slotsByGroup.get(group) ?? [];
		slots.push(slot);
		slotsByGroup.set(group, slots);
		groupOf.set(id, group);
		transitions.set(id, getComputedStyle(el).transition);
	}
	for (const slots of slotsByGroup.values()) {
		slots.sort((a, b) => a.start - b.start);
	}
	return {
		anchors,
		groupOf,
		reducedMotion:
			typeof window !== "undefined" &&
			window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
		slotsByGroup,
		transitions,
	};
}

export function useReorderShift({
	activeId,
	axis,
	before,
	overId,
}: ReorderShiftOptions): ReorderShift {
	const items = useRef(new Map<string, Registered>());
	const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

	// Measure once per drag, before anything has shifted: transforms leave
	// layout alone, so the resting slots stay valid for the whole gesture.
	useIsomorphicLayoutEffect(() => {
		setSnapshot(activeId ? measure(items.current, axis) : null);
	}, [activeId, axis]);

	const group = activeId ? snapshot?.groupOf.get(activeId) : undefined;
	const previewing =
		group !== undefined &&
		overId !== null &&
		snapshot?.groupOf.get(overId) === group;
	const shifts = useMemo(() => {
		if (!(snapshot && previewing && group !== undefined)) {
			return new Map<string, number>();
		}
		return computeReorderShifts(
			snapshot.slotsByGroup.get(group) ?? [],
			activeId,
			overId,
			before
		);
	}, [snapshot, previewing, group, activeId, overId, before]);

	const register = (id: string, itemGroup?: string) => {
		const key = `${itemGroup ?? ""}\u0000${id}`;
		let ref = refs.current.get(key);
		if (!ref) {
			ref = (el: HTMLElement | null) => {
				if (el) {
					items.current.set(id, { el, group: itemGroup });
				} else if (items.current.get(id)?.group === itemGroup) {
					items.current.delete(id);
				}
			};
			refs.current.set(key, ref);
		}
		return ref;
	};

	const styleFor = (id: string): CSSProperties | undefined => {
		if (!(snapshot && activeId)) {
			// No transition at rest: a committed drop re-lays items out exactly
			// where they are drawn, and a cancelled one snaps straight back.
			return;
		}
		const offset = shifts.get(id) ?? 0;
		const resting = snapshot.transitions.get(id);
		return {
			transform: offset
				? `translate${axis === "x" ? "X" : "Y"}(${offset}px)`
				: undefined,
			// Appended last so it wins for `transform` over a resting `all`.
			transition: snapshot.reducedMotion
				? undefined
				: [resting, SHIFT_TRANSITION].filter(Boolean).join(", "),
		};
	};

	const resolveOver = <Id extends string>(
		hoveredId: Id,
		clientX: number,
		clientY: number
	): Id => {
		if (
			!(snapshot && group !== undefined) ||
			snapshot.groupOf.get(hoveredId) !== group
		) {
			return hoveredId;
		}
		// The pointer normally sits inside the element it is hovering; when it
		// does not (the surface's padding, a synthesized event), the hovered
		// item is the only target there is.
		const hovered = items.current.get(hoveredId)?.el.getBoundingClientRect();
		if (
			hovered &&
			!(
				clientX >= hovered.left &&
				clientX <= hovered.right &&
				clientY >= hovered.top &&
				clientY <= hovered.bottom
			)
		) {
			return hoveredId;
		}
		const anchor = snapshot.anchors.get(group);
		const drift = anchor?.el.isConnected
			? (axis === "x"
					? anchor.el.getBoundingClientRect().left
					: anchor.el.getBoundingClientRect().top) - anchor.start
			: 0;
		const point = (axis === "x" ? clientX : clientY) - drift;
		const slots = snapshot.slotsByGroup.get(group) ?? [];
		for (const [index, slot] of slots.entries()) {
			const next = slots[index + 1];
			if (!next || point < (slot.end + next.start) / 2) {
				/* SAFETY: one shift serves one list, and that list registers every item under the same id type as the hovered item it passes in. */
				return slot.id as Id;
			}
		}
		return hoveredId;
	};

	const tracks = (id: string) => snapshot?.groupOf.has(id) === true;

	return { previewing, register, resolveOver, styleFor, tracks };
}

const ReorderShiftContext = createContext<ReorderShift | null>(null);

/** Hands a list's {@link ReorderShift} to items rendered further down. */
export function ReorderShiftScope({
	children,
	value,
}: {
	children: ReactNode;
	value: ReorderShift;
}) {
	return (
		<ReorderShiftContext.Provider value={value}>
			{children}
		</ReorderShiftContext.Provider>
	);
}

/** Ref + style for one item inside a {@link ReorderShiftScope}; inert outside one. */
export function useReorderShiftItem(
	id: string,
	group?: string
): {
	previewing: boolean;
	ref: ((el: HTMLElement | null) => void) | undefined;
	style: CSSProperties | undefined;
} {
	const shift = useContext(ReorderShiftContext);
	return {
		previewing: shift?.previewing ?? false,
		ref: shift?.register(id, group),
		style: shift?.styleFor(id),
	};
}
