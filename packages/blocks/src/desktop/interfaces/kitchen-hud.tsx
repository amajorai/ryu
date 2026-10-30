import { ChefHat, Plus } from "lucide-react";
import { GameAction, GameTitlePlate } from "./game-hud.tsx";
import type { HudDensity } from "./kitchen-hud-layout.ts";
import type { KitchenService } from "./kitchen-model.ts";

export { ServiceClock } from "./kitchen-hud-clock.tsx";
export {
	type HudDensity,
	hudDensity,
	hudInsets,
	SELECTED,
} from "./kitchen-hud-layout.ts";
export { OrderRail } from "./kitchen-hud-rail.tsx";
export { ServiceScore } from "./kitchen-hud-score.tsx";

/**
 * The Kitchen HUD, on the shared game kit (game-shell.tsx): the title plate
 * top left, the order rail of paper tickets hanging from a steel bar across
 * the top, New order top right, today's tally bottom left and the service
 * clock bottom right. All of it floats over the full-bleed kitchen.
 */

/** Top left: the kitchen's name and what is going on. */
export function KitchenTitle({
	actStatus,
	density,
	service,
}: {
	/** The act layer's summary line, when the host sends asks. */
	actStatus?: string;
	density: HudDensity;
	service: KitchenService;
}) {
	const { totals } = service;
	const parts = [
		totals.ready > 0 ? `${totals.ready} ready to serve` : null,
		totals.cooking > 0 ? `${totals.cooking} cooking` : null,
		totals.burnt > 0 ? `${totals.burnt} burnt` : null,
	].filter(Boolean);
	return (
		<GameTitlePlate
			compact={density === "narrow"}
			icon={<ChefHat strokeWidth={2.25} />}
			keepStatus={actStatus !== undefined}
			status={
				actStatus ?? (parts.length > 0 ? parts.join(" · ") : "A quiet service")
			}
			title="Kitchen"
		/>
	);
}

/** Top right: the one primary action. */
export function NewOrderButton({
	density,
	disabled,
	onNewOrder,
}: {
	density: HudDensity;
	disabled: boolean;
	onNewOrder: () => void;
}) {
	return (
		<GameAction
			compact={density === "narrow"}
			disabled={disabled}
			icon={<Plus strokeWidth={3} />}
			label="New order"
			onClick={onNewOrder}
		/>
	);
}
