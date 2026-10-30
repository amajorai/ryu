import { useFrame, useThree } from "@react-three/fiber";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { OrthographicCamera, Vector3 } from "three";
import {
	useIsoCameraPointer,
	useIsoCameraZoom,
} from "./game3d-stage-camera-input.ts";
import { declutterPlates } from "./game3d-stage-declutter.ts";
import {
	fitIso,
	type IsoBounds,
	type IsoFit,
	type IsoInsets,
	type IsoPlateFit,
	type IsoPortrait,
	isoBasis,
	isoFraming,
	isPortraitStage,
} from "./game3d-stage-framing.ts";
import {
	CONTENT_FRAMES,
	CONTENT_PAD,
	CONTENT_QUIET_MS,
	CONTENT_TRIES,
	CONTENT_WAIT_MS,
	type ContentFit,
	markFit,
	NO_CONTENT,
	plateFit,
	SETTLE_PASSES,
	SETTLE_RETRIES,
	withoutNudges,
} from "./game3d-stage-plate-dom.ts";
import type { IsoView } from "./game3d-stage-view.tsx";

const CAMERA_DISTANCE = 60;
/**
 * The isometric camera: fitted to `bounds` between the HUD insets, panned
 * by dragging and zoomed by the wheel or the view's commands, both kept
 * within the diorama.
 */
/** How far a focus zooms in at least (default), and its glide time (s). */
export const FOCUS_ZOOM = 1.45;
const FOCUS_SECONDS = 0.5;

export function IsoCamera({
	bounds: wideBounds,
	fill: wideFill,
	focusZoom,
	insets,
	plates,
	portrait,
	reducedMotion,
	view,
}: {
	bounds: IsoBounds;
	fill: number;
	focusZoom: number;
	insets: IsoInsets;
	plates?: IsoPlateFit;
	portrait?: IsoPortrait;
	reducedMotion: boolean;
	view?: IsoView;
}) {
	const camera = useThree((state) => state.camera) as OrthographicCamera;
	const size = useThree((state) => state.size);
	const advance = useThree((state) => state.advance);
	const frameloop = useThree((state) => state.frameloop);
	const getState = useThree((state) => state.get);
	const invalidate = useThree((state) => state.invalidate);
	const element = useThree((state) => state.gl.domElement);
	const state = useRef({ factor: 1, panRight: 0, panUp: 0 });
	const target = useRef<Vector3 | null>(null);
	const tallStage = isPortraitStage(size.width, size.height, insets);
	const { angle, bounds, fill } = useMemo(
		() => isoFraming(wideBounds, wideFill, portrait, tallStage),
		[portrait, tallStage, wideBounds, wideFill]
	);
	const basis = useMemo(() => isoBasis(angle), [angle]);
	const base = useMemo(
		() => fitIso(bounds, size.width, size.height, insets, fill, angle),
		[angle, bounds, fill, insets, size.height, size.width]
	);
	// Portrait stages zoom on to what is there (the plates), once fitted.
	const [content, setContent] = useState<ContentFit>(NO_CONTENT);
	const fit = useMemo<IsoFit>(
		() =>
			content === NO_CONTENT
				? base
				: {
						...base,
						middle: [
							base.middle[0] + content.right,
							base.middle[1] + content.up,
						],
						zoom: base.zoom * content.scale,
					},
		[base, content]
	);
	const fitPlates =
		plates !== undefined ||
		(tallStage && !portrait?.bounds && portrait?.fitPlates !== false);
	const padAbove = plates?.above ?? CONTENT_PAD.above;
	const padBelow = plates?.below ?? CONTENT_PAD.below;
	const padSide = plates?.side ?? CONTENT_PAD.side;
	const padMax = plates?.max ?? CONTENT_PAD.max;
	const baseKey = [
		base.zoom,
		...base.middle,
		insets.left,
		insets.right,
		insets.top,
		insets.bottom,
	]
		.map((value) => value.toFixed(3))
		.join(" ");
	// Frames drawn, so plates are measured only once they have followed
	// the camera (drei places them during a frame).
	const frames = useRef(0);
	// A fit measure is scheduled or running: a settle must not mark done.
	const awaiting = useRef(true);
	const insetsNow = useRef(insets);
	insetsNow.current = insets;
	// A manual draw (R3F's `advance` ignores `frameloop`, so a stage that is
	// covered, off screen or hidden would still render). In seconds, as the
	// clock counts, since `advance` sets it outright under "never".
	const drawNow = useCallback(() => {
		if (getState().frameloop !== "never") {
			advance(performance.now() / 1000);
		}
	}, [advance, getState]);
	useFrame(() => {
		frames.current += 1;
	});
	useEffect(() => {
		setContent(NO_CONTENT);
		const stage = element.parentElement?.closest("[data-testid='iso-stage']");
		// Every stage, fitted or not, is pending until a frame is drawn with
		// its final camera and its plates have parted (see settleAfterFit).
		awaiting.current = true;
		markFit(stage, "pending");
		// Covered, off screen or in a hidden tab (frameloop "never"): no frames
		// run, so nothing can be measured. Stay pending; this effect runs again
		// when the stage is drawn.
		if (frameloop === "never") {
			return;
		}
		let tries = 0;
		let timer = 0;
		const start = frames.current;
		// Reduced motion fits once and holds it, so it must fit the scene that
		// stays: wait until plates stop mounting (a bubble or board line lands
		// a frame or two late), and until frames have placed them (drei moves
		// a plate only during a frame, and a demand canvas draws none unasked),
		// then measure.
		let changedAt = performance.now();
		let changedFrame = frames.current;
		let fitted = false;
		// Plates mounting, or a web font swapping in (it resizes every plate
		// with no DOM change), even after the fit: fit again once it settles.
		const changed = () => {
			changedAt = performance.now();
			changedFrame = frames.current;
			invalidate();
			if (fitted) {
				fitted = false;
				awaiting.current = true;
				markFit(stage, "pending");
				tries = 0;
				window.clearTimeout(timer);
				timer = window.setTimeout(measure, CONTENT_WAIT_MS);
			}
		};
		const quiet = new MutationObserver(changed);
		if (reducedMotion && stage) {
			quiet.observe(stage, { childList: true, subtree: true });
			document.fonts?.addEventListener("loadingdone", changed);
		}
		const fontsLoading = () =>
			document.fonts !== undefined && document.fonts.status !== "loaded";
		const settling = () =>
			reducedMotion &&
			(performance.now() - changedAt < CONTENT_QUIET_MS ||
				frames.current - changedFrame < CONTENT_FRAMES ||
				fontsLoading());
		const measure = () => {
			if (
				(frames.current - start < CONTENT_FRAMES || settling()) &&
				tries < CONTENT_TRIES
			) {
				tries += 1;
				invalidate();
				timer = window.setTimeout(measure, CONTENT_WAIT_MS);
				return;
			}
			const current = state.current;
			const userMoved =
				current.factor !== 1 || current.panRight !== 0 || current.panUp !== 0;
			// No fit to make (a stage that does not fit its plates, or one the
			// reader zoomed or panned): only part the plates and finish.
			const settleHere = () => {
				fitted = true;
				awaiting.current = false;
				settleAfterFit.current();
			};
			if (!fitPlates || userMoved) {
				settleHere();
				return;
			}
			if (reducedMotion) {
				// Draw now, twice (a plate's wrapper follows its anchor a frame
				// late), so every plate sits where this camera puts it: the fit
				// then depends on the scene, not on when frames last ran.
				drawNow();
				drawNow();
			}
			// Reduced motion: the fit as the base camera would see the plates
			// (each centre unprojected through this camera, projected through
			// the base one; plates keep their px size), so it never depends on
			// the fit the camera carries now or how many refits came before.
			const fitAtBase = (from: Element) => {
				const box = element.getBoundingClientRect();
				const toBase = (points: [number, number][]) => {
					const worlds = points.map(([x, y]) =>
						camera.position
							.clone()
							.set((x / box.width) * 2 - 1, 1 - (y / box.height) * 2, 0)
							.unproject(camera)
					);
					applyNow.current(baseNow.current);
					camera.updateMatrixWorld();
					const out = worlds.map((world): [number, number] => {
						const at = world.project(camera);
						return [
							((at.x + 1) / 2) * box.width,
							((1 - at.y) / 2) * box.height,
						];
					});
					applyNow.current();
					camera.updateMatrixWorld();
					return out;
				};
				return plateFit(
					from,
					box,
					insetsNow.current,
					baseNow.current.zoom,
					{
						above: padAbove,
						below: padBelow,
						max: padMax,
						side: padSide,
					},
					NO_CONTENT,
					toBase
				);
			};
			const fitNow = (from: Element, applied: ContentFit) =>
				plateFit(
					from,
					element.getBoundingClientRect(),
					insetsNow.current,
					camera.zoom,
					{
						above: padAbove,
						below: padBelow,
						max: padMax,
						side: padSide,
					},
					applied
				);
			let next: ContentFit | null = null;
			if (stage) {
				// Reduced motion: measure the plates with no nudges at all (put
				// back in the same task, so nothing paints), so the fit never
				// depends on what separation did before it.
				next = reducedMotion
					? withoutNudges(stage, () => fitAtBase(stage))
					: fitNow(stage, appliedContent.current);
			}
			if (next) {
				const was = appliedContent.current;
				const same =
					Math.abs(next.right - was.right) < 1e-3 &&
					Math.abs(next.up - was.up) < 1e-3 &&
					Math.abs(next.scale - was.scale) < 1e-4;
				if (same) {
					settleHere();
				} else {
					// The camera moves on commit; part the plates after it.
					fitted = true;
					awaiting.current = false;
					fitLanded.current = true;
					setContent(next);
				}
			} else if (tries < CONTENT_TRIES) {
				tries += 1;
				timer = window.setTimeout(measure, CONTENT_WAIT_MS);
			} else {
				// Still nothing to frame: keep the base camera and finish.
				settleHere();
			}
		};
		timer = window.setTimeout(measure, CONTENT_WAIT_MS);
		return () => {
			window.clearTimeout(timer);
			window.clearTimeout(settleTimer.current);
			quiet.disconnect();
			document.fonts?.removeEventListener("loadingdone", changed);
		};
	}, [
		baseKey,
		camera,
		element,
		fitPlates,
		invalidate,
		padAbove,
		padBelow,
		padMax,
		padSide,
		reducedMotion,
		frameloop,
		drawNow,
	]);
	const apply = useMemo(
		() =>
			(use: IsoFit = fit) => {
				const view = state.current;
				const zoom = use.zoom * view.factor;
				// Pan no further than the content's edges.
				const limitRight = Math.max(
					0.5,
					(use.across - (size.width - insets.left - insets.right) / zoom) / 2 +
						0.5
				);
				const limitUp = Math.max(
					0.5,
					(use.tall - (size.height - insets.top - insets.bottom) / zoom) / 2 +
						0.5
				);
				view.panRight = Math.max(
					-limitRight,
					Math.min(limitRight, view.panRight)
				);
				view.panUp = Math.max(-limitUp, Math.min(limitUp, view.panUp));
				// The content's middle lands in the middle of the uncovered area.
				const shiftX = (insets.left - insets.right) / 2 / zoom;
				const shiftY = (insets.top - insets.bottom) / 2 / zoom;
				const right = use.middle[0] - shiftX + view.panRight;
				const up = use.middle[1] + shiftY + view.panUp;
				const { right: axisRight, toward, up: axisUp } = basis;
				target.current ??= camera.position.clone();
				const look = target.current.set(
					axisRight[0] * right + axisUp[0] * up,
					axisUp[1] * up,
					axisRight[2] * right + axisUp[2] * up
				);
				camera.position.set(
					look.x + toward[0] * CAMERA_DISTANCE,
					look.y + toward[1] * CAMERA_DISTANCE,
					look.z + toward[2] * CAMERA_DISTANCE
				);
				camera.lookAt(look);
				camera.zoom = zoom;
				camera.updateProjectionMatrix();
				invalidate();
			},
		[basis, camera, fit, insets, invalidate, size.height, size.width]
	);
	// The base fit and the camera mover of the latest render, for the
	// reduced-motion fit's view through the base camera.
	const baseNow = useRef(base);
	baseNow.current = base;
	const applyNow = useRef(apply);
	applyNow.current = apply;
	// What the camera carries now (a reset may not have reached it yet).
	const appliedContent = useRef<ContentFit>(NO_CONTENT);
	// Reduced motion: once a fit moves the camera, draw it and re-part the
	// plates to rest in the same task (no later frame will), then mark the
	// canvas `data-iso-fit="done"` for checks and screenshots to wait on.
	const fitLanded = useRef(false);
	const settleAfterFit = useRef<() => void>(() => undefined);
	const settleTimer = useRef(0);
	const settleTries = useRef(0);
	settleAfterFit.current = () => {
		window.clearTimeout(settleTimer.current);
		if (awaiting.current) {
			// A refit is scheduled; it settles when it lands.
			return;
		}
		const stage = element.parentElement?.closest("[data-testid='iso-stage']");
		// Draw with the final camera, twice (a plate's wrapper follows its
		// anchor a frame late), then part the plates against that frame.
		if (getState().frameloop === "never") {
			// Nothing is drawn while covered or hidden; settle when it is shown.
			return;
		}
		drawNow();
		drawNow();
		let still = true;
		for (let pass = 0; stage && pass < SETTLE_PASSES; pass++) {
			still = !declutterPlates(stage, reducedMotion);
			if (still) {
				break;
			}
		}
		// Animated plates keep moving with the scene; reduced motion marks
		// done only once a pass moves nothing, and tries again until then.
		if (still || !reducedMotion) {
			settleTries.current = 0;
			markFit(stage, "done");
			return;
		}
		settleTries.current += 1;
		if (settleTries.current > SETTLE_RETRIES) {
			markFit(stage, "unsettled");
			return;
		}
		settleTimer.current = window.setTimeout(
			() => settleAfterFit.current(),
			CONTENT_WAIT_MS
		);
	};
	useLayoutEffect(() => {
		appliedContent.current = content;
		apply();
		if (fitLanded.current) {
			fitLanded.current = false;
			settleAfterFit.current();
		}
	}, [apply, content]);
	useIsoCameraZoom(view, apply, state);
	// Focus: glide pan and zoom so a plate lands mid-stage.
	const glide = useRef(0);
	useEffect(
		() =>
			view?.listenFocus((targetId) => {
				const stage = element.parentElement?.closest(
					"[data-testid='iso-stage']"
				);
				const plate = stage?.querySelector<HTMLElement>(
					`[data-iso-focus="${CSS.escape(targetId)}"]`
				);
				if (!plate) {
					return;
				}
				const box = element.getBoundingClientRect();
				const rect = plate.getBoundingClientRect();
				const current = state.current;
				const zoom = fit.zoom * current.factor;
				// Ortho: screen offsets are world offsets over zoom, so the
				// plate's pan is exact (the insets' shift cancels out).
				const shiftX = (insets.left - insets.right) / 2 / zoom;
				const shiftY = (insets.top - insets.bottom) / 2 / zoom;
				const lookRight = fit.middle[0] - shiftX + current.panRight;
				const lookUp = fit.middle[1] + shiftY + current.panUp;
				const x = rect.left + rect.width / 2 - box.left - box.width / 2;
				const y = rect.top + rect.height / 2 - box.top - box.height / 2;
				const goal = {
					factor: Math.max(current.factor, focusZoom),
					panRight: lookRight + x / zoom - fit.middle[0],
					panUp: lookUp - y / zoom - fit.middle[1],
				};
				const from = { ...current };
				cancelAnimationFrame(glide.current);
				const start = performance.now();
				const step = (now: number) => {
					const t = reducedMotion
						? 1
						: Math.min(1, (now - start) / 1000 / FOCUS_SECONDS);
					const ease = t * t * (3 - 2 * t);
					current.factor = from.factor + (goal.factor - from.factor) * ease;
					current.panRight =
						from.panRight + (goal.panRight - from.panRight) * ease;
					current.panUp = from.panUp + (goal.panUp - from.panUp) * ease;
					apply();
					if (t < 1) {
						glide.current = requestAnimationFrame(step);
					}
				};
				glide.current = requestAnimationFrame(step);
			}),
		[apply, element, fit, insets, reducedMotion, view]
	);
	useEffect(() => () => cancelAnimationFrame(glide.current), []);
	useIsoCameraPointer(element, apply, fit, state, glide);
	return null;
}
