"use client";

import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";

/**
 * Measure the textarea at the compact row's stable width. Measuring a detached
 * clone avoids a layout feedback loop: once the real editor moves into the wider
 * full layout, its own `scrollHeight` can fall back to one line and otherwise
 * make the composer bounce between layouts.
 */
function textareaWrapsAtWidth(
	textarea: HTMLTextAreaElement,
	value: string,
	width: number
): boolean {
	if (!(value && width > 0)) {
		return false;
	}
	const probe = textarea.cloneNode(false);
	if (!(probe instanceof HTMLTextAreaElement)) {
		return value.includes("\n");
	}
	probe.removeAttribute("id");
	probe.removeAttribute("name");
	probe.setAttribute("aria-hidden", "true");
	probe.tabIndex = -1;
	probe.style.position = "fixed";
	probe.style.top = "0";
	probe.style.left = "-10000px";
	probe.style.width = `${width}px`;
	probe.style.height = "0";
	probe.style.minHeight = "0";
	probe.style.maxHeight = "none";
	probe.style.overflow = "hidden";
	probe.style.pointerEvents = "none";
	probe.style.visibility = "hidden";
	probe.value = "";
	document.body.append(probe);
	try {
		const singleLineHeight = probe.scrollHeight;
		probe.value = value;
		return probe.scrollHeight > singleLineHeight + 1;
	} finally {
		probe.remove();
	}
}

const useSafeLayoutEffect =
	globalThis.window === undefined ? useEffect : useLayoutEffect;

/** Report the total composer height to a compact host surface. */
export function useComposerHeightReport(
	containerRef: RefObject<HTMLDivElement | null>,
	onHeightChange: ((height: number) => void) | undefined
) {
	useEffect(() => {
		if (!onHeightChange) {
			return;
		}
		const element = containerRef.current;
		if (!element) {
			return;
		}
		const report = () => onHeightChange(element.offsetHeight);
		report();
		if (globalThis.ResizeObserver === undefined) {
			return;
		}
		const observer = new ResizeObserver(report);
		observer.observe(element);
		return () => observer.disconnect();
	}, [onHeightChange]);
}

/**
 * Grow/shrink the plain textarea with its content and track whether a compact
 * draft wraps (which moves it out of the single controls row).
 */
export function useComposerTextareaAutoResize({
	compact,
	containerRef,
	input,
	isCompactSingleRow,
	isExpanded,
	markdownComposer,
	setIsCompactTextareaMultiline,
	textareaRef,
}: {
	compact?: boolean;
	containerRef: RefObject<HTMLDivElement | null>;
	input: string;
	isCompactSingleRow: boolean;
	isExpanded: boolean;
	markdownComposer: boolean;
	setIsCompactTextareaMultiline: Dispatch<SetStateAction<boolean>>;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
	const compactTextareaWidthRef = useRef<number | null>(null);
	// Auto-resize textarea. `measureTextareaRef` holds the latest measurement and
	// `measuredTextareaWidthRef` the width it measured at, so the pane observer
	// below can repeat it without adding dependencies here.
	const measureTextareaRef = useRef<() => void>(() => undefined);
	const measuredTextareaWidthRef = useRef(0);
	// What the last measurement sized the box for. Typing at the end of the
	// draft can only keep or grow its height, so that common keystroke skips
	// the collapse-to-0 pass: one layout read instead of a write/read/write
	// thrash per key.
	const lastMeasuredRef = useRef<{
		element: HTMLTextAreaElement;
		expanded: boolean;
		input: string;
	} | null>(null);
	useSafeLayoutEffect(() => {
		const measure = (collapse = true) => {
			if (markdownComposer) {
				setIsCompactTextareaMultiline(false);
				return;
			}
			const el = textareaRef.current;
			if (!el) {
				return;
			}
			const maxHeight = isExpanded ? 360 : 120;
			const minHeight = isExpanded ? 280 : 0;
			// Read the width before any write: the box's height never changes it.
			const renderedWidth = el.getBoundingClientRect().width;
			const last = lastMeasuredRef.current;
			// An empty box was sized for its placeholder, which can wrap onto
			// more lines than the first typed characters: that keystroke must
			// collapse, or the box keeps the placeholder's height.
			const onlyGrew =
				!collapse &&
				last !== null &&
				// A remounted textarea has none of the height set below.
				last.element === el &&
				last.input !== "" &&
				last.expanded === isExpanded &&
				renderedWidth === measuredTextareaWidthRef.current &&
				input.startsWith(last.input);
			if (!onlyGrew) {
				el.style.height = "0";
			}
			// Uncollapsed, this is max(content, current height), and the current
			// height already fits everything but the appended text.
			const contentHeight = el.scrollHeight;
			const nextHeight = Math.min(
				Math.max(contentHeight, minHeight),
				maxHeight
			);
			el.style.height = `${nextHeight}px`;
			el.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
			el.style.overflowX = "hidden";
			measuredTextareaWidthRef.current = renderedWidth;
			lastMeasuredRef.current = { element: el, expanded: isExpanded, input };

			if (!compact) {
				setIsCompactTextareaMultiline(false);
				return;
			}
			if (isCompactSingleRow && renderedWidth > 0) {
				compactTextareaWidthRef.current = renderedWidth;
			}
			const compactWidth = compactTextareaWidthRef.current;
			if (compactWidth && compactWidth > 0) {
				const nextMultiline = textareaWrapsAtWidth(el, input, compactWidth);
				setIsCompactTextareaMultiline((current) =>
					current === nextMultiline ? current : nextMultiline
				);
			}
		};
		measureTextareaRef.current = measure;
		measure(false);
		// Re-measure on every value change so the textarea grows/shrinks with its
		// content (one row by default, expanding up to the 120px cap, or the
		// roomier expanded cap). Without
		// `input` in the deps this only ran on mount and the box never resized.
		// A repo-wide lint/format sweep (9fed37659) emptied this array once already
		// and the composer went back to a permanently one-line box — `input` is
		// load-bearing, not a lint artefact.
	}, [compact, input, isCompactSingleRow, isExpanded, markdownComposer]);

	// The measurement above reads 0 whenever the composer is not rendered: a
	// retained tab mounts through a detached portal container and is parked
	// under `display: none` while another tab is focused. None of its
	// dependencies change when the tab is revealed, so it would keep a 0px
	// textarea. Watch the always-mounted composer root and repeat the
	// measurement when the textarea's rendered width no longer matches the
	// width it was measured at: hidden to shown, or a pane resize that re-wraps
	// the draft. Height-only changes (including the ones this measurement
	// causes) are ignored, and the work runs in the next frame so it never
	// resizes an observed element inside the observer callback.
	useEffect(() => {
		const root = containerRef.current;
		if (!root || globalThis.ResizeObserver === undefined) {
			return;
		}
		let frame = 0;
		const observer = new ResizeObserver(() => {
			const textarea = textareaRef.current;
			if (
				!textarea ||
				textarea.getBoundingClientRect().width ===
					measuredTextareaWidthRef.current
			) {
				return;
			}
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => measureTextareaRef.current());
		});
		observer.observe(root);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	}, []);
}
