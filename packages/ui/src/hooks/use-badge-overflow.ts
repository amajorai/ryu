import { type RefObject, useEffect, useMemo, useState } from "react";

const badgeWidthCache = new Map<string, number>();

const DEFAULT_CONTAINER_PADDING = 16; // px-2 = 8px * 2
const DEFAULT_BADGE_GAP = 4; // gap-1 = 4px
const DEFAULT_OVERFLOW_BADGE_WIDTH = 40; // Approximate width of "+N" badge

interface MeasureBadgeWidthProps {
	cacheKey: string;
	className?: string;
	iconSize?: number;
	label: string;
	maxWidth?: number;
}

function measureBadgeWidth({
	label,
	cacheKey,
	iconSize,
	maxWidth,
	className,
}: MeasureBadgeWidthProps): number {
	const cached = badgeWidthCache.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}

	const measureEl = document.createElement("div");
	measureEl.className = `inline-flex items-center rounded-md border px-1.5 text-xs font-semibold h-5 gap-1 shrink-0 absolute invisible pointer-events-none ${
		className ?? ""
	}`;
	measureEl.style.whiteSpace = "nowrap";

	if (iconSize) {
		const icon = document.createElement("span");
		icon.className = "shrink-0";
		icon.style.width = `${iconSize}px`;
		icon.style.height = `${iconSize}px`;
		measureEl.appendChild(icon);
	}

	if (maxWidth) {
		const text = document.createElement("span");
		text.className = "truncate";
		text.style.maxWidth = `${maxWidth}px`;
		text.textContent = label;
		measureEl.appendChild(text);
	} else {
		measureEl.textContent = label;
	}

	document.body.appendChild(measureEl);
	const width = measureEl.offsetWidth;
	document.body.removeChild(measureEl);

	badgeWidthCache.set(cacheKey, width);
	return width;
}

interface UseBadgeOverflowProps<T> {
	badgeGap?: number;
	cacheKeyPrefix?: string;
	className?: string;
	containerPadding?: number;
	containerRef: RefObject<HTMLElement | null>;
	getLabel: (item: T) => string;
	iconSize?: number;
	items: T[];
	lineCount: number;
	maxWidth?: number;
	overflowBadgeWidth?: number;
}

interface UseBadgeOverflowReturn<T> {
	containerWidth: number;
	hiddenCount: number;
	visibleItems: T[];
}

export function useBadgeOverflow<T>({
	items,
	getLabel,
	containerRef,
	lineCount,
	cacheKeyPrefix = "",
	containerPadding = DEFAULT_CONTAINER_PADDING,
	badgeGap = DEFAULT_BADGE_GAP,
	overflowBadgeWidth = DEFAULT_OVERFLOW_BADGE_WIDTH,
	iconSize,
	maxWidth,
	className,
}: UseBadgeOverflowProps<T>): UseBadgeOverflowReturn<T> {
	const [containerWidth, setContainerWidth] = useState(0);

	useEffect(() => {
		if (!containerRef.current) {
			return;
		}

		function measureWidth() {
			if (containerRef.current) {
				const width = containerRef.current.clientWidth - containerPadding;
				setContainerWidth(width);
			}
		}

		measureWidth();

		const resizeObserver = new ResizeObserver(measureWidth);
		resizeObserver.observe(containerRef.current);

		return () => {
			resizeObserver.disconnect();
		};
	}, [containerRef, containerPadding]);

	const result = useMemo(() => {
		if (!containerWidth || items.length === 0) {
			return { visibleItems: items, hiddenCount: 0, containerWidth };
		}

		let currentLineWidth = 0;
		let currentLine = 1;
		const visible: T[] = [];

		for (const item of items) {
			const label = getLabel(item);
			const cacheKey = cacheKeyPrefix ? `${cacheKeyPrefix}:${label}` : label;
			const badgeWidth = measureBadgeWidth({
				label,
				cacheKey,
				iconSize,
				maxWidth,
				className,
			});
			const widthWithGap = badgeWidth + badgeGap;

			if (currentLineWidth + widthWithGap <= containerWidth) {
				currentLineWidth += widthWithGap;
				visible.push(item);
			} else if (currentLine < lineCount) {
				currentLine++;
				currentLineWidth = widthWithGap;
				visible.push(item);
			} else {
				if (
					currentLineWidth + overflowBadgeWidth > containerWidth &&
					visible.length > 0
				) {
					visible.pop();
				}

				break;
			}
		}

		return {
			visibleItems: visible,
			hiddenCount: Math.max(0, items.length - visible.length),
			containerWidth,
		};
	}, [
		items,
		getLabel,
		containerWidth,
		lineCount,
		cacheKeyPrefix,
		iconSize,
		maxWidth,
		className,
		badgeGap,
		overflowBadgeWidth,
	]);

	return result;
}

export function clearBadgeWidthCache(): void {
	badgeWidthCache.clear();
}
