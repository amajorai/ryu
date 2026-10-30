import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { type PlateBox, partOnStage } from "./game3d-plates.ts";
import {
	DECLUTTER_MS,
	figureBoxes,
	holdPlateRoots,
	type NamedPlate,
	nudged,
	nudgeOf,
	nudgeSliding,
	plateHolder,
	plateRect,
	plateRoot,
	SETTLE_PASSES,
	stageInsets,
	stagePlates,
} from "./game3d-stage-plate-dom.ts";

interface Box {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

const BUBBLE_SIDES = ["right", "left", "up"] as const;

function overlapArea(a: Box, b: Box): number {
	const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
	const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
	return x > 0 && y > 0 ? x * y : 0;
}

/** Where a bubble of `width` x `height` would sit on `side` of a plate box. */
function bubbleBox(
	plate: Box,
	side: (typeof BUBBLE_SIDES)[number],
	width: number,
	height: number
): Box {
	const middle = (plate.left + plate.right) / 2;
	// Matches LifeBubbleTag's offsets (16px off centre; 6px or 24px up).
	const bottom = plate.top - (side === "up" ? 24 : 6);
	let left = middle - width / 2;
	if (side === "right") {
		left = middle + 16;
	} else if (side === "left") {
		left = middle - 16 - width;
	}
	return { bottom, left, right: left + width, top: bottom - height };
}

/**
 * Hangs every `auto` bubble on the first side (right, left, up) whose box
 * meets no other plate and no bubble placed before it, in screen order
 * (the least crowded side when none is clear). Animated stages choose once
 * per bubble's words, so it never flickers; reduced motion picks afresh
 * each pass, so the frame depends on the scene alone.
 */
function chooseBubbleSides(stage: Element, reducedMotion: boolean) {
	const plates = [
		...stage.querySelectorAll<HTMLElement>(
			"[data-iso-target], [data-iso-plate]"
		),
	]
		.filter((plate) => plate.offsetParent !== null)
		.map((plate) => {
			const rect = plate.getBoundingClientRect();
			const [dx, dy] = nudgeOf(plate);
			return {
				box: {
					bottom: rect.bottom - dy,
					left: rect.left - dx,
					right: rect.right - dx,
					top: rect.top - dy,
				},
				bubble: plate.querySelector<HTMLElement>("[data-bubble-auto]"),
				name: plate.getAttribute("aria-label") ?? plate.textContent ?? "",
				plate,
			};
		})
		.filter((entry) => entry.box.right > entry.box.left);
	const placed: Box[] = [];
	const ordered = plates
		.filter((entry) => entry.bubble !== null)
		.sort(
			(a, b) =>
				Math.round(a.box.top) - Math.round(b.box.top) ||
				Math.round(a.box.left) - Math.round(b.box.left) ||
				a.name.localeCompare(b.name)
		);
	for (const entry of ordered) {
		const bubble = entry.bubble as HTMLElement;
		if (reducedMotion && bubble.style.transition !== "none") {
			// The reduced-motion catch-all's 0.01ms transition would leave a
			// bubble at its old side until the next paint, so separation would
			// part the plate as if it still hung there.
			bubble.style.transition = "none";
		}
		const size = bubble.getBoundingClientRect();
		const others = plates
			.filter((other) => other !== entry)
			.map((other) => other.box);
		const crowd = (side: (typeof BUBBLE_SIDES)[number]) => {
			const box = bubbleBox(entry.box, side, size.width, size.height);
			let area = 0;
			for (const other of [...others, ...placed]) {
				area += overlapArea(box, other);
			}
			return { area, box, side };
		};
		const options = BUBBLE_SIDES.map(crowd);
		const current = options.find(
			(option) => option.side === bubble.dataset.side
		);
		const clear = options.find((option) => option.area === 0);
		// Animated: a bubble keeps the side chosen for its words (plates
		// mid-slide would otherwise flip it, and each flip re-parts them).
		const words = bubble.textContent ?? "";
		const settled =
			!reducedMotion &&
			current !== undefined &&
			bubble.dataset.sideFor === words;
		let pick = settled ? current : clear;
		pick ??= options.reduce((best, option) =>
			option.area < best.area ? option : best
		);
		if (bubble.dataset.side !== pick.side) {
			bubble.dataset.side = pick.side;
		}
		bubble.dataset.sideFor = words;
		placed.push(pick.box);
	}
}

/**
 * Measures every plate in `stage` and nudges crowded ones apart; true when
 * any plate moved (so a static frame should measure again).
 */
export function declutterPlates(
	stage: Element,
	reducedMotion: boolean
): boolean {
	// Nothing moved and no words changed since the last pass: the result
	// would be the same, so skip the layout reads (the frame loop runs this
	// every DECLUTTER_MS while a scene animates).
	holdPlateRoots(stage);
	const signature = plateSignature(stage);
	if (lastSignature.get(stage) === signature) {
		return false;
	}
	if (!reducedMotion && nudgeSliding(stage)) {
		// A nudge is still sliding: measuring now would take its in-between
		// spot for its rest and push it again, so plates would drift for good.
		// Report movement so the caller parts again once it lands.
		return true;
	}
	lastSignature.set(stage, signature);
	chooseBubbleSides(stage, reducedMotion);
	let moved = false;
	const holders: HTMLElement[] = [];
	const boxes: PlateBox[] = [];
	const names: string[] = [];
	const named: NamedPlate[] = [];
	for (const plate of stagePlates(stage)) {
		if (plate.offsetParent === null) {
			continue;
		}
		const holder = plateHolder(plate);
		if (reducedMotion && holder.style.transition !== "none") {
			// A nudge from before reduced motion was known still slides; stop it
			// so this pass measures where the plate really is.
			// "none", not "": a plate's own classes may also animate translate.
			holder.style.transition = "none";
		}
		const [dx, dy] = nudgeOf(plate);
		const rect = plateRect(plate);
		if (rect.width === 0) {
			continue;
		}
		// A plate nudged before drei placed its wrapper holds that nudge
		// itself; it moves to the wrapper now, so the two never add up.
		const stale = holder === plate ? null : plate;
		if (stale && nudged.has(stale)) {
			stale.style.translate = "";
			nudged.delete(stale);
			nudged.set(holder, [0, 0]);
		}
		holders.push(holder);
		names.push(plate.getAttribute("aria-label") ?? plate.textContent ?? "");
		const namePlate =
			plate.hasAttribute("data-act-agent") &&
			!plate.hasAttribute("data-act-target");
		if (namePlate) {
			named.push({
				agent: plate.dataset.actAgent ?? "",
				bottom: rect.bottom - dy,
				height: rect.height,
				left: rect.left - dx,
				width: rect.width,
			});
		}
		boxes.push({
			clearsFigures: plate.dataset.actTarget === "alarm",
			namePlate,
			youSpot: plate.hasAttribute("data-you-spot"),
			height: rect.height,
			width: rect.width,
			x: rect.left + rect.width / 2 - dx,
			y: rect.top + rect.height / 2 - dy,
		});
	}
	// Villagers' figures, where the kit marks them: alarm plates keep off
	// them (their own agent's and a neighbour's), and nothing moves them.
	for (const figure of figureBoxes(stage, named)) {
		boxes.push(figure);
		names.push("");
	}
	// Plates join the DOM in mount order, which varies with timing; part them
	// in screen order instead, so the same scene always parts the same way.
	const order = boxes
		.map((_, index) => index)
		.sort((a, b) => {
			const p = boxes[a] as PlateBox;
			const q = boxes[b] as PlateBox;
			return (
				Math.round(p.y) - Math.round(q.y) ||
				Math.round(p.x) - Math.round(q.x) ||
				p.width - q.width ||
				p.height - q.height ||
				(names[a] ?? "").localeCompare(names[b] ?? "")
			);
		});
	// A plate hung left or right of its anchor (or a long one at the edge)
	// can reach past the stage, or under its HUD, where it is cut off or
	// hidden: part the plates inside the stage minus its insets.
	const area = stage.getBoundingClientRect();
	const insets = stageInsets(stage);
	const room =
		area.width > 0 && area.height > 0
			? {
					bottom: area.bottom - insets.bottom,
					left: area.left + insets.left,
					right: area.right - insets.right,
					top: area.top + insets.top,
				}
			: null;
	const parted = partOnStage(
		order.map((index) => boxes[index] as PlateBox),
		room
	);
	const nudges: [number, number][] = boxes.map(() => [0, 0]);
	for (const [rank, index] of order.entries()) {
		nudges[index] = parted[rank] ?? [0, 0];
	}
	for (const [index, holder] of holders.entries()) {
		const next = nudges[index] ?? [0, 0];
		const was = nudged.get(holder) ?? [0, 0];
		if (next[0] === was[0] && next[1] === was[1]) {
			continue;
		}
		holder.style.transition = reducedMotion
			? "none"
			: "translate 160ms ease-out";
		holder.style.translate = `${next[0]}px ${next[1]}px`;
		nudged.set(holder, next);
		moved = true;
	}
	if (moved) {
		// Measure again next pass even if nothing else changes: an animated
		// nudge is still sliding now, and this pass may have measured another
		// mid-slide; the scene is settled only once a pass moves nothing.
		lastSignature.delete(stage);
	}
	return moved;
}

const lastSignature = new WeakMap<Element, string>();

/**
 * Where every plate is and what it says, without a layout read: drei's
 * placement transform on each plate's Html root plus its words. Nudges are
 * set with `translate`, not `transform`, so they do not change it.
 */
function plateSignature(stage: Element): string {
	const parts: string[] = [];
	for (const plate of stagePlates(stage)) {
		const root = plateRoot(plate);
		parts.push(`${root?.style.transform ?? ""}|${plate.textContent ?? ""}`);
	}
	return parts.join("\n");
}

/**
 * Keeps the scene's plates apart: re-parts them when the camera moves and,
 * while the scene animates, a few times a second (never every frame). A
 * demand-driven canvas (reduced motion) can stop drawing while plates still
 * change (a bubble or board line mounts), so DOM changes in the stage also
 * re-part them, repeating until they settle (instant nudges there, so each
 * pass measures where the plates really are).
 */
export function PlateDeclutter({ reducedMotion }: { reducedMotion: boolean }) {
	const element = useThree((state) => state.gl.domElement);
	const seen = useRef({
		again: false,
		at: 0,
		follows: 0,
		frame: 0,
		trailing: 0,
		x: 0,
		y: 0,
		z: 0,
		zoom: 0,
	});
	useFrame(({ camera, frameloop }) => {
		const last = seen.current;
		const now = performance.now();
		const snapshot = () => {
			last.at = performance.now();
			last.zoom = camera.zoom;
			last.x = camera.position.x;
			last.y = camera.position.y;
			last.z = camera.position.z;
		};
		// One separation pass. On a demand canvas an animated nudge slides
		// with no frame after it, and the pass may have measured a plate
		// mid-slide: part again once the slide has landed, until a pass moves
		// nothing (an always-drawing canvas does this on its own frames).
		const part = () => {
			const stage = element.parentElement?.closest("[data-testid='iso-stage']");
			if (!stage) {
				return;
			}
			const shifted = declutterPlates(stage, reducedMotion);
			if (!shifted) {
				last.follows = 0;
				return;
			}
			if (
				reducedMotion ||
				frameloop === "always" ||
				last.follows >= SETTLE_PASSES
			) {
				return;
			}
			last.follows += 1;
			window.clearTimeout(last.trailing);
			last.trailing = window.setTimeout(() => {
				last.trailing = 0;
				snapshot();
				part();
			}, DECLUTTER_MS);
		};
		const moved =
			camera.zoom !== last.zoom ||
			camera.position.x !== last.x ||
			camera.position.y !== last.y ||
			camera.position.z !== last.z;
		if (!moved && now - last.at < DECLUTTER_MS) {
			// Throttled: on a demand canvas, part these positions once the
			// window closes, as it may draw no further frame (the last steps of
			// a walk would otherwise stay unparted). An always-drawing canvas
			// parts them on its next frame past the window: a timer there
			// would add a second pass a frame later, mid-slide.
			if (last.trailing === 0 && frameloop !== "always") {
				last.trailing = window.setTimeout(
					() => {
						last.trailing = 0;
						// This pass opens the next window.
						snapshot();
						part();
					},
					DECLUTTER_MS - (now - last.at)
				);
			}
			return;
		}
		window.clearTimeout(last.trailing);
		last.trailing = 0;
		last.follows = 0;
		snapshot();
		if (last.frame !== 0) {
			// A pass is pending but measures before this frame's moves land; a
			// reduced-motion canvas may draw no frame after it, so run once
			// more. (Animated nudges are still sliding then; the frame loop
			// re-parts them within DECLUTTER_MS anyway.)
			if (reducedMotion) {
				last.again = true;
			}
			return;
		}
		// After this frame, once the plates have moved with the camera.
		const run = () => {
			last.frame = 0;
			part();
			if (last.again) {
				last.again = false;
				last.frame = requestAnimationFrame(run);
			}
		};
		last.frame = requestAnimationFrame(run);
	});
	useEffect(() => {
		const last = seen.current;
		return () => {
			cancelAnimationFrame(last.frame);
			window.clearTimeout(last.trailing);
		};
	}, []);
	useEffect(() => {
		const stage = element.parentElement?.closest("[data-testid='iso-stage']");
		// Animated stages keep drawing and re-part on the frame loop; measuring
		// there mid-slide (the 160ms nudge transition) would make plates jitter.
		if (!(stage && reducedMotion) || typeof MutationObserver === "undefined") {
			return;
		}
		let frame = 0;
		let passes = 0;
		const pass = () => {
			frame = 0;
			const moved = declutterPlates(stage, reducedMotion);
			passes += 1;
			if (moved && passes < SETTLE_PASSES) {
				frame = requestAnimationFrame(pass);
			}
		};
		const schedule = () => {
			passes = 0;
			if (frame === 0) {
				frame = requestAnimationFrame(pass);
			}
		};
		// Content only: the nudges themselves are style writes, not observed.
		const observer = new MutationObserver(schedule);
		// A web font swapping in resizes plates with no DOM change.
		document.fonts?.addEventListener("loadingdone", schedule);
		observer.observe(stage, {
			characterData: true,
			childList: true,
			subtree: true,
		});
		schedule();
		return () => {
			observer.disconnect();
			document.fonts?.removeEventListener("loadingdone", schedule);
			cancelAnimationFrame(frame);
		};
	}, [element, reducedMotion]);
	return null;
}
