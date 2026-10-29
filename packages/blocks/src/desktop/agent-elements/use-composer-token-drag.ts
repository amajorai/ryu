import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { useCallback, useRef, useState } from "react";
import { moveComposerToken } from "./composer-attachment-mentions.ts";

/**
 * Click-and-drag for mention chips in the plain-textarea composer.
 *
 * The chips are painted by a `pointer-events-none` overlay under a transparent
 * textarea, so they can never receive pointer events themselves. Instead the
 * textarea hit-tests the overlay's chip rects on pointerdown, and the drop
 * position is measured from the overlay's text layout. Drops snap to word
 * boundaries so a chip can't land in the middle of a word.
 *
 * The overlay marks its runs with `data-composer-text-start` (plain text) and
 * `data-composer-token-start` / `data-composer-token-end` (chips), using
 * indices into the draft string.
 */

const DRAG_THRESHOLD_PX = 4;

interface DropCandidate {
	bottom: number;
	index: number;
	top: number;
	x: number;
}

/** Where the dragged chip would land, as a draft index, and how wide a gap
 *  the overlay should open there for it. */
export interface ComposerTokenDropGap {
	index: number;
	width: number;
}

interface ActiveDrag {
	candidates: DropCandidate[];
	dropIndex: number | null;
	end: number;
	gapWidth: number;
	moved: boolean;
	originX: number;
	originY: number;
	pointerId: number;
	start: number;
}

interface TokenHit {
	end: number;
	start: number;
}

function rectContains(rect: DOMRect, x: number, y: number): boolean {
	return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function hitToken(
	overlay: HTMLElement | null,
	x: number,
	y: number
): TokenHit | null {
	if (!overlay) {
		return null;
	}
	for (const element of overlay.querySelectorAll<HTMLElement>(
		"[data-composer-token-start]"
	)) {
		const rects = Array.from(element.getClientRects());
		if (rects.some((rect) => rectContains(rect, x, y))) {
			return {
				end: Number(element.dataset.composerTokenEnd),
				start: Number(element.dataset.composerTokenStart),
			};
		}
	}
	return null;
}

function charRect(node: Text, offset: number): DOMRect | undefined {
	const range = document.createRange();
	range.setStart(node, offset);
	range.setEnd(node, offset + 1);
	return range.getClientRects()[0];
}

/** Word-boundary drop positions, measured once per drag. */
function collectCandidates(overlay: HTMLElement): DropCandidate[] {
	const candidates: DropCandidate[] = [];
	const push = (index: number, x: number, rect: DOMRect) =>
		candidates.push({ bottom: rect.bottom, index, top: rect.top, x });
	for (const element of overlay.querySelectorAll<HTMLElement>(
		"[data-composer-text-start]"
	)) {
		const node = element.firstChild;
		if (!(node instanceof Text)) {
			continue;
		}
		const base = Number(element.dataset.composerTextStart);
		const value = node.data;
		for (let offset = 0; offset < value.length; offset += 1) {
			const char = value[offset] ?? "";
			const previous = value[offset - 1];
			const startsLine = offset === 0 || previous === "\n";
			const isSpace = /\s/.test(char);
			const isLast = offset === value.length - 1;
			if (!(startsLine || isSpace || isLast)) {
				continue;
			}
			const rect = charRect(node, offset);
			if (!rect) {
				continue;
			}
			if (startsLine || isSpace) {
				push(base + offset, rect.left, rect);
			}
			if ((isSpace && char !== "\n") || isLast) {
				push(base + offset + 1, rect.right, rect);
			}
		}
	}
	for (const element of overlay.querySelectorAll<HTMLElement>(
		"[data-composer-token-start]"
	)) {
		const rect = element.getBoundingClientRect();
		push(Number(element.dataset.composerTokenStart), rect.left, rect);
		push(Number(element.dataset.composerTokenEnd), rect.right, rect);
	}
	return candidates;
}

function nearestCandidate(
	candidates: DropCandidate[],
	x: number,
	y: number
): DropCandidate | null {
	let best: DropCandidate | null = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		const vertical =
			y < candidate.top ? candidate.top - y : Math.max(0, y - candidate.bottom);
		// A line match always beats a nearer x on another line.
		const score = vertical * 10_000 + Math.abs(x - candidate.x);
		if (score < bestScore) {
			best = candidate;
			bestScore = score;
		}
	}
	return best;
}

export function useComposerTokenDrag({
	enabled,
	input,
	overlayRef,
	setInput,
	textareaRef,
}: {
	enabled: boolean;
	input: string;
	overlayRef: RefObject<HTMLElement | null>;
	setInput: (value: string) => void;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
	const dragRef = useRef<ActiveDrag | null>(null);
	const [draggingStart, setDraggingStart] = useState<number | null>(null);
	const [dropGap, setDropGap] = useState<ComposerTokenDropGap | null>(null);

	const reset = useCallback(() => {
		dragRef.current = null;
		setDraggingStart(null);
		setDropGap(null);
	}, []);

	const onPointerDown = useCallback(
		(event: ReactPointerEvent<HTMLTextAreaElement>) => {
			if (!enabled || event.button !== 0) {
				return;
			}
			const hit = hitToken(overlayRef.current, event.clientX, event.clientY);
			if (!hit) {
				return;
			}
			// Keep the textarea from starting a text selection under the chip.
			event.preventDefault();
			event.currentTarget.setPointerCapture?.(event.pointerId);
			dragRef.current = {
				candidates: [],
				dropIndex: null,
				end: hit.end,
				gapWidth: 0,
				moved: false,
				originX: event.clientX,
				originY: event.clientY,
				pointerId: event.pointerId,
				start: hit.start,
			};
		},
		[enabled, overlayRef]
	);

	const onPointerMove = useCallback(
		(event: ReactPointerEvent<HTMLTextAreaElement>) => {
			const drag = dragRef.current;
			const textarea = event.currentTarget;
			if (!drag) {
				if (enabled) {
					const hit = hitToken(
						overlayRef.current,
						event.clientX,
						event.clientY
					);
					textarea.style.cursor = hit ? "grab" : "";
				}
				return;
			}
			if (drag.pointerId !== event.pointerId) {
				return;
			}
			if (!drag.moved) {
				const distance = Math.hypot(
					event.clientX - drag.originX,
					event.clientY - drag.originY
				);
				if (distance < DRAG_THRESHOLD_PX) {
					return;
				}
				const overlay = overlayRef.current;
				drag.moved = true;
				// Candidates are measured once, before any gap opens, so the
				// target stays put while the text after it slides aside.
				drag.candidates = overlay ? collectCandidates(overlay) : [];
				drag.gapWidth =
					overlay
						?.querySelector(`[data-composer-token-start="${drag.start}"]`)
						?.getBoundingClientRect().width ?? 0;
				setDraggingStart(drag.start);
			}
			textarea.style.cursor = "grabbing";
			const candidate = nearestCandidate(
				drag.candidates,
				event.clientX,
				event.clientY
			);
			if (!candidate) {
				drag.dropIndex = null;
				setDropGap(null);
				return;
			}
			drag.dropIndex = candidate.index;
			// Landing beside itself changes nothing, so no gap opens there.
			const inPlace =
				candidate.index >= drag.start && candidate.index <= drag.end;
			const next = inPlace
				? null
				: { index: candidate.index, width: drag.gapWidth };
			setDropGap((previous) =>
				previous?.index === next?.index ? previous : next
			);
		},
		[enabled, overlayRef]
	);

	const onPointerUp = useCallback(
		(event: ReactPointerEvent<HTMLTextAreaElement>) => {
			const drag = dragRef.current;
			if (!drag || drag.pointerId !== event.pointerId) {
				return;
			}
			const textarea = event.currentTarget;
			textarea.releasePointerCapture?.(event.pointerId);
			textarea.style.cursor = "";
			reset();
			let caret = drag.end;
			if (drag.moved && drag.dropIndex !== null) {
				const moved = moveComposerToken(
					input,
					drag.start,
					drag.end,
					drag.dropIndex
				);
				if (moved) {
					setInput(moved.text);
					caret = moved.caret;
				}
			}
			requestAnimationFrame(() => {
				const element = textareaRef.current;
				if (!element) {
					return;
				}
				element.focus();
				element.setSelectionRange(caret, caret);
			});
		},
		[input, reset, setInput, textareaRef]
	);

	const onPointerCancel = useCallback(
		(event: ReactPointerEvent<HTMLTextAreaElement>) => {
			event.currentTarget.style.cursor = "";
			reset();
		},
		[reset]
	);

	return {
		draggingStart,
		dropGap,
		handlers: { onPointerCancel, onPointerDown, onPointerMove, onPointerUp },
	};
}
