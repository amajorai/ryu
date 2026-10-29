import { useEffect, useState } from "react";
import { useLogoActivity } from "./logo-activity.ts";
import type { EyePosition } from "./logo-shared.ts";

/** Pointer stillness after which the eyes start wandering on their own. */
const POINTER_IDLE_MS = 3000;
const RESTING_EYES: EyePosition = { x: 0, y: 0 };

type PointerListener = (clientX: number, clientY: number) => void;

// One window listener for every animated logo on the page, delivered at most
// once per frame. Mousemove fires several times per frame on fast pointers, and
// each logo used to read layout and re-render on every event.
const pointerListeners = new Set<PointerListener>();
let pointerX = 0;
let pointerY = 0;
let lastPointerMoveAt = Number.NEGATIVE_INFINITY;
let pointerFrame = 0;

function flushPointer() {
	pointerFrame = 0;
	for (const listener of pointerListeners) {
		listener(pointerX, pointerY);
	}
}

function handlePointerMove(event: MouseEvent) {
	pointerX = event.clientX;
	pointerY = event.clientY;
	lastPointerMoveAt = performance.now();
	if (!pointerFrame) {
		pointerFrame = window.requestAnimationFrame(flushPointer);
	}
}

function subscribePointer(listener: PointerListener): () => void {
	if (pointerListeners.size === 0) {
		window.addEventListener("mousemove", handlePointerMove, { passive: true });
	}
	pointerListeners.add(listener);
	return () => {
		pointerListeners.delete(listener);
		if (pointerListeners.size > 0) {
			return;
		}
		window.removeEventListener("mousemove", handlePointerMove);
		if (pointerFrame) {
			window.cancelAnimationFrame(pointerFrame);
			pointerFrame = 0;
		}
	};
}

function randomEyePosition(sizeValue: number): EyePosition {
	const maxDistance = Math.min(sizeValue * 0.08, 8.0);
	const angle = Math.random() * Math.PI * 2;
	const distance = Math.random() * maxDistance;
	return {
		x: Math.cos(angle) * distance,
		y: Math.sin(angle) * distance,
	};
}

interface LogoGazeOptions {
	/** Whether the rendered variant shows blinking eyes. */
	blinks: boolean;
	/** The mark's root element; gaze is measured from its center. */
	element: HTMLDivElement | null;
	sizeValue: number;
	/** Whether the rendered variant moves its eyes with the gaze. */
	tracks: boolean;
}

interface LogoGaze {
	eyePosition: EyePosition;
	isBlinking: boolean;
}

/**
 * Blinking, pointer-following and idle-wandering eyes. Nothing runs until the
 * browser is idle, and everything stops while the mark is off screen or the tab
 * is hidden (see `useLogoActivity`), so a logo in the page chrome costs no
 * timers, listeners or re-renders on load.
 */
export function useLogoGaze({
	blinks,
	element,
	sizeValue,
	tracks,
}: LogoGazeOptions): LogoGaze {
	const active = useLogoActivity(element, blinks || tracks);
	const [isBlinking, setIsBlinking] = useState(false);
	const [eyePosition, setEyePosition] = useState(RESTING_EYES);
	const [isPointerIdle, setIsPointerIdle] = useState(false);

	useEffect(() => {
		if (!(blinks && active)) {
			return;
		}
		const blinkInterval = setInterval(
			() => {
				setIsBlinking(true);
				setTimeout(() => setIsBlinking(false), 150);
			},
			3000 + Math.random() * 2000
		);
		return () => clearInterval(blinkInterval);
	}, [active, blinks]);

	useEffect(() => {
		if (!(tracks && active && element)) {
			return;
		}
		const quietSince = performance.now();
		let idleTimer: ReturnType<typeof setTimeout> | null = null;
		// One timer per quiet period instead of one per mousemove: when it fires
		// early (the pointer moved since), it re-arms for the time left.
		const checkIdle = () => {
			const quietFor =
				performance.now() - Math.max(quietSince, lastPointerMoveAt);
			if (quietFor >= POINTER_IDLE_MS) {
				idleTimer = null;
				setIsPointerIdle(true);
				return;
			}
			idleTimer = setTimeout(checkIdle, POINTER_IDLE_MS - quietFor);
		};
		const follow = (clientX: number, clientY: number) => {
			if (!idleTimer) {
				setIsPointerIdle(false);
				idleTimer = setTimeout(checkIdle, POINTER_IDLE_MS);
			}
			const rect = element.getBoundingClientRect();
			const orbCenterX = rect.left + rect.width / 2;
			const orbCenterY = rect.top + rect.height / 2;
			const angle = Math.atan2(clientY - orbCenterY, clientX - orbCenterX);
			const maxDistance = Math.min(sizeValue * 0.1, 15.0);
			const x = Math.cos(angle) * maxDistance;
			const y = Math.sin(angle) * maxDistance;
			setEyePosition((current) =>
				current.x === x && current.y === y ? current : { x, y }
			);
		};
		setIsPointerIdle(false);
		idleTimer = setTimeout(checkIdle, POINTER_IDLE_MS);
		const unsubscribe = subscribePointer(follow);
		return () => {
			unsubscribe();
			if (idleTimer) {
				clearTimeout(idleTimer);
			}
		};
	}, [active, element, sizeValue, tracks]);

	useEffect(() => {
		if (!(isPointerIdle && tracks && active)) {
			return;
		}
		const moveRandomly = () => setEyePosition(randomEyePosition(sizeValue));
		moveRandomly();
		const wanderTimer = setInterval(moveRandomly, 2000 + Math.random() * 2000);
		return () => clearInterval(wanderTimer);
	}, [active, isPointerIdle, sizeValue, tracks]);

	return { eyePosition, isBlinking };
}
