"use client";

import { useEffect } from "react";

export function useStageBodyLock(
	frameRef: React.RefObject<HTMLDivElement | null>,
	releaseBodyLockRef: React.RefObject<(() => void) | null>
) {
	useEffect(() => {
		const frame = frameRef.current;
		const previous =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		const body = document.body;
		const overflow = body.style.overflow;
		const padding = body.style.paddingInlineEnd;
		// The viewport scrollbar sits at the inline end (left in right-to-left
		// pages), so the padding that stands in for it does too.
		const gap = window.innerWidth - document.documentElement.clientWidth;
		const base =
			Number.parseFloat(getComputedStyle(body).paddingInlineEnd) || 0;
		body.style.overflow = "hidden";
		if (gap > 0) {
			body.style.paddingInlineEnd = `${base + gap}px`;
		}
		frame?.focus({ preventScroll: true });
		let released = false;
		const release = () => {
			if (released) {
				return;
			}
			released = true;
			body.style.overflow = overflow;
			body.style.paddingInlineEnd = padding;
			if (previous?.isConnected) {
				previous.focus({ preventScroll: true });
			}
		};
		releaseBodyLockRef.current = release;
		return () => {
			release();
			if (releaseBodyLockRef.current === release) {
				releaseBodyLockRef.current = null;
			}
		};
	}, [frameRef]);
}

export function useStageKeyboard({
	shellRef,
	zoomed,
	hasMultipleImages,
	goToPrevious,
	goToNext,
	onClose,
}: {
	goToNext: () => void;
	goToPrevious: () => void;
	hasMultipleImages: boolean;
	onClose: () => void;
	shellRef: React.RefObject<HTMLDivElement | null>;
	zoomed: boolean;
}) {
	useEffect(() => {
		const shell = shellRef.current;
		if (!shell) {
			return;
		}

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (zoomed) {
					return;
				}
				e.preventDefault();
				onClose();
				return;
			}
			if (!zoomed && hasMultipleImages) {
				// The arrow key toward the inline start goes back: ← in left-to-right
				// layouts, → in right-to-left ones, matching the button positions.
				const rtl = getComputedStyle(shell).direction === "rtl";
				const previousKey = rtl ? "ArrowRight" : "ArrowLeft";
				const nextKey = rtl ? "ArrowLeft" : "ArrowRight";
				if (e.key === previousKey) {
					e.preventDefault();
					goToPrevious();
					return;
				}
				if (e.key === nextKey) {
					e.preventDefault();
					goToNext();
					return;
				}
			}
			if (e.key !== "Tab") {
				return;
			}
			const nodes = Array.from(
				shell.querySelectorAll<HTMLElement>('[data-lightbox-focus="1"]')
			);
			if (nodes.length === 0) {
				return;
			}
			e.preventDefault();
			const here =
				document.activeElement instanceof HTMLElement
					? nodes.indexOf(document.activeElement)
					: -1;
			const next = e.shiftKey
				? here <= 0
					? nodes.length - 1
					: here - 1
				: here === -1 || here === nodes.length - 1
					? 0
					: here + 1;
			nodes[next]?.focus();
		};

		shell.addEventListener("keydown", onKeyDown);
		return () => shell.removeEventListener("keydown", onKeyDown);
	}, [goToNext, goToPrevious, hasMultipleImages, onClose, shellRef, zoomed]);
}
