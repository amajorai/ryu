import { cn } from "@ryu/ui/lib/utils";
import { Check, Snowflake } from "lucide-react";
import type { KeyboardEvent } from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import {
	type BoardRect,
	DOOR_COUNT,
	type SeasonDoor,
} from "./seasonal-model.ts";

/**
 * The board without WebGL (and in tests): the 24 places as a plain grid of
 * kit plates, six to a row, each the same door control the diorama's
 * number plates are.
 */

const COLUMNS = 6;
const CELL = 100;

/** Where each door sits on the grid, for moving up and down by arrow key. */
export const GRID_SLOTS: ReadonlyMap<number, BoardRect> = new Map(
	Array.from({ length: DOOR_COUNT }, (_, index) => [
		index + 1,
		{
			height: CELL,
			width: CELL,
			x: (index % COLUMNS) * CELL,
			y: Math.floor(index / COLUMNS) * CELL,
		},
	])
);

export function SeasonalGrid({
	activeNumber,
	doors,
	giftId,
	giftNumber,
	label,
	labelOf,
	onActivate,
	onKeyDown,
	today,
}: {
	activeNumber: number | null;
	doors: readonly SeasonDoor[];
	giftId: string;
	giftNumber: number | null;
	label: string;
	labelOf: (door: SeasonDoor) => string;
	onActivate: (number: number, element: HTMLButtonElement) => void;
	onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
	today: number | null;
}) {
	return (
		<nav aria-label={label} className="mx-auto w-full max-w-[720px] px-3">
			<ul className="grid grid-cols-6 gap-2">
				{doors.map((door) => {
					const filled = door.thread !== null;
					const active = activeNumber === door.number;
					const isToday = today === door.number;
					return (
						<li key={door.number}>
							<button
								aria-controls={giftNumber === door.number ? giftId : undefined}
								aria-expanded={filled ? giftNumber === door.number : undefined}
								aria-label={labelOf(door)}
								className={cn(
									GAME_PLATE,
									GAME_FOCUS,
									"gk-display flex aspect-square w-full flex-col items-center justify-center gap-0.5 text-[20px] tabular-nums transition-colors hover:bg-(--gk-plate-sunk)",
									isToday && "outline-(--gk-gold) outline-3 outline-solid",
									door.mark === "needs-you" && "bg-(--gk-bad) text-white",
									active && "bg-(--gk-accent) text-(--gk-accent-ink)",
									!filled && "text-(--gk-ink-muted) opacity-80"
								)}
								data-door={door.number}
								data-empty-door={filled ? undefined : ""}
								data-state={door.opened || active ? "open" : "closed"}
								onClick={(event) =>
									onActivate(door.number, event.currentTarget)
								}
								onKeyDown={onKeyDown}
								type="button"
							>
								{door.number}
								{door.mark === "stopped" ? (
									<Snowflake
										aria-hidden="true"
										className="size-3.5 text-(--gk-ink-muted)"
										data-stopped-mark=""
										strokeWidth={3}
									/>
								) : null}
								{door.opened && filled ? (
									<Check
										aria-hidden="true"
										className="size-3.5 text-(--gk-gold)"
										strokeWidth={3.5}
									/>
								) : null}
								{isToday ? (
									<span
										className="text-[10px] uppercase tracking-wide"
										data-today-word=""
									>
										Today
									</span>
								) : null}
							</button>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}
