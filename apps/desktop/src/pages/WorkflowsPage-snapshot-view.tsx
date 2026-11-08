// apps/desktop/src/pages/WorkflowsPage-snapshot-view.tsx
//
// The on-page "Current workflow" card body. `workflowSnapshot()` in
// WorkflowsPage.tsx stays English because the workflow builder hands it to the
// model; this renderer builds the visible copy through `tl()` instead, since the
// DOM localizer skips text inside `<pre>`. Node ids, types, edge endpoints,
// branches and trigger types are data and stay verbatim.

import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import type { Workflow } from "@/src/lib/api/workflows.ts";

/** The localized, human-readable snapshot shown on the Workflows page. */
export function workflowSnapshotDisplay(
	wf: Workflow | null,
	tl: LiteralMessage
): string {
	if (!wf) {
		return tl("(empty — no nodes yet)");
	}
	const none = `  ${tl("(none)")}`;
	const nodes =
		wf.nodes.map((n) => `  - ${n.id} (${n.type})`).join("\n") || none;
	const edges =
		wf.edges
			.map((e) => `  - ${e.from} -> ${e.to}${e.branch ? ` [${e.branch}]` : ""}`)
			.join("\n") || none;
	const triggers = wf.triggers.map((t) => t.type).join(", ") || tl("manual");
	return [
		tl("Name: {name}", { name: wf.name }),
		tl("Description: {description}", { description: wf.description ?? "" }),
		tl("Triggers: {triggers}", { triggers }),
		tl("Nodes:"),
		nodes,
		tl("Edges:"),
		edges,
	].join("\n");
}

export function WorkflowSnapshotView({
	workflow,
}: {
	workflow: Workflow | null;
}) {
	const tl = useLiteralMessages();
	return (
		<pre
			className="overflow-x-auto whitespace-pre-wrap text-muted-foreground text-xs leading-relaxed"
			dir="auto"
		>
			{workflowSnapshotDisplay(workflow, tl)}
		</pre>
	);
}
