import type {
	AvatarPaintPalette,
	AvatarShape,
} from "@ryu/ui/components/avatar-parts.ts";
import { resolveAvatarPaint } from "@ryu/ui/components/avatar-parts.ts";

/* Draws validated avatar shapes (see avatar-parts.ts) as plain SVG elements.
   Every attribute comes from the inert shape grammar, and nothing is injected as
   markup, so a contributed part can only ever be geometry and colour. */

function AvatarShapeElement({
	shape,
	palette,
}: {
	shape: AvatarShape;
	palette: AvatarPaintPalette;
}) {
	const paint = {
		fill: resolveAvatarPaint(shape.fill, palette),
		opacity: shape.opacity,
		stroke: resolveAvatarPaint(shape.stroke, palette),
		strokeLinecap: shape.strokeLinecap,
		strokeLinejoin: shape.strokeLinejoin,
		strokeWidth: shape.strokeWidth,
		transform: shape.transform,
	};
	switch (shape.type) {
		case "path":
			return <path {...paint} d={shape.d} />;
		case "circle":
			return <circle {...paint} cx={shape.cx} cy={shape.cy} r={shape.r} />;
		case "ellipse":
			return (
				<ellipse
					{...paint}
					cx={shape.cx}
					cy={shape.cy}
					rx={shape.rx}
					ry={shape.ry}
				/>
			);
		case "rect":
			return (
				<rect
					{...paint}
					height={shape.height}
					rx={shape.rx}
					ry={shape.ry}
					width={shape.width}
					x={shape.x}
					y={shape.y}
				/>
			);
		case "polygon":
			return <polygon {...paint} points={shape.points} />;
		case "polyline":
			return <polyline {...paint} points={shape.points} />;
		case "line":
			return (
				<line
					{...paint}
					x1={shape.x1}
					x2={shape.x2}
					y1={shape.y1}
					y2={shape.y2}
				/>
			);
		default:
			return null;
	}
}

/** One contributed part, as a group of its shapes. */
export function AvatarShapes({
	shapes,
	palette,
	partId,
}: {
	partId: string;
	palette: AvatarPaintPalette;
	shapes: readonly AvatarShape[];
}) {
	return (
		<g data-avatar-part={partId}>
			{shapes.map((shape, index) => (
				<AvatarShapeElement
					// Shapes are an ordered, immutable list inside one part.
					key={`${partId}-${index}`}
					palette={palette}
					shape={shape}
				/>
			))}
		</g>
	);
}
