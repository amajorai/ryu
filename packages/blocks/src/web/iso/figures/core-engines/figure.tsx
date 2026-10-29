import { CoreEnginesArt } from "./art.tsx";
import "../../kit/iso.css";
import "../shared/quiet.css";
import "./core-engines.css";

export interface CoreEnginesFigureProps {
	className?: string;
}

/**
 * The Core engines figure: a quiet shelf of engines and the one in the player, drawn
 * straight on the page with no frame and no visible text. The description is for
 * assistive tech only. Follows the site's light/dark theme.
 */
export function CoreEnginesFigure({ className }: CoreEnginesFigureProps) {
	const base = "iso iso-quiet ce";
	return (
		<figure className={className ? `${base} ${className}` : base}>
			<CoreEnginesArt />
		</figure>
	);
}
