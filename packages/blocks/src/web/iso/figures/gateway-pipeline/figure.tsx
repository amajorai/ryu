import { GatewayPipelineArt } from "./art.tsx";
import "../../kit/iso.css";
import "../shared/quiet.css";
import "./gateway-pipeline.css";

export interface GatewayPipelineFigureProps {
	className?: string;
}

/**
 * Ryu Gateway's request pipeline as one quiet object: eight gates over a thin track, the
 * pinned four taller than the swappable four, and one request walking through them in
 * order. No visible text; the description is for assistive tech only. Follows the site's
 * light/dark theme.
 */
export function GatewayPipelineFigure({
	className,
}: GatewayPipelineFigureProps) {
	const base = "iso iso-quiet gwp";
	return (
		<figure className={className ? `${base} ${className}` : base}>
			<GatewayPipelineArt />
		</figure>
	);
}
