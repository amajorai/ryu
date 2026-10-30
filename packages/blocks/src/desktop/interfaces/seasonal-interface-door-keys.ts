import { type KeyboardEvent, useCallback, useEffect } from "react";
import { GRID_SLOTS } from "./seasonal-grid.tsx";
import { DOOR_COUNT, doorInDirection } from "./seasonal-model.ts";

/** What the doors' keyboard and outside-click handling needs. */
export interface SeasonalDoorKeysArgs {
	closeGift: () => void;
	focusDoor: (number: number) => void;
	gift: number | null;
	setGift: (gift: number | null) => void;
}

/**
 * The doors' key handler (Escape closes the gift card; on the plain grid the
 * arrows, Home and End move between doors), and a click outside the card and
 * the doors puts the card away.
 */
export function useSeasonalDoorKeys({
	closeGift,
	focusDoor,
	gift,
	setGift,
}: SeasonalDoorKeysArgs) {
	const onDoorKeyDown = useCallback(
		(event: KeyboardEvent<HTMLButtonElement>) => {
			const number = Number(event.currentTarget.dataset.door);
			if (event.key === "Escape" && gift) {
				event.preventDefault();
				closeGift();
				return;
			}
			// In the diorama the stage already moved focus, in door order.
			if (event.defaultPrevented) {
				return;
			}
			// On the plain grid, left and right count through the numbers and
			// up and down move a row.
			const moves: Record<string, number | null> = {
				ArrowDown: doorInDirection(GRID_SLOTS, number, "down"),
				ArrowLeft: number - 1,
				ArrowRight: number + 1,
				ArrowUp: doorInDirection(GRID_SLOTS, number, "up"),
				End: DOOR_COUNT,
				Home: 1,
			};
			const target = moves[event.key];
			if (target === undefined) {
				return;
			}
			event.preventDefault();
			if (target !== null) {
				focusDoor(Math.min(DOOR_COUNT, Math.max(1, target)));
			}
		},
		[closeGift, focusDoor, gift]
	);

	// A click anywhere outside the card and the doors puts the card away.
	useEffect(() => {
		if (!gift) {
			return;
		}
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (
				target instanceof Element &&
				(target.closest("[data-seasonal-gift]") ||
					target.closest("[data-door]"))
			) {
				return;
			}
			// A click on another control keeps the focus it moves there; a click
			// on the picture or the page hands focus back to the door.
			if (
				target instanceof Element &&
				target.closest("button, a, input, textarea, select, [tabindex]")
			) {
				setGift(null);
				return;
			}
			closeGift();
		};
		window.addEventListener("pointerdown", onPointerDown);
		return () => window.removeEventListener("pointerdown", onPointerDown);
	}, [closeGift, gift]);

	return onDoorKeyDown;
}
