import { useEffect, useRef } from "react";
import { type Layout, stepLayout } from "./knowledge-model.ts";
import { cssColor, type Rgb } from "./knowledge-palette.ts";
import {
	DISC_SCALE,
	easeAlpha,
	FOCUS_MARGIN,
	type FreeArea,
	freeArea,
	inFreeArea,
	type KnowledgeRendererProps,
	LABEL_BELOW,
	labelPad,
	labelWidth,
	MAX_FIT_DISC_PX,
	neighbourIndices,
	RING_REACH_PX,
	syncLabels,
} from "./knowledge-stage.ts";

/**
 * The 2D fallback for machines without WebGL: the same force layout (flat),
 * drawn on a canvas with Obsidian's own 2D look. Drag pans, the wheel zooms
 * around the pointer, and the same projection feeds labels and picking.
 */

const FLIGHT_SECONDS = 1.2;
/** Pointer travel (px) before a press becomes a pan. */
const DRAG_SLOP = 4;
/** Flat discs read larger than shaded 3D ones at the same size; scale down. */
/** Where an agent's inner cut sits, as a share of its radius. */
const AGENT_CUT = 0.62;
const FLAT_NODE_SCALE = DISC_SCALE.flat;

interface FlatView {
	autoFit: boolean;
	first: boolean;
	flight: {
		id: string | null;
		k: number | null;
		/** A world point to centre in the free area (inset changes). */
		point?: [number, number];
		started: number;
	} | null;
	/** The settings card inset the framing was last computed for. */
	inset: number;
	k: number;
	pending: string | null;
	/** Whether the first frame has been reported to the host. */
	ready: boolean;
	x: number;
	y: number;
}

/**
 * Scale and centre that fit every node, and the label under it, inside the
 * free area, each axis on its own so portrait stages fill their height.
 */
export function fitFlat(
	layout: Layout,
	area: FreeArea,
	labels: ReadonlyMap<string, HTMLElement>,
	minRadius: number,
	subset: ReadonlySet<number> | null = null
): { k: number; x: number; y: number } {
	const count = layout.ids.length;
	const included = (index: number) => subset === null || subset.has(index);
	const halfW = (area.right - area.left) / 2;
	const halfH = (area.bottom - area.top) / 2;
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (let index = 0; index < count; index += 1) {
		if (!included(index)) {
			continue;
		}
		const x = layout.positions[index * 3] ?? 0;
		const y = layout.positions[index * 3 + 1] ?? 0;
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
	}
	if (!Number.isFinite(minX)) {
		// Nothing to frame (every node filtered out): frame the origin at
		// the minimum radius so the camera never goes NaN.
		return {
			k: Math.min(halfW, halfH) / Math.max(1, minRadius),
			x: 0,
			y: 0,
		};
	}
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	let k = Math.min(halfW, halfH) / Math.max(1, minRadius);
	for (let index = 0; index < count; index += 1) {
		if (!included(index)) {
			continue;
		}
		const radius = (layout.radii[index] ?? 0) * FLAT_NODE_SCALE;
		const x = Math.abs((layout.positions[index * 3] ?? 0) - cx) + radius;
		const y = (layout.positions[index * 3 + 1] ?? 0) - cy;
		const pad = labelPad(labelWidth(labels.get(layout.ids[index] ?? "")), area);
		const roomX = Math.max(24, halfW - pad);
		const roomY = Math.max(24, halfH - (y > 0 ? LABEL_BELOW : 6));
		k = Math.min(
			k,
			roomX / Math.max(x, 1e-3),
			roomY / (Math.abs(y) + radius),
			// A small subgraph keeps the global node scale.
			MAX_FIT_DISC_PX / Math.max(radius, 1e-3)
		);
	}
	return { k, x: cx, y: cy };
}

/** View centre that puts a world point at the centre of the free area. */
function anchorFlat(
	point: readonly [number, number],
	area: FreeArea,
	width: number,
	height: number,
	k: number
): [number, number] {
	return [
		point[0] - ((area.left + area.right) / 2 - width / 2) / k,
		point[1] - ((area.top + area.bottom) / 2 - height / 2) / k,
	];
}

function channel(colors: Float32Array, index: number): Rgb {
	return [
		Math.round((colors[index * 3] ?? 0) * 255),
		Math.round((colors[index * 3 + 1] ?? 0) * 255),
		Math.round((colors[index * 3 + 2] ?? 0) * 255),
	];
}

export function KnowledgeFlat(props: KnowledgeRendererProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const latest = useRef(props);
	latest.current = props;
	const view = useRef<FlatView>({
		autoFit: true,
		first: true,
		flight: null,
		inset: props.insetRight,
		k: 1,
		pending: props.focusId,
		ready: false,
		x: 0,
		y: 0,
	});
	const nodeAlpha = useRef(new Float32Array(0));
	const linkAlpha = useRef(new Float32Array(0));
	const clock = useRef(0);
	const { cameraApi, layout, paused } = props;

	useEffect(() => {
		nodeAlpha.current = new Float32Array(layout.ids.length);
		linkAlpha.current = new Float32Array(layout.links.length / 2);
	}, [layout]);

	useEffect(() => {
		const focus = (id: string) => {
			view.current.pending = null;
			// While the whole graph is framed every node is already in view.
			if (view.current.autoFit) {
				return;
			}
			view.current.flight = { id, k: null, started: clock.current };
		};
		cameraApi.current = {
			focus,
			// The 2D view draws every animation frame anyway.
			invalidate: () => undefined,
			reveal: (id) => {
				const current = latest.current;
				const canvas = canvasRef.current;
				const index = current.layout.index.get(id);
				const area = freeArea(
					canvas?.clientWidth ?? 0,
					canvas?.clientHeight ?? 0,
					current.insetRight
				);
				if (
					index === undefined ||
					!inFreeArea(current.projection, index, area)
				) {
					focus(id);
				}
			},
			reset: () => {
				view.current.autoFit = true;
				view.current.flight = null;
			},
			zoom: (factor) => {
				view.current.autoFit = false;
				view.current.flight = {
					id: null,
					k: view.current.k / factor,
					started: clock.current,
				};
			},
		};
		return () => {
			cameraApi.current = null;
		};
	}, [cameraApi]);

	// Wheel zoom around the pointer and drag to pan.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) {
			return;
		}
		let drag: { moved: boolean; x: number; y: number } | null = null;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const state = view.current;
			const rect = canvas.getBoundingClientRect();
			const px = event.clientX - rect.left - rect.width / 2;
			const py = event.clientY - rect.top - rect.height / 2;
			const worldX = state.x + px / state.k;
			const worldY = state.y + py / state.k;
			const k = Math.min(
				12,
				Math.max(0.08, state.k * Math.exp(-event.deltaY * 0.0015))
			);
			state.k = k;
			state.x = worldX - px / k;
			state.y = worldY - py / k;
			state.autoFit = false;
			state.flight = null;
		};
		const onDown = (event: PointerEvent) => {
			drag = { moved: false, x: event.clientX, y: event.clientY };
		};
		const onMove = (event: PointerEvent) => {
			if (!drag) {
				return;
			}
			// A click wobbles by a pixel or two: only a real drag pans (and
			// stops the auto-fit).
			if (
				!drag.moved &&
				Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_SLOP
			) {
				return;
			}
			drag.moved = true;
			const state = view.current;
			state.x -= (event.clientX - drag.x) / state.k;
			state.y -= (event.clientY - drag.y) / state.k;
			drag = { moved: true, x: event.clientX, y: event.clientY };
			state.autoFit = false;
			state.flight = null;
		};
		const onUp = () => {
			drag = null;
		};
		canvas.addEventListener("wheel", onWheel, { passive: false });
		canvas.addEventListener("pointerdown", onDown);
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		return () => {
			canvas.removeEventListener("wheel", onWheel);
			canvas.removeEventListener("pointerdown", onDown);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
	}, []);

	useEffect(() => {
		if (paused) {
			return;
		}
		let frame = 0;
		let last = performance.now();
		const draw = (now: number) => {
			frame = requestAnimationFrame(draw);
			const delta = Math.min(0.1, (now - last) / 1000);
			last = now;
			clock.current += delta;
			const canvas = canvasRef.current;
			const context = canvas?.getContext("2d");
			if (!(canvas && context)) {
				return;
			}
			const current = latest.current;
			const graph = current.layout;
			if (!current.reduced) {
				stepLayout(graph, current.forces);
			}
			const width = canvas.clientWidth;
			const height = canvas.clientHeight;
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			if (canvas.width !== Math.round(width * dpr)) {
				canvas.width = Math.round(width * dpr);
				canvas.height = Math.round(height * dpr);
			}
			if (canvas.height !== Math.round(height * dpr)) {
				canvas.height = Math.round(height * dpr);
			}

			const state = view.current;
			const ease =
				current.reduced || state.first ? 1 : 1 - Math.exp(-delta * 4.5);
			const area = freeArea(width, height, current.insetRight);
			if (state.inset !== current.insetRight) {
				// The settings card opened or closed: keep what sat in the
				// middle of the old free area in the middle of the new one.
				const before = freeArea(width, height, state.inset);
				state.inset = current.insetRight;
				if (!(state.autoFit || state.flight)) {
					state.flight = {
						id: null,
						k: null,
						point: [
							state.x +
								((before.left + before.right) / 2 - width / 2) / state.k,
							state.y +
								((before.top + before.bottom) / 2 - height / 2) / state.k,
						],
						started: clock.current,
					};
				}
			}
			const fit = fitFlat(
				graph,
				area,
				current.labels,
				current.forces.linkDistance * 1.6
			);
			if (!state.first && state.pending) {
				const id = state.pending;
				state.pending = null;
				if (!state.autoFit) {
					state.flight = { id, k: null, started: clock.current };
				}
			}
			if (state.autoFit) {
				state.k += (fit.k - state.k) * ease;
				const [goalX, goalY] = anchorFlat(
					[fit.x, fit.y],
					area,
					width,
					height,
					fit.k
				);
				state.x += (goalX - state.x) * ease;
				state.y += (goalY - state.y) * ease;
			}
			if (state.flight) {
				// A node flight frames the node with its neighbours inside the
				// free area; a zoom flight only changes the scale.
				const flightIndex = state.flight.id
					? graph.index.get(state.flight.id)
					: undefined;
				const near =
					flightIndex === undefined
						? null
						: fitFlat(
								graph,
								area,
								current.labels,
								current.forces.linkDistance * 0.8,
								neighbourIndices(graph, flightIndex)
							);
				// Never zoom in; zoom out only as far as the neighbourhood needs.
				const goalK = near
					? Math.max(fit.k, Math.min(near.k / FOCUS_MARGIN, state.k))
					: state.flight.k;
				if (goalK !== null) {
					state.k += (goalK - state.k) * ease;
				}
				const point = near ? ([near.x, near.y] as const) : state.flight.point;
				if (point) {
					const [goalX, goalY] = anchorFlat(
						point,
						area,
						width,
						height,
						goalK ?? state.k
					);
					state.x += (goalX - state.x) * ease;
					state.y += (goalY - state.y) * ease;
				}
				if (clock.current - state.flight.started > FLIGHT_SECONDS) {
					state.flight = null;
				}
			}
			state.first = false;

			const styles = current.styles;
			const amount = current.reduced ? 1 : 1 - Math.exp(-delta * 12);
			if (nodeAlpha.current.length !== styles.alpha.length) {
				nodeAlpha.current = new Float32Array(styles.alpha.length);
			}
			if (linkAlpha.current.length !== styles.linkAlpha.length) {
				linkAlpha.current = new Float32Array(styles.linkAlpha.length);
			}
			easeAlpha(nodeAlpha.current, styles.alpha, amount);
			easeAlpha(linkAlpha.current, styles.linkAlpha, amount);

			const projection = current.projection;
			const count = graph.ids.length;
			for (let index = 0; index < count; index += 1) {
				const sx =
					((graph.positions[index * 3] ?? 0) - state.x) * state.k + width / 2;
				const sy =
					((graph.positions[index * 3 + 1] ?? 0) - state.y) * state.k +
					height / 2;
				projection.x[index] = sx;
				projection.y[index] = sy;
				projection.depth[index] = 0;
				projection.fog[index] = 0;
				projection.radius[index] =
					(styles.size[index] ?? 2) * state.k * FLAT_NODE_SCALE;
				projection.visible[index] =
					sx > -60 && sy > -60 && sx < width + 60 && sy < height + 60 ? 1 : 0;
			}

			context.setTransform(dpr, 0, 0, dpr, 0, 0);
			context.clearRect(0, 0, width, height);
			context.lineWidth = current.linkWidth;
			const linkCount = graph.links.length / 2;
			for (let link = 0; link < linkCount; link += 1) {
				const source = graph.links[link * 2] ?? 0;
				const target = graph.links[link * 2 + 1] ?? 0;
				context.strokeStyle = cssColor(
					channel(styles.linkColors, link),
					linkAlpha.current[link] ?? 0
				);
				context.beginPath();
				context.moveTo(projection.x[source] ?? 0, projection.y[source] ?? 0);
				context.lineTo(projection.x[target] ?? 0, projection.y[target] ?? 0);
				context.stroke();
			}
			const ring = current.palette.highlight;
			for (let index = 0; index < count; index += 1) {
				if (!projection.visible[index]) {
					continue;
				}
				const x = projection.x[index] ?? 0;
				const y = projection.y[index] ?? 0;
				const radius = Math.max(1.5, projection.radius[index] ?? 0);
				const alpha = nodeAlpha.current[index] ?? 1;
				context.fillStyle = cssColor(channel(styles.colors, index), alpha);
				context.beginPath();
				context.arc(x, y, radius, 0, Math.PI * 2);
				context.fill();
				if (styles.agent[index] && radius >= 4) {
					// Agents: the same hairline cut inside the disc as in 3D.
					const cut = Math.max(1.25, radius * 0.1);
					context.strokeStyle = cssColor(current.palette.background, alpha);
					context.lineWidth = cut;
					context.beginPath();
					context.arc(x, y, radius * AGENT_CUT + cut / 2, 0, Math.PI * 2);
					context.stroke();
				}
				if (styles.ring[index]) {
					context.strokeStyle = cssColor(
						ring,
						alpha * (styles.ring[index] ?? 1)
					);
					// The same ring as the 3D view: a 2px gap, then a 2px band.
					context.lineWidth = 2;
					context.beginPath();
					context.arc(x, y, radius + RING_REACH_PX - 1, 0, Math.PI * 2);
					context.stroke();
				}
			}
			syncLabels(graph, projection, styles, nodeAlpha.current, current.labels, {
				height,
				obstacles: current.obstacles(),
				textFade: current.textFade,
				width,
			});
			if (!state.ready) {
				state.ready = true;
				current.onReady?.();
			}
		};
		frame = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(frame);
	}, [paused]);

	return (
		<canvas className="absolute inset-0 size-full touch-none" ref={canvasRef} />
	);
}
