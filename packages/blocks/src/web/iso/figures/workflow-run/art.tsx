import { Line, Solid } from "../../kit/react/draw.tsx";
import { DISCS, depthAt, EDGES, edgePath, placeOf } from "./geometry.ts";
import { WorkflowRunLive } from "./live.tsx";
import { WEBHOOK } from "./model.ts";

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

const DESCRIPTION =
	"One Ryu workflow run, drawn as a marble rolling through seven nodes in order: input, prompt, a condition, then one of two branches (tool or webhook), an approval gate and output. The condition takes the tool branch, so the webhook branch fades out as skipped. The marble waits at the approval gate until the run is approved. A pin rises on each node as it finishes: the checkpoint Core writes to disk after every node, which is what lets an interrupted run resume. Every checkpoint is kept; only the latest pin is drawn standing. This is a slowed simulation with an example graph. Arrow keys pick a node to hear its state.";

export function WorkflowRunArt() {
	return <WorkflowRunLive description={DESCRIPTION}>{STATIC}</WorkflowRunLive>;
}
