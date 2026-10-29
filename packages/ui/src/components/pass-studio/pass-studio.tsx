"use client";

import type { PaperShaderElement } from "@paper-design/shaders-react";
import type { CSSProperties } from "react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { isNativeNumber } from "../../lib/native-primitive-observation.ts";
import { cn } from "../../lib/utils.ts";
import { ditherAvatarHue } from "../dither-kit/avatar.tsx";
import { MetalEdge } from "../metal-edge.tsx";
import { ShaderBackground } from "../motion/shader-background.tsx";
import {
	hueHex,
	WARP_BASE_DARK,
	WARP_BASE_LIGHT,
	WARP_DISTORTION,
	WARP_HUE_SPREAD,
	WARP_SCALE,
	WARP_SOFTNESS,
	WARP_SPEED,
	WARP_SWIRL,
} from "../pass-card-shell.tsx";
import {
	DEFAULT_PASS_FORMAT_ID,
	PASS_LOOP_FPS,
	PASS_LOOP_SECONDS,
	type PassFormatId,
	passFormat,
} from "./formats.ts";
import { type GifRecording, recordCanvasGif } from "./gif.ts";
import {
	CARD_HEIGHT_PX,
	CARD_WIDTH_PX,
	loadAvatar,
	type PassFaceContent,
	type PassFacePainter,
	readPassFontFamily,
	readPassPalette,
	waitlistFacePainter,
} from "./paint.ts";
import drawingStyles from "./pass-studio.drawing.module.css";
import { type PassRecording, recordCanvasLoop } from "./record.ts";
import {
	BACKDROP_WASH_ALPHA,
	type PassBackdropSpec,
	PassScene,
	type PassSceneSources,
} from "./scene.ts";

interface PreviewBoxStyle extends CSSProperties {
	"--pass-studio-1-height"?: string | undefined;
	"--pass-studio-1-width"?: string | undefined;
}
interface ExportBoxStyle extends CSSProperties {
	"--pass-studio-2-height"?: string | undefined;
	"--pass-studio-2-width"?: string | undefined;
}
interface PreviewImageStyle extends CSSProperties {
	"--pass-studio-3-max-height"?: string | undefined;
}
interface ExportImageStyle extends CSSProperties {
	"--pass-studio-4-max-height"?: string | undefined;
}
function drawingLength(value: CSSProperties["width"]): string | undefined {
	return isNativeNumber(value) ? `${value}px` : value;
}

/**
 * The pass, as a shareable picture or a looping video.
 *
 * The card is drawn into a `<canvas>` rather than mounted as DOM because that
 * is the only surface a clipboard and a recorder can both read — but the parts
 * that make the card look like itself are NOT redrawn. Two hidden hosts below
 * mount the real `warp` shader and the real `MetalEdge`, and the scene samples
 * their canvases every frame. What a member exports is the same shader field
 * and the same chrome ring that is turning on the screen behind the dialog.
 *
 * The hosts are `position: fixed` and `opacity: 0` rather than `display: none`
 * or off-screen. Both libraries gate painting on an IntersectionObserver, which
 * reports GEOMETRY: a laid-out, in-viewport, fully transparent box keeps
 * painting, while a hidden or zero-sized one is told it is off-screen once and
 * never asked again, and paints nothing forever. This is the same workaround
 * `metal-edge.tsx` already carries for its keep-alive instance.
 *
 * They are PORTALLED to `document.body` rather than rendered inline, and that is
 * load-bearing rather than tidiness. This component's first consumer is a
 * dialog, and dialog content animates in on a `transform` — which makes it a
 * containing block for `position: fixed`, so an inline host would be fixed to
 * the DIALOG, not the viewport. It would then move while the open animation
 * runs, which is exactly the moving-box case `metal-edge.tsx`'s two-frame mount
 * gate exists to avoid: the observers are asked once, mid-animation, and an
 * instance told it is out of view is never asked again.
 */

/** Long edge of the in-dialog preview. Full format size is only built to export. */
const PREVIEW_LONG_EDGE = 720;
/**
 * How tall the preview box is allowed to get. A share dialog has to show the
 * picture AND the buttons under it without scrolling, and 9:16 is the ratio that
 * decides that — the tallest thing on offer.
 */
const PREVIEW_MAX_HEIGHT = "44vh";
/**
 * How long the ring's shared shader needs before its field has developed. Below
 * this it copies a near-black band, which is the one thing the ring must never
 * be in an exported file. Same figure `metal-edge.tsx` warms up over.
 */
const RING_WARMUP_MS = 1500;
/**
 * How many frames a HELD preview keeps repainting after it is asked for. The
 * card's two shader sources arrive on their own schedule — the warp mount when
 * React has run its effects, the ring once its shared field has developed — so a
 * static frame drawn once at mount is a card frozen before either landed.
 * Roughly three seconds at 60fps, which covers `RING_WARMUP_MS` with room.
 */
const SETTLE_FRAMES = 180;
/**
 * Where in the turn a still is taken by default — a twentieth of the cycle,
 * which puts the card at 18 degrees. Enough that the perspective and the milled
 * edge read as a solid object; a tenth (36 degrees) was past the point where the
 * name starts to foreshorten, and the name is the subject of the card.
 */
export const PASS_STILL_TIME = PASS_LOOP_SECONDS * 0.05;
/** The canvas's accessible name when a consumer does not give the card one. */
const DEFAULT_PREVIEW_LABEL = "Preview of your Ryu pass";
/** The face a `face`-driven studio hands its unused default painter. */
const NO_CONTENT: PassFaceContent = { name: "" };

/**
 * The waitlist card's backdrop, from its seed.
 *
 * Extracted rather than inlined because it is now ONE of the backdrops this
 * studio can print, and because it is the reference implementation of
 * `PassBackdropSpec`: the shader takes the seeded hue with the scheme's base
 * tone interleaved, and the wash behind the card is the same hue twice, warmer
 * and cooler, at `BACKDROP_WASH_ALPHA`. The second hue is `WARP_HUE_SPREAD` off
 * the first in both — they were the same number written out twice before this
 * became a seam.
 */
export function waitlistBackdrop(
	seed: string,
	isDark: boolean
): PassBackdropSpec {
	const hue = ditherAvatarHue(seed);
	const base = isDark ? WARP_BASE_DARK : WARP_BASE_LIGHT;
	return {
		colors: [base, hueHex(hue), base, hueHex(hue + WARP_HUE_SPREAD)],
		wash: [
			`hsla(${hue}, 78%, 58%, ${BACKDROP_WASH_ALPHA})`,
			`hsla(${hue + WARP_HUE_SPREAD}, 70%, 46%, ${BACKDROP_WASH_ALPHA * 0.45})`,
		],
	};
}

export interface PassStudioHandle {
	/**
	 * The same loop as a looping GIF on a 480px short edge — the file that
	 * autoplays in Slack, Discord, READMEs and iMessage, where an MP4 does not.
	 */
	exportGif(
		onProgress?: (fraction: number) => void,
		signal?: AbortSignal
	): Promise<GifRecording>;
	/**
	 * A `PASS_LOOP_SECONDS` loop at full export size. Timestamped frame encoding
	 * preserves the media timeline even on slower devices. Pass a
	 * signal so a dialog that closes mid-record stops it rather than finishing
	 * against an unmounted studio and firing a download afterwards.
	 */
	exportLoop(
		onProgress?: (fraction: number) => void,
		signal?: AbortSignal
	): Promise<PassRecording>;
	/** A PNG of the current frame at full export size. */
	exportStill(): Promise<Blob>;
}

interface PassStudioBaseProps {
	/** The member's picture, if any. Fetched to a blob so the canvas stays clean. */
	avatarUrl?: string | null;
	className?: string;
	formatId?: PassFormatId;
	/**
	 * Hold the preview on one frame of the loop, in seconds, instead of running
	 * it. This is what makes the still tab honest: the picture on screen IS the
	 * picture that gets exported, rather than an animation the export samples at
	 * some other angle. Leave it undefined to animate.
	 */
	frame?: number;
	/** Which scheme the card is printed in. The caller resolves it, as everywhere else. */
	isDark: boolean;
	/** Freeze the preview. The export still animates — a file is not page decoration. */
	paused?: boolean;
	/** The canvas's accessible name. Say which card it is a preview OF. */
	previewLabel?: string;
	ref?: RefObject<PassStudioHandle | null>;
	/** Printed under the card, e.g. the site host. */
	wordmark: string;
}

/**
 * Two seams, each expressed as a union so there is exactly one way to say each
 * thing: WHAT the card says (`content` for the waitlist pass, or `face` for any
 * other painter) and what it is PRINTED ON (`seed` for the waitlist backdrop, or
 * `backdrop` for an explicit one). The `?: never` arms are what let both be
 * destructured and what makes passing both a type error rather than a silent
 * precedence rule.
 *
 * `face` and `backdrop` are REQUIRED-STABLE. They are part of the scene's
 * identity, and a scene rebuild awaits the document's fonts, refetches the
 * avatar and repaints three card-sized canvases — so an inline object literal
 * here does that on every render of the component above. Build them in a
 * `useMemo`.
 */
export type PassStudioProps = PassStudioBaseProps &
	(
		| { content: PassFaceContent; face?: never }
		| { content?: never; face: PassFacePainter }
	) &
	(
		| { backdrop?: never; seed: string }
		| { backdrop: PassBackdropSpec; seed?: never }
	);

export function PassStudio({
	avatarUrl,
	backdrop: backdropProp,
	className,
	content,
	face: faceProp,
	formatId = DEFAULT_PASS_FORMAT_ID,
	frame,
	isDark,
	paused = false,
	previewLabel = DEFAULT_PREVIEW_LABEL,
	ref,
	seed,
	wordmark,
}: PassStudioProps) {
	const rootRef = useRef<HTMLDivElement>(null);
	const warpHostRef = useRef<HTMLDivElement>(null);
	const ringHostRef = useRef<HTMLDivElement>(null);
	const previewRef = useRef<HTMLCanvasElement>(null);
	const sceneRef = useRef<PassScene | null>(null);
	const sourcesRef = useRef<PassSceneSources>({
		ring: null,
		ringStill: null,
		warp: null,
	});
	const ringStillRef = useRef<HTMLCanvasElement | null>(null);
	const [ringWarm, setRingWarm] = useState(false);
	const [ready, setReady] = useState(false);
	const [mounted, setMounted] = useState(false);

	const format = passFormat(formatId);
	// Both defaults are memoised UNCONDITIONALLY and chosen from afterwards. The
	// obvious `faceProp ?? useMemo(...)` is a conditional hook, and — worse — a
	// default rebuilt per render would make the scene's identity change every
	// render, which is the one way to turn this refactor into a rebuild-per-frame.
	//
	// So a `face`/`backdrop` consumer does build one unused painter and hash one
	// unused seed. That is deliberate and it is a closure and an integer — do not
	// "save" it by moving either hook behind the branch.
	const fallbackFace = useMemo(
		() => waitlistFacePainter(content ?? NO_CONTENT),
		[content]
	);
	const face = faceProp ?? fallbackFace;
	const fallbackBackdrop = useMemo(
		() => waitlistBackdrop(seed ?? "ryu", isDark),
		[isDark, seed]
	);
	const backdrop = backdropProp ?? fallbackBackdrop;
	// The shader's prop is a mutable `string[]`; the spec's list is readonly, so
	// it is copied — memoised against the spec so the copy is not a fresh array
	// on every render of a mount that diffs its colours.
	const warpColors = useMemo(() => [...backdrop.colors], [backdrop]);

	// The shader's own clock, driven by hand.
	//
	// The mount is held at `speed={0}` and stepped with `setFrame`, so the field
	// is a pure function of the loop's time rather than of when the tab happened
	// to be foregrounded. That is what lets the backdrop PING-PONG: it runs
	// forward for half the cycle and back for the other half, so the last frame
	// of the loop is the first and the shader has no seam either. A field that
	// only ever ran forward would jump at every repeat, which is the one artefact
	// an infinite loop makes impossible to miss.
	const setShaderTime = useCallback((time: number) => {
		// SAFETY: This private host renders only ShaderBackground's native Warp div. The installed Paper ShaderMount attaches its real mount to that same div and deletes it on disposal; the optional read preserves both unmounted cases and the native setFrame receiver. No arbitrary DOM child is admitted.
		const mount = (
			warpHostRef.current?.firstElementChild as
				| PaperShaderElement
				| null
				| undefined
		)?.paperShaderMount;
		if (!mount) {
			return;
		}
		// A RAISED-COSINE ping-pong, not a triangle one.
		//
		// Both return to their starting value at the end of the cycle, so both
		// "loop". But a triangle wave reverses at full speed: the field is flowing
		// one way and, on a single frame, flows the other way just as fast. That
		// reads as a jolt at the halfway point and again at the seam. A cosine
		// eases the shader's clock to a stop and back out, so its velocity is zero
		// exactly where the direction turns and the reversal is invisible.
		const swing =
			((1 - Math.cos((time / PASS_LOOP_SECONDS) * Math.PI * 2)) / 2) *
			(PASS_LOOP_SECONDS / 2);
		mount.setFrame(swing * 1000 * WARP_SPEED);
	}, []);

	// Find the two live canvases once they exist. Queried rather than reffed:
	// both are created imperatively by their libraries inside the host, so there
	// is no React element to attach a ref to.
	useEffect(() => {
		let raf = 0;
		const look = () => {
			const warp = warpHostRef.current?.querySelector("canvas") ?? null;
			const ring =
				ringHostRef.current?.querySelector<HTMLCanvasElement>(
					"canvas.metal-fx-canvas"
				) ?? null;
			sourcesRef.current = {
				ring,
				ringStill: sourcesRef.current.ringStill,
				warp,
			};
			if (!(warp && ring)) {
				raf = requestAnimationFrame(look);
			}
		};
		look();
		return () => cancelAnimationFrame(raf);
	}, []);

	useEffect(() => setMounted(true), []);

	useEffect(() => {
		const timer = setTimeout(() => setRingWarm(true), RING_WARMUP_MS);
		return () => clearTimeout(timer);
	}, []);

	/**
	 * Copy the ring's CURRENT frame, to be dissolved back in as the cycle closes.
	 *
	 * Taken at the instant a loop starts rather than once at warm-up, because what
	 * has to match is the recording's own first frame. `metal-fx` exposes no clock
	 * to seek, so sampling where the band happens to be is the only way to know
	 * where it began.
	 */
	const captureRingStill = useCallback(() => {
		const live = sourcesRef.current.ring;
		if (!(live && live.width > 0)) {
			return;
		}
		const still = document.createElement("canvas");
		still.width = live.width;
		still.height = live.height;
		still.getContext("2d")?.drawImage(live, 0, 0);
		ringStillRef.current = still;
	}, []);

	// Build the scene: the type layer, painted once. Rebuilt only when the facts,
	// the scheme or the loaded font change — never per frame.
	useEffect(() => {
		let cancelled = false;
		const build = async () => {
			const host = rootRef.current;
			if (!host) {
				return;
			}
			// Text measured before the face's font has loaded is measured against a
			// fallback, so the name would be fitted to the wrong metrics and then
			// painted in the right ones.
			await document.fonts?.ready;
			const avatar = await loadAvatar(avatarUrl);
			if (cancelled) {
				return;
			}
			sceneRef.current = new PassScene({
				avatar,
				backdrop,
				face,
				family: readPassFontFamily(host),
				isDark,
				palette: readPassPalette(host),
				wordmark,
			});
			setReady(true);
		};
		build();
		return () => {
			cancelled = true;
		};
	}, [avatarUrl, backdrop, face, isDark, wordmark]);

	const drawInto = useCallback(
		(canvas: HTMLCanvasElement, time: number) => {
			const scene = sceneRef.current;
			const ctx = canvas.getContext("2d");
			if (!(scene && ctx)) {
				return;
			}
			setShaderTime(time);
			// The canvas may be a scaled-down preview; the scene always composes at
			// the format's own size and the transform does the fitting, so the
			// preview and the export are the same picture at two resolutions.
			const scale = canvas.width / format.width;
			ctx.setTransform(scale, 0, 0, scale, 0, 0);
			scene.render(ctx, {
				format,
				sources: {
					...sourcesRef.current,
					// Null until the shared shader has developed a field: a ring sampled
					// before then is a black band, the one thing it must never be in an
					// exported file.
					ring: ringWarm ? sourcesRef.current.ring : null,
					ringStill: ringWarm ? ringStillRef.current : null,
				},
				time,
			});
		},
		[format, ringWarm, setShaderTime]
	);

	// The preview loop.
	useEffect(() => {
		const canvas = previewRef.current;
		if (!(canvas && ready)) {
			return;
		}
		const longEdge = Math.max(format.width, format.height);
		const previewScale = Math.min(1, PREVIEW_LONG_EDGE / longEdge);
		canvas.width = Math.round(format.width * previewScale);
		canvas.height = Math.round(format.height * previewScale);

		const held = frame ?? (paused ? 0 : null);
		if (held !== null) {
			// A held frame still has to be REDRAWN for a beat: the metal ring warms
			// up over ~1.5s and the shader mount may not have produced its canvas
			// yet, so a single draw at mount time freezes the card before either
			// arrived. Redrawing the same frame costs nothing and lands the moment
			// they do.
			let settle = 0;
			const paint = () => {
				drawInto(canvas, held);
				settle += 1;
				if (settle < SETTLE_FRAMES) {
					raf = requestAnimationFrame(paint);
				}
			};
			let raf = requestAnimationFrame(paint);
			return () => cancelAnimationFrame(raf);
		}
		// The preview runs the same cycle the export records, dissolve included, so
		// what it shows is how the file will actually repeat.
		captureRingStill();
		let raf = 0;
		let start = 0;
		const tick = (now: number) => {
			if (start === 0) {
				start = now;
			}
			drawInto(canvas, ((now - start) / 1000) % PASS_LOOP_SECONDS);
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [captureRingStill, drawInto, format, frame, paused, ready]);

	const exportCanvas = useCallback((): HTMLCanvasElement => {
		const canvas = document.createElement("canvas");
		canvas.width = format.width;
		canvas.height = format.height;
		return canvas;
	}, [format]);

	useImperativeHandle(
		ref,
		(): PassStudioHandle => ({
			exportStill: () => {
				const canvas = exportCanvas();
				// The frame the preview is holding, so what was on screen is what
				// lands in the file. Falling back to a few degrees into the turn
				// rather than flat on: a pass photographed square-on is
				// indistinguishable from the flat raster this replaced.
				drawInto(canvas, frame ?? PASS_STILL_TIME);
				return new Promise<Blob>((resolve, reject) => {
					canvas.toBlob((blob) => {
						if (blob) {
							resolve(blob);
						} else {
							reject(new Error("Could not render the pass image"));
						}
					}, "image/png");
				});
			},
			exportLoop: (onProgress, signal) => {
				const canvas = exportCanvas();
				// Pin the ring's opening frame so the cycle can dissolve back to it.
				captureRingStill();
				return recordCanvasLoop({
					canvas,
					fps: PASS_LOOP_FPS,
					onFrame: (time) => drawInto(canvas, time),
					onProgress,
					seconds: PASS_LOOP_SECONDS,
					signal,
				});
			},
			exportGif: (onProgress, signal) => {
				const canvas = exportCanvas();
				captureRingStill();
				return recordCanvasGif({
					canvas,
					onFrame: (time) => drawInto(canvas, time),
					onProgress,
					seconds: PASS_LOOP_SECONDS,
					signal,
				});
			},
		}),
		[captureRingStill, drawInto, exportCanvas, frame]
	);

	// Portalled to `document.body` — see the note at the top of this file.
	// `mounted` gates it because `document` does not exist during the server
	// render, and a portal target has to be there before the first paint.
	const previewBoxStyle: PreviewBoxStyle = {
		"--pass-studio-1-height": drawingLength(CARD_HEIGHT_PX),
		"--pass-studio-1-width": drawingLength(CARD_WIDTH_PX),
	};
	const exportBoxStyle: ExportBoxStyle = {
		"--pass-studio-2-height": drawingLength(CARD_HEIGHT_PX),
		"--pass-studio-2-width": drawingLength(CARD_WIDTH_PX),
	};
	const shaderHosts = mounted
		? createPortal(
				<>
					{/* The two live shader hosts. Card-sized and on-screen (at 1% opacity in
					    the corner) because both libraries stop painting for a host they are
					    told is out of view — see the note at the top of this file. */}
					<div
						aria-hidden="true"
						className={cn(
							"pointer-events-none fixed bottom-0 left-0 z-0 opacity-0",
							drawingStyles.previewBox
						)}
						style={previewBoxStyle}
					>
						<div className="h-full w-full" ref={warpHostRef}>
							<ShaderBackground
								colors={warpColors}
								distortion={WARP_DISTORTION}
								minPixelRatio={3}
								scale={WARP_SCALE}
								softness={WARP_SOFTNESS}
								// Held still and stepped by hand — see `setShaderTime`.
								speed={0}
								swirl={WARP_SWIRL}
								variant="warp"
								// Without this the drawing buffer may already have been cleared
								// by the compositor before the scene samples it, which reads as
								// an intermittently black backdrop rather than as a shader.
								webGlContextAttributes={{ preserveDrawingBuffer: true }}
							/>
						</div>
					</div>
					<div
						aria-hidden="true"
						className={cn(
							"pointer-events-none fixed bottom-0 left-0 z-0 opacity-0",
							drawingStyles.exportBox
						)}
						style={exportBoxStyle}
					>
						<div className="h-full w-full" ref={ringHostRef}>
							<MetalEdge borderRadius={28} className="h-full">
								<div className="h-full w-full" />
							</MetalEdge>
						</div>
					</div>
				</>,
				document.body
			)
		: null;

	const previewImageStyle: PreviewImageStyle = {
		"--pass-studio-3-max-height": drawingLength(PREVIEW_MAX_HEIGHT),
	};
	const exportImageStyle: ExportImageStyle = {
		"--pass-studio-4-max-height": drawingLength(PREVIEW_MAX_HEIGHT),
	};
	return (
		<div className={cn("relative", className)} ref={rootRef}>
			{shaderHosts}

			{/* The preview, letterboxed inside a height-capped box rather than set to
			    the container's width. A 9:16 frame at the width of a dialog is around
			    1200px tall — taller than the viewport, so the ratio the whole feature
			    exists for would have pushed its own buttons off the screen. Sizing
			    from the canvas's INTRINSIC dimensions (set per format in the preview
			    effect) is what keeps every ratio in the same box without a per-ratio
			    rule. */}
			<div
				className={cn(
					"flex items-center justify-center",
					drawingStyles.previewImage
				)}
				style={previewImageStyle}
			>
				<canvas
					aria-label={previewLabel}
					className={cn(
						"h-auto max-h-full w-auto max-w-full rounded-2xl border bg-muted/40",
						drawingStyles.exportImage
					)}
					ref={previewRef}
					style={exportImageStyle}
				/>
			</div>
		</div>
	);
}
