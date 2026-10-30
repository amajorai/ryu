/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { cn } from "@ryu/ui/lib/utils";
import { askAriaLabel, type InterfaceAsk } from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import { ToonMesh } from "./game3d-materials.tsx";
import type { Vec3 } from "./game3d-palette.ts";

/** What an opener plate is, for the browser checks. */
export type ActTargetKind =
	| "alarm"
	| "notice"
	| "suggestion"
	| "tally"
	| "tray"
	| "unread";

/** The DOM half of every act plate (pure DOM, testable without WebGL). */
export function ActPlateButton({
	budgeted,
	children,
	className,
	focusable,
	icon,
	iconOnly = false,
	kind,
	label,
	onActivate,
	tally,
	youSpot,
}: {
	/** A budgeted status overlay too (a tally): `data-budgeted-overlay`. */
	budgeted?: string;
	children?: ReactNode;
	className?: string;
	focusable: boolean;
	icon?: ReactNode;
	iconOnly?: boolean;
	kind: ActTargetKind;
	label: string;
	onActivate: () => void;
	/** A tally's scope (`data-tally`): the you-spot or the off-stage agents. */
	tally?: "off" | "you";
	/** Marks you-spot overlays (queue plates, tally, tray) for overlap checks. */
	youSpot?: "slot" | "tally" | "tray";
}) {
	return (
		<button
			aria-hidden={focusable ? undefined : true}
			aria-label={label}
			className={cn(
				GAME_PLATE,
				GAME_FOCUS,
				"gk-display flex h-7 min-w-7 cursor-pointer select-none items-center justify-center gap-1 whitespace-nowrap rounded-full text-[12px] leading-none [&_svg]:size-3.5 [&_svg]:shrink-0",
				iconOnly ? "px-1" : "px-2",
				className
			)}
			data-act-target={kind}
			data-budgeted-overlay={budgeted}
			data-icon-only={iconOnly ? "" : undefined}
			data-iso-plate={focusable ? undefined : ""}
			data-iso-target={focusable ? "" : undefined}
			data-tally={tally}
			data-you-spot={youSpot}
			onClick={(event) => {
				event.stopPropagation();
				onActivate();
			}}
			tabIndex={focusable ? 0 : -1}
			type="button"
		>
			{icon}
			{iconOnly ? null : children}
		</button>
	);
}

/** In front of every other act plate (a station's focus alarm). */
const FRONT_Z: [number, number] = [45, 36];

/** Space between stacked plate rows (px). */
export const PLATE_ROW_GAP = 4;

/**
 * An act plate billboarded at `at` in the scene; `front` keeps it on top.
 * `side` hangs it from `at`: "center" (default) centred on it, "right" with
 * its left edge on it, "left" with its right edge on it (beside a figure,
 * never over it). `row` lifts it that many plate heights (plus
 * PLATE_ROW_GAP) up the screen, whatever the camera's zoom; a negative row
 * drops it.
 */
export function ActPlate({
	at,
	front = false,
	row = 0,
	side = "center",
	...props
}: Parameters<typeof ActPlateButton>[0] & {
	at: Vec3;
	front?: boolean;
	row?: number;
	side?: "center" | "left" | "right";
}) {
	const lift = `${row} * (100% + ${PLATE_ROW_GAP}px)`;
	const button = <ActPlateButton {...props} />;
	let transform = `translateY(calc(0px - ${lift}))`;
	if (side === "right") {
		transform = `translate(0, calc(-50% - ${lift}))`;
	} else if (side === "left") {
		transform = `translate(-100%, calc(-50% - ${lift}))`;
	}
	return (
		<group position={at}>
			<Html center={side === "center"} zIndexRange={front ? FRONT_Z : [35, 0]}>
				{side === "center" && row === 0 ? (
					button
				) : (
					<div style={{ transform }}>{button}</div>
				)}
			</Html>
		</group>
	);
}

/** An opener's accessible name: its first ask, "and N more" for the rest. */
export function openerLabel(
	asks: readonly InterfaceAsk[],
	ownerName: string | null,
	nowMs: number,
	privacy: "full" | "redacted" = "full"
): string {
	const first = asks[0];
	if (!first) {
		return "";
	}
	const label = askAriaLabel(first, ownerName, nowMs, privacy);
	return asks.length > 1 ? `${label} and ${asks.length - 1} more` : label;
}

/** A small post: the base of notices and signs. */
export function Post({ color, height }: { color: string; height: number }) {
	return (
		<ToonMesh
			color={color}
			ink={0.012}
			position={[0, height / 2, 0]}
			scale={[0.06, height, 0.06]}
		>
			<boxGeometry />
		</ToonMesh>
	);
}
