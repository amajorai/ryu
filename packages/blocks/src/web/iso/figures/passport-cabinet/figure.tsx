import { PassportCabinetArt } from "./art.tsx";
import "../../kit/iso.css";
import "../shared/quiet.css";
import "./passport-cabinet.css";

export interface PassportCabinetFigureProps {
	className?: string;
}

/**
 * Ryu Passport's credential vault as a cabinet of keys: one key is taken to the site and
 * only the page reaches the agent. No words around it: the description is for assistive
 * tech only. Follows the site's light/dark theme.
 */
export function PassportCabinetFigure({
	className,
}: PassportCabinetFigureProps) {
	const base = "iso iso-quiet ppc";
	return (
		<figure className={className ? `${base} ${className}` : base}>
			<PassportCabinetArt />
		</figure>
	);
}
