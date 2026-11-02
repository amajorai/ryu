import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties } from "react";
import type { PathUnit } from "./path-model.ts";
import { PATH_STOP_ATTRIBUTE, pathAddKey } from "./path-stop.tsx";
/** How long a requested focus move may wait for the host to open or close. */
export const FOCUS_REQUEST_TTL_MS = 2000;
export const NAV_HINT_ID = "path-nav-hint";

/** Below this stage width the HUD plates go compact. */
export const COMPACT_BELOW = 720;

/** The island's rim round the trail, for trees and shore. */
export const ISLAND_RIM = 2.4;

/** What the stones' colours and marks mean, for the HUD's legend. */
export const LEGEND_ITEMS = [
	{ className: "bg-(--gk-gold)", key: "done", label: "Done" },
	{ className: "bg-(--gk-warn)", key: "current", label: "Up next" },
	{ className: "bg-(--gk-info)", key: "reply", label: "Your turn" },
	{ className: "bg-(--gk-bad)", key: "attention", label: "Needs you" },
	{ className: "bg-(--gk-good)", key: "working", label: "Working" },
] as const;
/**
 * The path's horizontal geometry: its center and one swing step. Narrow
 * columns move the path left and tighten the swing so labels fit beside it.
 */
export const PATH_GEOMETRY =
	"[--path-center:50%] [--path-step:min(68px,11.5cqw)] @max-[519px]/col:[--path-center:26%] @max-[519px]/col:[--path-step:18px]";

export interface FocusRequest {
	at: number;
	to: "opener" | "panel";
}

/** Escape inside a text field belongs to the field (or the host's composer). */
export function isEditable(target: EventTarget): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !== null
	);
}

export const STOP_SELECTOR = `[${PATH_STOP_ATTRIBUTE}]`;

/** Every stop key on the path, in path order. */
export function pathStopKeys(units: readonly PathUnit[]): string[] {
	const keys: string[] = [];
	for (const unit of units) {
		for (const stop of unit.stops) {
			keys.push(stop.thread.id);
		}
		keys.push(pathAddKey(unit.id));
	}
	return keys;
}

/**
 * The path's single Tab stop: the last stop you focused, else the open
 * thread, else the stop the path points at, else the first one.
 */
export function tabStopKey(
	keys: readonly string[],
	candidates: readonly (string | null | undefined)[]
): string | null {
	for (const candidate of candidates) {
		if (candidate && keys.includes(candidate)) {
			return candidate;
		}
	}
	return keys[0] ?? null;
}

/** Up/Down (and Home/End) walk the path from stop to stop. */
export function moveAlongPath(
	root: HTMLElement,
	from: HTMLElement,
	key: string
): boolean {
	const stops = [...root.querySelectorAll<HTMLElement>(STOP_SELECTOR)];
	const index = stops.indexOf(from);
	if (index === -1) {
		return false;
	}
	const target = pathKeyTarget(key, index, stops.length);
	if (target === null) {
		return false;
	}
	stops[target]?.focus();
	return true;
}

function pathKeyTarget(key: string, index: number, count: number) {
	switch (key) {
		case "ArrowDown":
			return Math.min(count - 1, index + 1);
		case "ArrowUp":
			return Math.max(0, index - 1);
		case "End":
			return count - 1;
		case "Home":
			return 0;
		default:
			return null;
	}
}

/**
 * Bring a stop into view the way the reference opens on the current lesson:
 * with its unit's banner at the top when that still shows the stop, centered
 * (clear of the sticky banner) otherwise.
 */
export function revealStop(scroller: HTMLElement, threadId: string) {
	const stop = scroller.querySelector<HTMLElement>(
		`[data-thread-id="${CSS.escape(threadId)}"]`
	);
	if (!stop) {
		return;
	}
	const view = scroller.getBoundingClientRect();
	const rect = stop.getBoundingClientRect();
	const section = stop.closest("section");
	const sectionTop = section?.getBoundingClientRect().top;
	// The banner sticks below the HUD: its sticky offset is the top inset.
	const banner = section?.firstElementChild;
	const inset =
		banner instanceof HTMLElement
			? Number.parseFloat(getComputedStyle(banner).top) || 0
			: 0;
	// The stop's label and ring sit up to 24px below its box.
	if (
		sectionTop !== undefined &&
		rect.bottom + 24 - sectionTop <= view.height - inset
	) {
		scroller.scrollTop += sectionTop - view.top - inset;
		return;
	}
	const target = view.top + (view.height + 96 + inset) / 2;
	scroller.scrollTop += rect.top + rect.height / 2 - target;
}

export function PathSkeleton() {
	const rows = [
		{ id: "a", swing: 0 },
		{ id: "b", swing: -1 },
		{ id: "c", swing: -1.6 },
		{ id: "d", swing: -1 },
		{ id: "e", swing: 0 },
	];
	return (
		<div aria-hidden="true" className={cn("flex flex-col", PATH_GEOMETRY)}>
			<div className="pt-4 pb-4">
				<Skeleton className="h-[92px]" />
			</div>
			<ul className="flex flex-col pt-8">
				{rows.map(({ id, swing }) => (
					<li
						className="relative h-[104px]"
						key={id}
						// SAFETY: React's CSSProperties omits custom properties; the
						// swing is a plain number the skeleton's `left` calc uses.
						style={{ "--path-swing": swing } as CSSProperties}
					>
						<Skeleton
							className="absolute start-[calc(var(--path-center)+var(--path-swing)*var(--path-step)-32px)] top-0 size-16"
							radius="pill"
						/>
					</li>
				))}
			</ul>
		</div>
	);
}
