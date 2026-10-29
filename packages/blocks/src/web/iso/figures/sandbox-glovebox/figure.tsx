import { SandboxGloveboxArt } from "./art.tsx";
import "../../kit/iso.css";
import "../shared/quiet.css";
import "./sandbox-glovebox.css";

export interface SandboxGloveboxFigureProps {
	className?: string;
}

/**
 * Ryu's JavaScript sandbox as one quiet object: a sealed box whose only way in or out is
 * a single hatch, and one call passing through it. No visible text; the description is
 * for assistive tech only. Follows the site's light/dark theme.
 */
export function SandboxGloveboxFigure({
	className,
}: SandboxGloveboxFigureProps) {
	const base = "iso iso-quiet sgb";
	return (
		<figure className={className ? `${base} ${className}` : base}>
			<SandboxGloveboxArt />
		</figure>
	);
}
