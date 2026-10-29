import { cn } from "@ryu/ui/lib/utils";
import type { ThreadStatus } from "@ryuhq/protocol/interfaces";
import { type PointerEvent, useRef } from "react";
import {
	type CanvasPoint,
	type CanvasRect,
	unionRects,
} from "./canvas-model.ts";

export const MINIMAP_WIDTH = 144;
export const MINIMAP_HEIGHT = 88;
const WIDTH = MINIMAP_WIDTH;
const HEIGHT = MINIMAP_HEIGHT;
const INSET = 6;

/**
 * Quiet silhouettes, like tldraw's minimap: flat tints with no strokes. A
 * failure is the only strong mark. "Your turn" is a neutral foreground tint
 * and a live run the success tint, so the two stay apart in themes whose
 * primary is close to success (green-light).
 */
const FILL: Record<ThreadStatus, string> = {
	attention: "fill-destructive/60",
	quiet: "fill-foreground/10",
	waiting: "fill-foreground/15",
	working: "fill-success/45",
	"your-turn": "fill-foreground/35",
};

export interface MinimapCard {
	id: string;
	rect: CanvasRect;
	selected: boolean;
	status: ThreadStatus;
}

interface MinimapProjection {
	box: CanvasRect;
	offsetX: number;
	offsetY: number;
	scale: number;
}

/** A little room around everything, so the viewport rect never hugs the edge. */
const PAD = 0.02;

function project(content: CanvasRect, visible: CanvasRect): MinimapProjection {
	const union = unionRects([content, visible]);
	const box = {
		height: union.height * (1 + PAD * 2),
		width: union.width * (1 + PAD * 2),
		x: union.x - union.width * PAD,
		y: union.y - union.height * PAD,
	};
	const scale = Math.min(
		(WIDTH - INSET * 2) / Math.max(1, box.width),
		(HEIGHT - INSET * 2) / Math.max(1, box.height)
	);
	return {
		box,
		offsetX: (WIDTH - box.width * scale) / 2,
		offsetY: (HEIGHT - box.height * scale) / 2,
		scale,
	};
}

/**
 * A corner overview: frames, stickies as status tints, and the viewport.
 * Press or drag anywhere on it to move the view there. The map itself is
 * pointer-only and hidden from assistive tech: "Zoom to fit", the arrow keys
 * and the toolbar do the same job from the keyboard, and the toolbar's
 * "Minimap" button shows and hides it.
 */
export function CanvasMinimap({
	cards,
	content,
	frames,
	onNavigate,
	visible,
}: {
	cards: MinimapCard[];
	content: CanvasRect;
	frames: CanvasRect[];
	onNavigate: (worldPoint: CanvasPoint) => void;
	visible: CanvasRect;
}) {
	const draggingRef = useRef(false);
	const projection = project(content, visible);
	const toLocal = (rect: CanvasRect) => ({
		height: Math.max(1.5, rect.height * projection.scale),
		width: Math.max(1.5, rect.width * projection.scale),
		x: (rect.x - projection.box.x) * projection.scale + projection.offsetX,
		y: (rect.y - projection.box.y) * projection.scale + projection.offsetY,
	});
	const navigate = (event: PointerEvent<HTMLDivElement>) => {
		const bounds = event.currentTarget.getBoundingClientRect();
		const localX = ((event.clientX - bounds.left) / bounds.width) * WIDTH;
		const localY = ((event.clientY - bounds.top) / bounds.height) * HEIGHT;
		onNavigate({
			x: (localX - projection.offsetX) / projection.scale + projection.box.x,
			y: (localY - projection.offsetY) / projection.scale + projection.box.y,
		});
	};
	const view = toLocal(visible);
	// With the whole board already on screen the viewport rect says nothing:
	// it fades back to a hairline.
	const allInView =
		visible.x <= content.x &&
		visible.y <= content.y &&
		visible.x + visible.width >= content.x + content.width &&
		visible.y + visible.height >= content.y + content.height;
	return (
		<div
			className="pointer-events-auto relative overflow-hidden rounded-xl border border-border bg-card shadow-foreground/5 shadow-sm"
			data-testid="canvas-minimap"
			style={{ height: HEIGHT, width: WIDTH }}
		>
			<div
				aria-hidden="true"
				className="size-full cursor-pointer touch-none"
				onPointerDown={(event) => {
					event.stopPropagation();
					draggingRef.current = true;
					event.currentTarget.setPointerCapture(event.pointerId);
					navigate(event);
				}}
				onPointerMove={(event) => {
					if (draggingRef.current) {
						navigate(event);
					}
				}}
				onPointerUp={(event) => {
					draggingRef.current = false;
					event.currentTarget.releasePointerCapture(event.pointerId);
				}}
			>
				<svg
					aria-hidden="true"
					className="block size-full"
					viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
				>
					{frames.map((frame) => {
						const local = toLocal(frame);
						return (
							<rect
								className="fill-foreground/[0.06] stroke-none"
								height={local.height}
								key={`${frame.x}:${frame.y}`}
								rx={2}
								width={local.width}
								x={local.x}
								y={local.y}
							/>
						);
					})}
					{cards.map((card) => {
						const local = toLocal(card.rect);
						return (
							<rect
								className={cn(
									FILL[card.status],
									card.selected ? "stroke-foreground" : "stroke-none"
								)}
								height={local.height}
								key={card.id}
								rx={1}
								strokeWidth={1}
								width={local.width}
								x={local.x}
								y={local.y}
							/>
						);
					})}
					<rect
						className={
							allInView
								? "fill-none stroke-foreground/15"
								: "fill-foreground/[0.04] stroke-foreground/45"
						}
						height={view.height}
						rx={3}
						strokeWidth={1}
						width={view.width}
						x={view.x}
						y={view.y}
					/>
				</svg>
			</div>
		</div>
	);
}
