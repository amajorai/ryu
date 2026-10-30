/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import {
	type FocusKey,
	type FocusPlate,
	nextFocus,
	ROW_TOLERANCE,
} from "./game3d-focus.ts";
import type { Vec3 } from "./game3d-palette.ts";

/** Moves focus from the focused scene plate in reading order. */
export function focusToward(root: HTMLElement, key: FocusKey): boolean {
	const targets = [
		...root.querySelectorAll<HTMLElement>("[data-iso-target]"),
	].filter((target) => target.tabIndex >= 0 && target.offsetParent !== null);
	if (targets.length === 0) {
		return false;
	}
	const plates: FocusPlate[] = targets.map((target) => {
		const box = target.getBoundingClientRect();
		const order = Number.parseFloat(target.dataset.isoOrder ?? "");
		return {
			order: Number.isFinite(order) ? order : undefined,
			x: box.left + box.width / 2,
			y: box.top + box.height / 2,
		};
	});
	const active = root.ownerDocument.activeElement;
	const current = active instanceof HTMLElement ? targets.indexOf(active) : -1;
	// Rows are plates within about half a plate's height of each other, so
	// a grid of small plates (quiz cells) keeps its rows apart.
	const heights = targets
		.map((target) => target.getBoundingClientRect().height)
		.sort((a, b) => a - b);
	const median = heights[Math.floor(heights.length / 2)] ?? ROW_TOLERANCE;
	const tolerance = Math.min(ROW_TOLERANCE, Math.max(6, median * 0.6));
	targets[nextFocus(plates, current, key, tolerance)]?.focus();
	return true;
}

/**
 * An interactive object's control in the scene: a kit plate billboarded at
 * `at` (a world point), focusable and clickable, reachable by Tab and the
 * arrow keys. Its children are the visible words; `label` is its name.
 */
export function IsoMarker({
	actAgent,
	activate,
	at,
	children,
	className,
	focusable = true,
	focusId,
	icon,
	iconOnly = false,
	label,
	onSelect,
	order,
	pressed,
	youSpot,
}: {
	/** The agent this marker is the per-agent target of (`data-act-agent`). */
	actAgent?: string;
	/**
	 * Called instead of `onSelect` (an asking agent's marker opens its ask
	 * card): the selection is left alone and `aria-pressed` is omitted.
	 */
	activate?: () => void;
	at: Vec3;
	children: ReactNode;
	className?: string;
	/**
	 * False keeps the marker clickable but out of the Tab order (a second
	 * marker for an agent whose per-agent Tab stop is elsewhere, S17).
	 */
	focusable?: boolean;
	/** What `IsoView.focusOnTarget` calls this marker's object. */
	focusId?: string;
	/** What an `iconOnly` marker shows (default: the label's initial). */
	icon?: ReactNode;
	/** Narrow stages: a 28px glyph target; `label` stays its full name. */
	iconOnly?: boolean;
	label: string;
	onSelect?: () => void;
	/** The game's order for arrow keys (door number, stop, cell). */
	order?: number;
	pressed?: boolean;
	/** This marker is a you-spot queue plate (`data-you-spot="slot"`). */
	youSpot?: "slot";
}) {
	return (
		<group position={at}>
			<Html center zIndexRange={[30, 0]}>
				<button
					aria-label={label}
					aria-pressed={activate ? undefined : pressed}
					className={cn(
						GAME_PLATE,
						GAME_FOCUS,
						"gk-display flex h-7 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full text-[13px] leading-none",
						iconOnly ? "min-w-7 [&_svg]:size-4" : "px-2.5",
						pressed && !activate && "bg-(--gk-accent) text-(--gk-accent-ink)",
						className
					)}
					data-act-agent={actAgent}
					data-icon-only={iconOnly ? "" : undefined}
					data-iso-focus={focusId}
					data-iso-order={order}
					data-iso-target=""
					data-you-spot={youSpot}
					onClick={activate ?? onSelect}
					tabIndex={focusable && (activate ?? onSelect) ? 0 : -1}
					type="button"
				>
					{iconOnly ? (icon ?? Array.from(label)[0] ?? "") : children}
				</button>
			</Html>
		</group>
	);
}

/** A name board in the scene (not a control): a kit plate at `at`. */
export function IsoLabel({ at, children }: { at: Vec3; children: ReactNode }) {
	return (
		<group position={at}>
			<Html center zIndexRange={[20, 0]}>
				<div
					className={cn(
						GAME_PLATE,
						"gk-display pointer-events-none flex h-7 select-none items-center whitespace-nowrap rounded-lg px-3 text-[13px] leading-none"
					)}
					data-iso-plate=""
				>
					{children}
				</div>
			</Html>
		</group>
	);
}

const ARROWS = new Set<string>([
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
]);

export function isFocusKey(key: string): key is FocusKey {
	return ARROWS.has(key);
}
