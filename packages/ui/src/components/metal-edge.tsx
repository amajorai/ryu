"use client";

import { MetalFx } from "metal-fx";
import type { CSSProperties } from "react";
import { type ReactNode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { isNativeNumber } from "../lib/native-primitive-observation.ts";
import { cn } from "../lib/utils.ts";
import drawingStyles from "./metal-edge.drawing.module.css";

interface EdgeRailStyle extends CSSProperties {
	"--metal-edge-1-height"?: string | undefined;
	"--metal-edge-1-width"?: string | undefined;
}
interface EdgeRingStyle extends CSSProperties {
	"--metal-edge-2-padding"?: string | undefined;
}
interface PlainRingStyle extends CSSProperties {
	"--metal-edge-3-padding"?: string | undefined;
}
function drawingLength(value: CSSProperties["width"]): string | undefined {
	return isNativeNumber(value) ? `${value}px` : value;
}

/**
 * The metal edge — one tuning of `metal-fx` (metal.jakubantalik.com), shared by
 * every card-shaped surface that wears it.
 *
 * It exists so the ring is one decision rather than five: the waitlist pass, the
 * agent employee badge and the queue screen's own tiles all carry the same
 * chrome, and a per-call-site copy of `preset` / `ringCssPx` / `shaderScale`
 * would drift the moment one of them was retuned. The library ships only
 * `button` (134×40 baseline, 1px ring, shaderScale 1.6) and `circle` variants —
 * neither reads correctly stretched over a card, so the ring is widened and the
 * shader zoomed out here, once.
 *
 * All instances on a page share ONE offscreen WebGL canvas inside `metal-fx`, so
 * ringing several surfaces costs one context, not one per card.
 */

/**
 * Ring thickness for a full-size card (the pass, the badge). Deliberately heavy:
 * at the library's button baseline the edge reads as a hairline on a surface this
 * big, and in light mode it disappeared into the page altogether.
 */
export const METAL_EDGE_RING_PX = 2;
/**
 * Ring thickness for the smaller surfaces — tiles, the invite row, the handle
 * field. It briefly went to 3px while these rings were suspected of not
 * animating; they were in fact frozen for an unrelated reason (see the keep-alive
 * above), and once that was fixed the extra pixel was just a heavier border on a
 * form field. The zoomed-in `small` shader scale is what carries the movement at
 * this size.
 */
export const METAL_EDGE_TILE_RING_PX = 1;
/** Zoomed out from the button baseline of 1.6 — pill-sized features look like noise on a card. */
const METAL_SHADER_SCALE = 0.9;
/**
 * Zoomed IN for small hosts. The card scale puts roughly one pattern feature
 * across a 320px card, which is what makes its edge read as one moving sheet —
 * but on a 66px field that same feature covers the whole band, so the ring
 * changes as a single flat colour and looks static even though it is painting
 * every frame. More features across a short band means visible travel.
 */
const METAL_SHADER_SCALE_SMALL = 2.6;
const METAL_STRENGTH = 1;
/**
 * How long a ring runs before a requested pause takes effect. Long enough for
 * the shader's field to develop — freezing sooner leaves a black band.
 */
const METAL_WARMUP_MS = 1400;

/**
 * A single hidden ring, mounted once per page and never unmounted.
 *
 * This is not decoration — it is a workaround for a teardown in `metal-fx` that
 * is destructive and unrecoverable. When its instance set empties, the library
 * does not merely stop the shared render loop: it deletes the GL program and
 * buffer and calls `WEBGL_lose_context.loseContext()` on the shared canvas, then
 * drops the renderer entirely. React StrictMode — on by default in the Next dev
 * server, absent from the desktop's Vite harness — mounts every component twice
 * (create, destroy, create), so a page whose only ring belongs to one component
 * empties that set mid-mount and kills the context before the second mount
 * arrives. The ring then paints at most one frame and never animates again.
 *
 * That is exactly the shape of the bug on the waitlist screen: dead while the
 * only ring was the handle field, alive the moment a claimed handle added the
 * card's rings, dead again on unreserve.
 *
 * Keeping one instance alive for the life of the document means the count never
 * reaches zero, so the teardown never runs. It costs nothing: instances share a
 * single WebGL canvas, and this one is 8x6 CSS pixels at 1% opacity.
 */
let keepAliveRoot: Root | null = null;

function ensureKeepAlive(): void {
	if (keepAliveRoot || globalThis.document === undefined) {
		return;
	}
	const host = document.createElement("div");
	host.setAttribute("data-metal-keep-alive", "");
	host.setAttribute("aria-hidden", "true");
	host.style.cssText =
		"position:fixed;left:0;bottom:0;width:8px;height:6px;opacity:0.01;pointer-events:none;z-index:0";
	document.body.appendChild(host);
	keepAliveRoot = createRoot(host);
	const edgeRailStyle: EdgeRailStyle = {
		"--metal-edge-1-height": drawingLength(4),
		"--metal-edge-1-width": drawingLength(6),
	};
	keepAliveRoot.render(
		<MetalFx
			borderRadius={2}
			disableGlow
			preset="chromatic"
			ringCssPx={1}
			theme="dark"
			variant="button"
		>
			<div className={drawingStyles.edgeRail} style={edgeRailStyle} />
		</MetalFx>
	);
}

export interface MetalEdgeProps {
	/**
	 * Corner radius in CSS px. Passed explicitly rather than left to `metal-fx`
	 * to read back off the computed style, which it only re-reads on resize.
	 */
	borderRadius: number;
	children: ReactNode;
	className?: string;
	/**
	 * Freeze the animation. A paused instance still gets one frame painted, so
	 * reduced motion gets a static metallic ring rather than a blank canvas.
	 */
	paused?: boolean;
	ringPx?: number;
	/**
	 * Treat this as a small surface — a tile, a field, a row — and zoom the
	 * shader in so the ring visibly travels rather than drifting through one
	 * colour. Defaults to the card tuning.
	 */
	small?: boolean;
	/**
	 * Currently ACCEPTED AND IGNORED: the ring is pinned to the dark tuning for
	 * the reason spelled out at the `theme="dark"` line below, so a resolved page
	 * theme has nothing to change here. Kept on the interface because callers
	 * thread it down alongside the face theme they DO use (`useIsDarkFace` in
	 * `pass-card-shell`), and because un-pinning is a live design question rather
	 * than a settled one.
	 */
	theme?: "auto" | "dark" | "light";
}

export function MetalEdge({
	borderRadius,
	children,
	className,
	paused = false,
	ringPx = METAL_EDGE_RING_PX,
	small = false,
}: MetalEdgeProps) {
	// A requested pause is applied only after a warm-up, and that is a bug fix
	// rather than a flourish. `metal-fx` freezes on whatever frame it last
	// copied, and its FIRST frame is the shader before the plasma field has
	// developed — very nearly black. An instance that mounted already paused
	// (which is every card under `prefers-reduced-motion`) therefore froze on a
	// black band, i.e. no visible ring at all, which is exactly what a user with
	// Reduce Motion turned on saw. Letting it run for a beat and then freezing
	// leaves a still, fully metallic ring: no ongoing animation, but a border
	// that is actually there.
	// The ring is mounted only after the host box has been laid out, and this is
	// the general form of a bug that has now bitten twice.
	//
	// `metal-fx` asks an IntersectionObserver ONCE whether an instance may paint
	// and only revises that answer when the intersection state changes. An
	// instance created against a box that is still being laid out — a tab panel
	// inserted by a data-driven re-render, a field that appears when `/me`
	// resolves — can be told "not visible" on that single callback and never
	// asked again, leaving a ring that paints one frame and then never moves.
	// Waiting two frames means the box exists, has a size, and is where it will
	// stay before the observer ever looks at it.
	const [mounted, setMounted] = useState(false);
	useEffect(() => {
		ensureKeepAlive();
		let raf = 0;
		const first = requestAnimationFrame(() => {
			raf = requestAnimationFrame(() => setMounted(true));
		});
		return () => {
			cancelAnimationFrame(first);
			cancelAnimationFrame(raf);
		};
	}, []);

	const [warm, setWarm] = useState(!paused);
	useEffect(() => {
		if (!paused) {
			setWarm(true);
			return;
		}
		const timer = setTimeout(() => setWarm(true), METAL_WARMUP_MS);
		return () => clearTimeout(timer);
	}, [paused]);

	// Before the ring exists the gutter is still drawn, so nothing shifts when it
	// arrives — only the band goes from empty to chrome.
	if (!mounted) {
		const edgeRingStyle: EdgeRingStyle = {
			"--metal-edge-2-padding": drawingLength(`${ringPx}px`),
		};
		return (
			<div className={cn("w-full", className)}>
				<div
					className={cn(
						"flex h-full w-full flex-col text-foreground",
						drawingStyles.edgeRing
					)}
					style={edgeRingStyle}
				>
					{children}
				</div>
			</div>
		);
	}

	const plainRingStyle: PlainRingStyle = {
		"--metal-edge-3-padding": drawingLength(`${ringPx}px`),
	};
	return (
		<MetalFx
			borderRadius={borderRadius}
			// The ring wrapper is `display: inline-flex` and does NOT stretch its
			// child, so without these the surface renders at its intrinsic content
			// width inside a full-width column and the ring tracks the content while
			// the layout does not. `.metal-fx-content` is `width: 100%` but not
			// `height: 100%`, hence the second selector.
			//
			// The visibility/opacity pair is the fail-open, and it is load-bearing rather
			// than cosmetic. `metal-fx` holds its host at `opacity: 0;
			// visibility: hidden` (inline, hence the `!`) until the shader copies its
			// FIRST frame, and it only ever copies for an instance its
			// IntersectionObserver has called visible. The library's host is a button
			// whose content is its own decoration, so hiding it costs nothing there —
			// but every consumer here nests real content inside the ring, and on the
			// pass card the host is the card FACE. An instance that mounts off-screen,
			// or that is told "not visible" on the single callback the observer gives
			// it, therefore takes the whole face down with it and leaves the card as a
			// bare brushed-metal slab: the extrusion, with nothing in front of it.
			// Forcing the host visible degrades that to what it should always have
			// been — a card with no chrome on its edge yet.
			//
			// `inherit` rather than `visible`: `visibility` is an INHERITED property,
			// so a hard `visible !important` here would also out-vote an ancestor that
			// hides a whole subtree that way — a closed tab panel, an `invisible`
			// wrapper, a popover on its way out — and every consumer of this wrapper
			// would start showing through them. Inheriting overrides only the
			// library's own inline value and leaves the page's intent intact.
			className={cn(
				"w-full opacity-100! [visibility:inherit]! [&>.metal-fx-content]:h-full",
				className
			)}
			// The wandering halo is tuned for a pill-sized button; over a card it
			// stops reading as a glow around an edge and becomes a wash across the
			// whole face. The shader ring — the part that IS the border — still
			// renders.
			disableGlow
			paused={paused && warm}
			preset="chromatic"
			ringCssPx={ringPx}
			shaderScale={small ? METAL_SHADER_SCALE_SMALL : METAL_SHADER_SCALE}
			strength={METAL_STRENGTH}
			// PINNED to the dark tuning, whatever the page theme is. `metal-fx`
			// ships a light tuning that is a near-white chrome — correct on a dark
			// page, invisible on a white one, which is exactly where every consumer
			// of this wrapper renders. Pinning is also what makes the ring the SAME
			// object everywhere: one edge, one look, in both schemes, rather than a
			// border that quietly disappears on half the surfaces in the app.
			theme="dark"
			variant="button"
		>
			{/* The ring gutter, and the whole reason this wrapper exists rather than
			    calling `MetalFx` directly. The library paints its ring at the EDGE of
			    the host box, UNDER the host's content — which is how a bare button,
			    whose background it strips, shows the ring through itself. Anything
			    with a fill of its own (a card face, a `bg-muted` tile, an input)
			    covers the band completely and reads as having no ring at all. A
			    transparent inset of exactly the ring width leaves the band somewhere
			    to show, which is the library's own model rather than a z-index fight
			    with it. Consumers round their own inner surface by
			    `borderRadius - ringPx` so the two stay concentric. */}
			{/* `text-foreground` re-establishes the app's own ink inside the ring.
			    `metal-fx` sets a text colour on its host to match the preset's
			    theme, and this wrapper pins that theme to dark for every consumer —
			    so without this the content inside a ring inherited near-white text.
			    On the light waitlist screen that made the invite link and the handle
			    field read as empty: the text was there, in white, on a pale fill.
			    Children that set their own `text-*` still win. */}
			<div
				className={cn(
					"flex h-full w-full flex-col text-foreground",
					drawingStyles.plainRing
				)}
				style={plainRingStyle}
			>
				{children}
			</div>
		</MetalFx>
	);
}
