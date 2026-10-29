"use client";

// Gateway canvas links and the pulse layer. Links are drawn from the layout
// (straight segments between node edges), and pulses ride the same points, so
// a dot never leaves its line. A blocked pulse stops at the deciding layer
// and leaves a short-lived stop mark there.

import {
	BaseEdge,
	type Edge,
	type EdgeProps,
	ViewportPortal,
} from "@xyflow/react";
import {
	type CSSProperties,
	useEffect,
	useRef,
	useSyncExternalStore,
} from "react";
import type { CanvasLayout } from "./layout.ts";
import { pulsePath } from "./layout.ts";
import type { ActivePulse, CanvasLiveStore } from "./live-store.ts";
import type { CanvasEdgeKind, PulseOutcome } from "./model.ts";

export interface CanvasFlowEdgeData extends Record<string, unknown> {
	d: string;
	kind: CanvasEdgeKind;
}

export type CanvasFlowEdge = Edge<CanvasFlowEdgeData, "gateway-canvas">;

export const EDGE_STROKE: Record<CanvasEdgeKind, CSSProperties> = {
	assignment: {
		stroke: "var(--primary)",
		strokeDasharray: "2 4",
		strokeOpacity: 0.6,
		strokeWidth: 1.25,
	},
	control: {
		stroke: "var(--muted-foreground)",
		strokeDasharray: "4 4",
		strokeOpacity: 0.45,
		strokeWidth: 1,
	},
	traffic: {
		stroke: "var(--muted-foreground)",
		strokeOpacity: 0.55,
		strokeWidth: 1.25,
	},
};

function GatewayCanvasEdge({ data, id }: EdgeProps<CanvasFlowEdge>) {
	if (!data) {
		return null;
	}
	return <BaseEdge id={id} path={data.d} style={EDGE_STROKE[data.kind]} />;
}

/** Module level, so React Flow never sees a new map (spec 07.5). */
export const CANVAS_EDGE_TYPES = { "gateway-canvas": GatewayCanvasEdge };

export const OUTCOME_COLOR: Record<PulseOutcome, string> = {
	allow: "var(--success)",
	block: "var(--destructive)",
	cache_hit: "var(--foreground)",
	degraded: "var(--info)",
	error: "var(--muted-foreground)",
	redacted: "var(--warning)",
};

/** Travel speed in flow pixels per second, clamped to a readable duration. */
const PULSE_SPEED = 900;
const MIN_SECONDS = 0.7;
const MAX_SECONDS = 1.6;

function pathLength(d: string): number {
	let length = 0;
	let last: [number, number] | null = null;
	for (const match of d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) {
		const point: [number, number] = [Number(match[1]), Number(match[2])];
		if (last) {
			length += Math.hypot(point[0] - last[0], point[1] - last[1]);
		}
		last = point;
	}
	return length;
}

function endPoint(d: string): { x: number; y: number } | null {
	const matches = [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)];
	const last = matches.at(-1);
	return last ? { x: Number(last[1]), y: Number(last[2]) } : null;
}

/**
 * SMIL needs an explicit start for elements added after the SVG began. The
 * dot stays hidden until its motion starts, so it never flashes at the
 * origin for a frame.
 */
function useBeginNow() {
	const motion = useRef<SVGAnimateMotionElement>(null);
	const dot = useRef<SVGCircleElement>(null);
	useEffect(() => {
		const element = motion.current;
		const show = () => dot.current?.setAttribute("opacity", "1");
		if (!(element && typeof element.beginElement === "function")) {
			show();
			return;
		}
		// Reveal on the frame after the motion has been sampled once.
		let frame = 0;
		const onBegin = () => {
			frame = window.requestAnimationFrame(show);
		};
		element.addEventListener("beginEvent", onBegin, { once: true });
		element.beginElement();
		return () => {
			element.removeEventListener("beginEvent", onBegin);
			window.cancelAnimationFrame(frame);
		};
	}, []);
	return { dot, motion };
}

function PulseDot({ entry, d }: { d: string; entry: ActivePulse }) {
	const { outcome } = entry.pulse;
	const seconds = Math.min(
		MAX_SECONDS,
		Math.max(MIN_SECONDS, pathLength(d) / PULSE_SPEED)
	);
	const { dot, motion } = useBeginNow();
	const color = OUTCOME_COLOR[outcome];
	const motionId = `canvas-pulse-${entry.id}`;
	const stop = outcome === "block" ? endPoint(d) : null;
	return (
		<g data-outcome={outcome} data-pulse={entry.id}>
			<circle
				opacity={0}
				r={3.5}
				ref={dot}
				style={{ fill: color, stroke: "var(--background)", strokeWidth: 1.5 }}
			>
				<animateMotion
					begin="indefinite"
					calcMode="linear"
					dur={`${seconds}s`}
					fill="freeze"
					id={motionId}
					path={d}
					ref={motion}
				/>
				{stop ? null : (
					<animate
						attributeName="opacity"
						begin={`${motionId}.end`}
						dur="0.3s"
						fill="freeze"
						to="0"
					/>
				)}
			</circle>
			{stop ? (
				<circle
					cx={stop.x}
					cy={stop.y}
					opacity={0}
					r={7}
					style={{ fill: "none", stroke: color, strokeWidth: 2 }}
				>
					<set attributeName="opacity" begin={`${motionId}.end`} to="1" />
					<animate
						attributeName="opacity"
						begin={`${motionId}.end+0.4s`}
						dur="0.5s"
						fill="freeze"
						from="1"
						to="0"
					/>
				</circle>
			) : null}
		</g>
	);
}

export function PulseLayer({
	layout,
	store,
}: {
	layout: CanvasLayout;
	store: CanvasLiveStore;
}) {
	const pulses = useSyncExternalStore(
		store.subscribe,
		store.pulses,
		store.pulses
	);
	if (pulses.length === 0) {
		return null;
	}
	return (
		<ViewportPortal>
			<svg
				aria-hidden="true"
				className="pointer-events-none absolute top-0 left-0 overflow-visible"
				data-canvas-pulses={pulses.length}
				height={1}
				width={1}
			>
				{pulses.map((entry) => {
					const d = pulsePath(entry.pulse.path, layout);
					return d ? <PulseDot d={d} entry={entry} key={entry.id} /> : null;
				})}
			</svg>
		</ViewportPortal>
	);
}
