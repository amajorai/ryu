"use client";

// Type-only, so the beam library stays out of the eager bundle.
import type { BorderBeamProps } from "@ryu/ui/components/border-beam.tsx";
import { usePrefersReducedMotion } from "@ryu/ui/components/reduced-motion.ts";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { whenBrowserIdle } from "./when-browser-idle.ts";
import { whenUserEngaged } from "./when-user-engaged.ts";

type BorderBeamComponent =
	typeof import("@ryu/ui/components/border-beam.tsx").BorderBeam;

// Mount slightly before the frame scrolls in, matching the margin the beam
// library uses to resume its own paused animation.
const NEAR_VIEWPORT_MARGIN = "256px";

// The beam never renders during load, so its library (mostly generated CSS
// strings) stays out of the eager bundle. Every beam on the page shares the one
// request.
let borderBeamRequest: Promise<BorderBeamComponent> | null = null;
function loadBorderBeam(): Promise<BorderBeamComponent> {
	borderBeamRequest ??= import("@ryu/ui/components/border-beam.tsx").then(
		(module) => module.BorderBeam,
		(error: unknown) => {
			// Let a later mount retry instead of caching the failure.
			borderBeamRequest = null;
			throw error;
		}
	);
	return borderBeamRequest;
}

/** Whether the visitor is focused inside the frame or has its menu open. */
function isFrameInUse(frame: HTMLElement): boolean {
	return (
		frame.contains(document.activeElement) ||
		frame.querySelector('[aria-expanded="true"]') !== null
	);
}

/**
 * Tracks a mouse or pen resting over the frame and any press that started in
 * it. Safari and Firefox on macOS do not focus a clicked link or button, so
 * focus alone misses a click in progress. Touch is left to the press flag:
 * touch pointers leave on release, and sticky touch hover would otherwise hold
 * the swap indefinitely. `onRelease` runs when the pointer lets go of or
 * leaves the frame.
 */
function trackFramePointer(frame: HTMLElement, onRelease: () => void) {
	let hovered = frame.matches(":hover");
	let pressed = false;
	const onOver = (event: PointerEvent) => {
		hovered = event.pointerType !== "touch";
	};
	const onLeave = () => {
		hovered = false;
		onRelease();
	};
	const onDown = () => {
		pressed = true;
	};
	const onUp = () => {
		if (pressed) {
			pressed = false;
			onRelease();
		}
	};
	frame.addEventListener("pointerover", onOver);
	frame.addEventListener("pointerleave", onLeave);
	frame.addEventListener("pointerdown", onDown, { capture: true });
	window.addEventListener("pointerup", onUp, { capture: true });
	window.addEventListener("pointercancel", onUp, { capture: true });
	return {
		inUse: () => hovered || pressed,
		dispose: () => {
			frame.removeEventListener("pointerover", onOver);
			frame.removeEventListener("pointerleave", onLeave);
			frame.removeEventListener("pointerdown", onDown, { capture: true });
			window.removeEventListener("pointerup", onUp, { capture: true });
			window.removeEventListener("pointercancel", onUp, { capture: true });
		},
	};
}

/**
 * The beam component once it may mount: only once the browser has gone idle and
 * the visitor has engaged with the page (pointer, touch, key or scroll; see
 * `whenUserEngaged`), while the frame is on or near the screen, and never while
 * the visitor prefers reduced motion. Decorative motion that starts on
 * engagement looks the same to a visitor, but its chunk, stylesheet and
 * per-frame custom-property animation stay out of the load window. Once mounted
 * it stays mounted; the library pauses its animation off screen by itself. A
 * failed chunk load leaves the plain frame.
 *
 * Swapping the frame for the beam remounts the wrapped button, which would drop
 * keyboard focus, close an open download menu, or swallow a click whose press
 * and release land on different nodes. Mounting waits for idle, engagement and
 * the viewport, so a visitor may already be using the button (a keyboard user
 * tabbing to the closing CTA scrolls it into view, or a pointer heading for it
 * triggers the chunk load); the swap waits until focus and the pointer leave it
 * and its menu is closed.
 */
function useBeamMount(frame: HTMLDivElement | null, reduceMotion: boolean) {
	const [beam, setBeam] = useState<BorderBeamComponent | null>(null);

	useEffect(() => {
		if (beam || reduceMotion || !frame) {
			return;
		}
		let idle = false;
		let engaged = false;
		let near = typeof IntersectionObserver === "undefined";
		let loaded: BorderBeamComponent | null = null;
		let loading = false;
		let cancelled = false;
		let recheckFrame = 0;
		const mountWhenReady = () => {
			if (cancelled || !(idle && engaged && near)) {
				return;
			}
			if (!loaded) {
				if (loading) {
					return;
				}
				loading = true;
				loadBorderBeam().then(
					(component) => {
						loaded = component;
						mountWhenReady();
					},
					() => {
						// Decorative: the plain frame stays when the chunk fails to load.
						loading = false;
					}
				);
				return;
			}
			if (!(pointer.inUse() || isFrameInUse(frame))) {
				const component = loaded;
				setBeam(() => component);
			}
		};
		// Focus and menu state settle after `focusout`, and the click that follows
		// `pointerup` must reach the original button, so check on the next frame.
		const recheckNextFrame = () => {
			if (!recheckFrame) {
				recheckFrame = window.requestAnimationFrame(() => {
					recheckFrame = 0;
					mountWhenReady();
				});
			}
		};
		const pointer = trackFramePointer(frame, recheckNextFrame);
		document.addEventListener("focusout", recheckNextFrame);
		const observer = near
			? null
			: new IntersectionObserver(
					(entries) => {
						for (const entry of entries) {
							near = entry.isIntersecting;
						}
						mountWhenReady();
					},
					{ rootMargin: NEAR_VIEWPORT_MARGIN }
				);
		observer?.observe(frame);
		const cancelIdle = whenBrowserIdle(() => {
			idle = true;
			mountWhenReady();
		});
		const cancelEngaged = whenUserEngaged(() => {
			engaged = true;
			mountWhenReady();
		});
		return () => {
			cancelled = true;
			cancelIdle();
			cancelEngaged();
			observer?.disconnect();
			pointer.dispose();
			document.removeEventListener("focusout", recheckNextFrame);
			if (recheckFrame) {
				window.cancelAnimationFrame(recheckFrame);
			}
		};
	}, [beam, frame, reduceMotion]);

	return beam;
}

export function LandingDownloadBeam({
	borderRadius,
	children,
	colorVariant = "colorful",
	testId,
	theme = "dark",
}: {
	borderRadius: number;
	children: ReactNode;
	/** The beam's tone; the hero matches it to its sky. */
	colorVariant?: BorderBeamProps["colorVariant"];
	testId?: string;
	/** The page behind the beam: `light` over the morning sky. */
	theme?: BorderBeamProps["theme"];
}) {
	const reduceMotion = usePrefersReducedMotion();
	const [frame, setFrame] = useState<HTMLDivElement | null>(null);
	const BorderBeam = useBeamMount(frame, reduceMotion);

	// Each beam ships ~8 KB of generated keyframes and rules in an inline
	// <style>, and inserting it restyles the whole document; its registered
	// custom properties then animate on the main thread every frame. It is
	// decorative and fades in once active, so the server sends a plain frame with
	// the same box rules (position, radius, clipping) and the beam mounts only
	// after the page is idle, the visitor has engaged with it, and the frame is
	// near the viewport.
	if (!BorderBeam) {
		const frameStyle: CSSProperties = {
			borderRadius,
			overflow: "hidden",
			position: "relative",
		};
		return (
			<div
				className="overflow-visible"
				data-beam-placeholder=""
				data-testid={testId}
				ref={setFrame}
				style={frameStyle}
			>
				{children}
			</div>
		);
	}

	return (
		<BorderBeam
			active={!reduceMotion}
			borderRadius={borderRadius}
			className="overflow-visible"
			colorVariant={colorVariant}
			data-testid={testId}
			size="md"
			strength={0.7}
			theme={theme}
		>
			{children}
		</BorderBeam>
	);
}
