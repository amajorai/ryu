import { useLiteralMessages } from "@ryu/i18n/react";
import { Line, Solid } from "../../kit/react/draw.tsx";
import { DISCS, depthAt, EDGES, edgePath, placeOf } from "./geometry.ts";
import { WorkflowRunLive } from "./live.tsx";
import { describeWorkflowRun, WEBHOOK } from "./model.ts";

/**
 * The static drawing: hairline edges, then the node discs far to near. Every part sits in
 * a plain `<g data-stage>` so the live component can lift a picked node or fade the
 * skipped branch by delegation. The pins and the marble are drawn by the live component.
 */

const EDGE_ART = EDGES.map(([from, to]) => (
	<g
		data-branch={from === WEBHOOK || to === WEBHOOK ? "" : undefined}
		data-stage={from}
		key={`edge-${from}-${to}`}
	>
		<Line d={edgePath(from, to)} tone="lo" />
	</g>
));

const DISC_ART = DISCS.map((paths, node) => ({ node, paths }))
	.toSorted(
		(a, b) =>
			depthAt([...placeOf(a.node), 0]) - depthAt([...placeOf(b.node), 0])
	)
	.map(({ node, paths }) => (
		<g data-stage={node} key={`disc-${node}`}>
			<Solid crease="none" paths={paths} tone="mid" />
		</g>
	));

const STATIC = (
	<>
		{EDGE_ART}
		{DISC_ART}
	</>
);

export function WorkflowRunArt() {
	const tl = useLiteralMessages();
	return (
		<WorkflowRunLive description={describeWorkflowRun(tl)}>
			{STATIC}
		</WorkflowRunLive>
	);
}
