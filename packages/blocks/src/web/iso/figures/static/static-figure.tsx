import type * as React from "react";
import "../../kit/iso.css";
import "../shared/quiet.css";
import { QuietSvg } from "../shared/quiet-svg.tsx";

export interface StaticDrawing {
	height: number;
	nodes: React.ReactNode[];
	width: number;
}

/**
 * A static product figure: drawn once on the server, sitting straight on the
 * page in the shared quiet look (no card, no words), following the site theme.
 * Decorative, so hidden from assistive tech like the drawings of the live
 * figures; the page copy beside it carries the meaning.
 */
export function StaticFigure({
	drawing,
	name,
}: {
	drawing: StaticDrawing;
	name: string;
}) {
	return (
		<figure className="iso iso-quiet" data-static-figure={name}>
			<QuietSvg height={drawing.height} width={drawing.width}>
				{drawing.nodes}
			</QuietSvg>
		</figure>
	);
}
