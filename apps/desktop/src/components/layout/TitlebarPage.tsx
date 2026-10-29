import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties as LayoutCSSProperties } from "react";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import layoutStyles from "./TitlebarPage.module.css";

/** Expand top-aligned scrollports into the titlebar inset without moving their
 * initial content. Intermediate clipping wrappers need the same overlap so
 * their overflow:hidden cannot cut off the glass backdrop. Fixed toolbars and
 * nested panels below them retain their own viewport. */
export function overlapTitlebarScrollports(frame: HTMLElement, inset: number) {
	const restores: (() => void)[] = [];
	if (inset <= 0 || frame.getClientRects().length === 0) {
		return () => {};
	}
	const scale = frame.getBoundingClientRect().height / frame.offsetHeight;
	const contentTop = frame.getBoundingClientRect().top + inset * scale;
	const paths = new Set<HTMLElement>();
	const scrollports = new Set<HTMLElement>();
	for (const element of frame.querySelectorAll<HTMLElement>("*")) {
		// Read only the edge candidates, not every row in a long list.
		if ([...scrollports].some((parent) => parent.contains(element))) {
			continue;
		}
		if (Math.abs(element.getBoundingClientRect().top - contentTop) > 1) {
			continue;
		}
		const style = getComputedStyle(element);
		if (
			!/^(auto|scroll)$/.test(style.overflowY) ||
			element.clientHeight === 0
		) {
			continue;
		}
		scrollports.add(element);
		for (
			let node: HTMLElement | null = element;
			node && node !== frame;
			node = node.parentElement
		) {
			paths.add(node);
		}
	}
	// Read all geometry before changing any of it.
	const geometry = [...paths].map((element) => {
		const style = getComputedStyle(element);
		return {
			element,
			margin: style.marginTop,
			padding: style.paddingTop,
			height: style.height,
			boxSizing: style.boxSizing,
		};
	});
	for (const { element, margin, padding, height, boxSizing } of geometry) {
		const properties = [
			"margin-top",
			"padding-top",
			"height",
			"flex-shrink",
			"--scroll-fade-t-size",
		];
		const saved = properties.map((name) => [
			name,
			element.style.getPropertyValue(name),
			element.style.getPropertyPriority(name),
		]);
		restores.push(() => {
			for (const [name, value, priority] of saved) {
				if (value) {
					element.style.setProperty(name, value, priority);
				} else {
					element.style.removeProperty(name);
				}
			}
		});
		element.style.marginTop = `calc(${margin} - ${inset}px)`;
		element.style.paddingTop = `calc(${padding} + ${inset}px)`;
		if (boxSizing === "border-box") {
			element.style.height = `calc(${height} + ${inset}px)`;
		}
		element.style.flexShrink = "0";
		if (scrollports.has(element)) {
			element.style.setProperty("--scroll-fade-t-size", "0px");
		}
	}
	return () => {
		for (const restore of restores) {
			restore();
		}
	};
}

export function TitlebarPage({
	children,
	inset,
	selfInset = false,
}: {
	children: ReactNode;
	inset: number;
	/** Chat's virtual message list owns its inset; keep its composer fixed. */
	selfInset?: boolean;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const frame = ref.current;
		if (!frame || selfInset || inset === 0) {
			return;
		}
		let restore = () => {};
		let scheduled = 0;
		const sync = () => {
			restore();
			restore = overlapTitlebarScrollports(
				frame,
				Number.parseFloat(getComputedStyle(frame).paddingTop)
			);
		};
		const schedule = () => {
			cancelAnimationFrame(scheduled);
			scheduled = requestAnimationFrame(sync);
		};
		sync();
		// Lazy routes, empty/loading transitions and hidden tabs all share this
		// boundary. No scroll listener or per-frame React updates are needed.
		const resize = new ResizeObserver(schedule);
		resize.observe(frame);
		const mutation = new MutationObserver(schedule);
		mutation.observe(frame, { childList: true, subtree: true });
		return () => {
			cancelAnimationFrame(scheduled);
			resize.disconnect();
			mutation.disconnect();
			restore();
		};
	}, [inset, selfInset]);
	const cssVariables1: LayoutCssVariables = {
		"--ryu-titlebar-inset": `calc(var(--spacing) * ${inset / 4})`,
		"--desktop-inline1-padding-Top": selfInset
			? "0px"
			: `calc(var(--spacing) * ${inset / 4})`,
	};
	return (
		<div
			className={cn(
				"relative min-h-0 flex-1 overflow-auto",
				layoutStyles.inline1
			)}
			data-titlebar-page=""
			ref={ref}
			style={cssVariables1}
		>
			{children}
		</div>
	);
}

interface LayoutCssVariables extends LayoutCSSProperties {
	"--desktop-inline1-padding-Top"?: string | number;
	"--ryu-titlebar-inset"?: string | number;
}
