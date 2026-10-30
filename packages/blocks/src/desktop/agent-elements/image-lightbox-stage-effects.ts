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
		const padding = body.style.paddingRight;
		const gap = window.innerWidth - document.documentElement.clientWidth;
		const base = Number.parseFloat(getComputedStyle(body).paddingRight) || 0;
		body.style.overflow = "hidden";
		if (gap > 0) {
			body.style.paddingRight = `${base + gap}px`;
		}
		frame?.focus({ preventScroll: true });
		let released = false;
		const release = () => {
			if (released) {
				return;
			}
			released = true;
			body.style.overflow = overflow;
			body.style.paddingRight = padding;
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
				if (e.key === "ArrowLeft") {
					e.preventDefault();
					goToPrevious();
					return;
				}
				if (e.key === "ArrowRight") {
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
