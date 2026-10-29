import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useRef } from "react";
import {
	PORTRAIT_SIZE,
	portraitCrop,
	portraitSprite,
} from "./world-2d-characters.ts";

/**
 * A villager in pixels, upscaled with nearest-neighbor filtering: the
 * sprite's head for hotbar slots, or the dedicated 48x48 dialogue bust
 * (whose mouth changes while the agent works). `agentId` null draws the
 * player.
 */
export function PixelPortrait({
	agentId,
	className,
	crop = "head",
	lookIndex = -1,
	scale,
	working = false,
}: {
	agentId: string | null;
	className?: string;
	crop?: "bust" | "head";
	/** The agent's place in the village (picks its outfit). */
	lookIndex?: number;
	/** Screen pixels per art pixel. */
	scale: number;
	/** The bust shows a busy face while the agent works. */
	working?: boolean;
}) {
	const ref = useRef<HTMLCanvasElement>(null);
	const width = crop === "bust" ? PORTRAIT_SIZE : 18;
	const height = crop === "bust" ? PORTRAIT_SIZE : 18;
	useEffect(() => {
		const canvas = ref.current;
		const context = canvas?.getContext("2d");
		if (!(canvas && context)) {
			return;
		}
		context.clearRect(0, 0, canvas.width, canvas.height);
		context.imageSmoothingEnabled = false;
		if (crop === "bust") {
			context.drawImage(
				portraitSprite(agentId, lookIndex, working).canvas,
				0,
				0
			);
			return;
		}
		const source = portraitCrop(agentId, "head", lookIndex);
		context.drawImage(
			source.canvas,
			source.x,
			source.y,
			source.w,
			source.h,
			0,
			0,
			source.w,
			source.h
		);
	}, [agentId, crop, lookIndex, working]);
	return (
		<span aria-hidden="true" className={cn("block", className)}>
			<canvas
				className="block [image-rendering:pixelated]"
				height={height}
				ref={ref}
				style={{ height: height * scale, width: width * scale }}
				width={width}
			/>
		</span>
	);
}
