import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils.ts";

interface AutoScrollTextProps {
	/** Rendered content — usually the same text, optionally with inline accents. */
	children: ReactNode;
	/** Classes for the clipping line (sizing + color), e.g. "flex-1 text-muted-foreground". */
	className?: string;
	/** Full text for the hover tooltip (shown only when the line is clipped). */
	title: string;
}

/**
 * A legacy single-line label for values that can include inline accents. It
 * stays static so shared `FadeOverflowText` is the only hover-scroll owner in
 * controls; clipped values still expose the full value in a tooltip.
 */
export function AutoScrollText({
	title,
	children,
	className,
}: AutoScrollTextProps) {
	const textRef = useRef<HTMLSpanElement>(null);
	const [overflowing, setOverflowing] = useState(false);

	useEffect(() => {
		const inner = textRef.current;
		const clip = inner?.parentElement;
		if (!(inner && clip)) {
			return;
		}

		const measure = () => {
			setOverflowing(inner.scrollWidth - clip.clientWidth > 1);
		};

		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(clip);
		observer.observe(inner);
		return () => {
			observer.disconnect();
		};
		// `title` is the content: a new string re-measures the label. The
		// ResizeObserver alone misses a text swap that keeps the same box width.
	}, [title]);

	const line = (
		<span
			className={cn(
				"block min-w-0 overflow-hidden whitespace-nowrap",
				className
			)}
		>
			<span
				className="inline-block max-w-full truncate align-bottom"
				ref={textRef}
			>
				{children}
			</span>
		</span>
	);

	return (
		<Tooltip>
			<TooltipTrigger render={line} />
			{overflowing ? <TooltipContent>{title}</TooltipContent> : null}
		</Tooltip>
	);
}
