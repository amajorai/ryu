import { motion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import {
	ACTION_CIRCLE,
	ACTION_OVERLAP,
	ISLAND_SPRING,
} from "./island-config.ts";

/** A single quick-action island in the dock stack. */
export interface IslandAction {
	icon: ReactNode;
	/** Stable key + accessible label (e.g. "Voice", "Attach"). */
	key: string;
	label: string;
	onClick: () => void;
}

// Each circle is a sibling shape of the detail island (so it sits outside the
// composer's clip and carries its own ring + shadow + blur), the same size and
// glass look as the logo circle. They overlap like an avatar group — the ring on
// each shows the stacking seam so part of every circle stays visible.
const DOCK_CIRCLE =
	"island-surface-height island-row-offset island-stack-layer relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-card/80 text-foreground shadow-xl ring-1 ring-border backdrop-blur-2xl transition-colors hover:bg-card/90";

interface IslandActionGeometry extends CSSProperties {
	"--island-row-offset": string;
	"--island-stack-layer": string;
	"--island-surface-height": string;
}

/**
 * The quick-action islands beside the composer input (text mode): a stacked
 * avatar-group of round islands the same size as the logo circle. Each splits out
 * with the same width-grow morph the detail island uses leaving idle (staggered so
 * they pop one by one), and overlaps the previous by {@link ACTION_OVERLAP} via a
 * negative margin. The leftmost (nearest the input) stacks on top.
 *
 * Kept as its own component so the actions map stays out of the Island render's
 * complexity budget — the same split the SuggestionActionPills made.
 */
export function IslandActionDock({ actions }: { actions: IslandAction[] }) {
	return (
		<div className="flex items-center">
			{actions.map((action, index) => {
				const geometry: IslandActionGeometry = {
					"--island-surface-height": `${ACTION_CIRCLE.height}px`,
					"--island-row-offset": `${index === 0 ? 0 : -ACTION_OVERLAP}px`,
					"--island-stack-layer": `${actions.length - index}`,
				};
				return (
					<motion.button
						animate={{ width: ACTION_CIRCLE.width, opacity: 1 }}
						aria-label={action.label}
						className={DOCK_CIRCLE}
						initial={{ width: 0, opacity: 0 }}
						key={action.key}
						onClick={action.onClick}
						style={geometry}
						title={action.label}
						transition={{ ...ISLAND_SPRING, delay: index * 0.05 }}
						type="button"
						whileHover={{ scale: 1.08 }}
					>
						{action.icon}
					</motion.button>
				);
			})}
		</div>
	);
}
