import { BaseEdge, type EdgeProps, type EdgeTypes } from "@xyflow/react";
import { type CSSProperties, useEffect, useState } from "react";
import {
	GRAPH_NODE_SIZE,
	type GraphEmphasis,
	stepToward,
} from "./graph-model.ts";
import type { GraphEdgeData, GraphFlowEdge } from "./graph-nodes.tsx";

/** The Graph map's edges: styles by emphasis and the live-run mark. */

const EDGE_OPACITY: Record<GraphEmphasis, number> = {
	dimmed: 0.15,
	focus: 1,
	normal: 1,
	related: 1,
};

/**
 * Every line is straight and neutral; the selection's lines take the
 * theme's primary. Spokes to you grow heavier with more threads together,
 * links between agents stay hairlines, and memberships are dashed.
 */
function edgeStyle(data: GraphEdgeData): CSSProperties {
	const weight = Math.max(1, data.weight);
	const focus = data.emphasis === "focus";
	const stroke = focus ? "var(--primary)" : "var(--muted-foreground)";
	const base: CSSProperties = {
		opacity: EDGE_OPACITY[data.emphasis],
		stroke,
		strokeLinecap: "round",
	};
	switch (data.kind) {
		case "talks":
			return {
				...base,
				strokeOpacity: focus ? 1 : Math.min(0.7, 0.35 + 0.1 * weight),
				strokeWidth: Math.min(3, 1 + (weight - 1) * 0.5),
			};
		case "collaborates":
			return { ...base, strokeOpacity: focus ? 0.7 : 0.35, strokeWidth: 1 };
		default:
			return {
				...base,
				strokeDasharray: "3 3",
				strokeOpacity: focus ? 0.7 : 0.35,
				strokeWidth: 1,
			};
	}
}

/** The live dot makes a few trips toward you, then the line goes still. */
const LIVE_LOOPS = 3;
const LIVE_LOOP_SECONDS = 2.4;

/**
 * A live spoke carries one dot toward you a few times, then leaves the
 * avatar's working ring to say "working". Nothing with reduced motion.
 */
function LiveMark({ data, path }: { data: GraphEdgeData; path: string }) {
	const [moving, setMoving] = useState(data.motion);
	useEffect(() => {
		if (!data.motion) {
			setMoving(false);
			return;
		}
		setMoving(true);
		const timer = window.setTimeout(
			() => setMoving(false),
			LIVE_LOOPS * LIVE_LOOP_SECONDS * 1000
		);
		return () => window.clearTimeout(timer);
	}, [data.motion]);
	if (!moving) {
		return null;
	}
	return (
		<circle
			className="pointer-events-none"
			r={3}
			style={{
				fill: "var(--success)",
				opacity: EDGE_OPACITY[data.emphasis],
				stroke: "var(--background)",
				strokeWidth: 1.5,
			}}
		>
			<animateMotion
				calcMode="linear"
				dur={`${LIVE_LOOP_SECONDS}s`}
				keyPoints="1;0"
				keyTimes="0;1"
				path={path}
				repeatCount={LIVE_LOOPS}
			/>
		</circle>
	);
}

/** Lines stop this far outside a round node's edge. */
const EDGE_CLEARANCE = 3;
const AGENT_REACH = GRAPH_NODE_SIZE.agent.width / 2 + EDGE_CLEARANCE;
const YOU_REACH = GRAPH_NODE_SIZE.you.width / 2 + EDGE_CLEARANCE;

/** Straight lines between node edges; group ends tuck under their pill. */
function GraphMapEdge({
	data,
	source: sourceId,
	sourceX,
	sourceY,
	targetX,
	targetY,
}: EdgeProps<GraphFlowEdge>) {
	if (!data) {
		return null;
	}
	const source = { x: sourceX, y: sourceY };
	const target = { x: targetX, y: targetY };
	let start = source;
	if (sourceId === "you") {
		start = stepToward(source, target, YOU_REACH);
	} else if (sourceId.startsWith("agent:")) {
		start = stepToward(source, target, AGENT_REACH);
	}
	// Every line reaches the avatar's edge; a name's halo keeps a line that
	// passes behind it legible.
	const end = stepToward(target, source, AGENT_REACH);
	const path = `M ${start.x},${start.y} L ${end.x},${end.y}`;
	return (
		<>
			<BaseEdge interactionWidth={0} path={path} style={edgeStyle(data)} />
			{data.live ? <LiveMark data={data} path={path} /> : null}
		</>
	);
}

export const GRAPH_EDGE_TYPES: EdgeTypes = { graph: GraphMapEdge };
