"use client";

import {
	Children,
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	isNativeBigInt,
	isNativeNumber,
	isNativeText,
} from "../lib/native-primitive-observation.ts";
import { cn } from "../lib/utils.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

const SCROLL_MS_PER_PIXEL = 26;
const MIN_SCROLL_TRAVEL_MS = 1600;
const SCROLL_EDGE_PADDING_PX = 6;

interface FadeOverflowState<T extends HTMLElement = HTMLSpanElement> {
	clipped: boolean;
	clipRef: RefObject<T | null>;
	innerRef: RefObject<HTMLSpanElement | null>;
	ref: RefObject<T | null>;
	title?: string;
}

/**
 * Measure a single-line element and expose the state needed to dissolve its
 * trailing edge only while the rendered content is clipped.
 *
 * The mutation observer matters for controls such as SelectValue: Base UI
 * updates the selected label inside the same element without changing the
 * element's own size, so ResizeObserver alone would miss the new overflow.
 */
export function useFadeOverflow<
	T extends HTMLElement = HTMLSpanElement,
>(): FadeOverflowState<T> {
	const clipRef = useRef<T>(null);
	const innerRef = useRef<HTMLSpanElement>(null);
	const [clipped, setClipped] = useState(false);
	const [title, setTitle] = useState<string>();

	useLayoutEffect(() => {
		const clip = clipRef.current;
		const inner = innerRef.current;
		if (!(clip && inner)) {
			return;
		}

		// Sub-pixel widths make `scrollWidth > clientWidth` fire on labels that fit
		// exactly, so require a whole pixel of overflow before masking.
		const measure = () => {
			const nextClipped = inner.scrollWidth - clip.clientWidth > 1;
			const nextTitle = inner.textContent?.trim() || undefined;
			setClipped((current) =>
				current === nextClipped ? current : nextClipped
			);
			setTitle((current) => (current === nextTitle ? current : nextTitle));
		};

		measure();
		const resizeObserver = new ResizeObserver(measure);
		const mutationObserver = new MutationObserver(measure);
		resizeObserver.observe(clip);
		resizeObserver.observe(inner);
		mutationObserver.observe(clip, {
			characterData: true,
			childList: true,
			subtree: true,
		});

		return () => {
			resizeObserver.disconnect();
			mutationObserver.disconnect();
		};
	}, []);

	return {
		clipped,
		clipRef,
		innerRef,
		ref: clipRef,
		...(title === undefined ? undefined : { title }),
	};
}

/**
 * A one-line label that dissolves into the background when it is too long for
 * its box, then gently auto-scrolls on hover/focus so the full value can be
 * read. Clipped values also expose the same full value in the shared tooltip.
 */
export function FadeOverflowText({
	children,
	className,
	"data-slot": dataSlot,
}: {
	children: ReactNode;
	className?: string;
	"data-slot"?: string;
}) {
	const { clipped, clipRef, innerRef, title } =
		useFadeOverflow<HTMLSpanElement>();
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	const isActive = hovered || focused;

	useEffect(() => {
		const clip = clipRef.current;
		const inner = innerRef.current;
		if (!(isActive && clipped && clip && inner)) {
			return;
		}

		const prefersReducedMotion = window.matchMedia(
			"(prefers-reduced-motion: reduce)"
		).matches;
		if (prefersReducedMotion) {
			return;
		}

		const distance =
			inner.scrollWidth - clip.clientWidth + SCROLL_EDGE_PADDING_PX;
		if (distance <= SCROLL_EDGE_PADDING_PX) {
			return;
		}

		const animation = inner.animate(
			[
				{ transform: "translateX(0)", offset: 0 },
				{ transform: "translateX(0)", offset: 0.2 },
				{ transform: `translateX(-${distance}px)`, offset: 0.8 },
				{ transform: `translateX(-${distance}px)`, offset: 1 },
			],
			{
				duration: Math.max(
					MIN_SCROLL_TRAVEL_MS,
					Math.round(distance * SCROLL_MS_PER_PIXEL)
				),
				direction: "alternate",
				easing: "ease-in-out",
				iterations: Number.POSITIVE_INFINITY,
			}
		);

		return () => animation.cancel();
	}, [clipped, clipRef, focused, hovered, innerRef, isActive]);

	const label = (
		<span
			className={cn(
				"block min-w-0 overflow-hidden whitespace-nowrap",
				clipped && "fade-text-edge",
				className
			)}
			data-slot={dataSlot}
			onBlur={() => setFocused(false)}
			onFocus={() => setFocused(true)}
			onPointerEnter={() => setHovered(true)}
			onPointerLeave={() => setHovered(false)}
			ref={clipRef}
		>
			<span className="inline-block max-w-none align-bottom" ref={innerRef}>
				{children}
			</span>
		</span>
	);

	return (
		<Tooltip>
			<TooltipTrigger render={label} />
			{clipped && title ? (
				<TooltipContent align="start">{title}</TooltipContent>
			) : null}
		</Tooltip>
	);
}

/**
 * Wrap only direct text children in the shared measured label. Icons and
 * composed label elements stay untouched, so a control's affordances never
 * dissolve along with its text.
 */
export function FadeOverflowTextChildren({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return Children.map(children, (child, index) => {
		const text = isNativeText(child)
			? child
			: isNativeNumber(child) || isNativeBigInt(child)
				? String(child)
				: undefined;

		if (text === undefined || text.trim().length === 0) {
			return child;
		}

		return (
			<FadeOverflowText
				className={cn("min-w-0 max-w-full", className)}
				key={`fade-overflow-${index}`}
			>
				{text}
			</FadeOverflowText>
		);
	});
}
