// apps/desktop/src/pages/WorkflowsPage.tsx
//
// The natural-language **workflow builder** shell surface.
//
// The React Flow canvas (edit nodes/edges, triggers, run, resume, record→workflow)
// now lives in the sandboxed `com.ryu.workflows` companion app
// (`packages/workflows-app`, mounted at `/workflows/:id` via PluginCompanionPage).
// The one piece that CANNOT move into the sandbox is the NL builder: it drives
// Core's `workflow_builder__*` MCP tools through the shell's global Ask Ryu panel
// (`useAssistantBuilder`), and `host.runAgent`'s fixed `PermissionPreset` never
// exposes those tools to a sandboxed frame (Track E crux #1, `delegation.rs`). So
// the builder stays shell-side, permanently, and this page is its home.
//
// Reachability: opened via `/workflows/build` (a fresh draft) or
// `/workflows/build/:id` (build an existing workflow); the Create menu exposes
// "Build with AI". Documented limitation: because the shell and the sandboxed
// canvas are isolated, a builder edit here does NOT live-refresh an already-open
// canvas tab — reopen the canvas ("Open in canvas" below) to see the new graph.

import { WorkflowSquare01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Spinner } from "@ryu/ui/components/spinner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useTitleBar } from "@/src/contexts/TitleBarContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAssistantBuilder } from "@/src/hooks/useAssistantBuilder.ts";
import {
	notifyWorkflowsChanged,
	useWorkflows,
} from "@/src/hooks/useWorkflows.ts";
import { fetchWorkflow, type Workflow } from "@/src/lib/api/workflows.ts";

/** Compact, model-readable summary of a workflow definition for the builder
 *  preamble AND the on-page snapshot. Mirrors the agent builder's `agentSnapshot`. */
function workflowSnapshot(wf: Workflow | null): string {
	if (!wf) {
		return "(empty — no nodes yet)";
	}
	const nodes =
		wf.nodes.map((n) => `  - ${n.id} (${n.type})`).join("\n") || "  (none)";
	const edges =
		wf.edges
			.map((e) => `  - ${e.from} -> ${e.to}${e.branch ? ` [${e.branch}]` : ""}`)
			.join("\n") || "  (none)";
	const triggers = wf.triggers.map((t) => t.type).join(", ") || "manual";
	return `Name: ${wf.name}\nDescription: ${wf.description ?? ""}\nTriggers: ${triggers}\nNodes:\n${nodes}\nEdges:\n${edges}`;
}

export interface WorkflowsPageProps {
	/** Workflow id to build, or null/undefined to start a fresh draft. */
	initialWorkflowId?: string | null;
}

export default function WorkflowsPage({
	initialWorkflowId = null,
}: WorkflowsPageProps) {
	const { workflows, loading, error, create, reload } = useWorkflows();
	const { openTab } = useTabsContext();
	const activeNode = useActiveNode();
	const target = useMemo(
		() => ({ url: activeNode.url, token: activeNode.token ?? null }),
		[activeNode.url, activeNode.token]
	);

	const [selected, setSelected] = useState<Workflow | null>(null);
	// A workflow id the builder created as a draft while the route is still
	// `/workflows/build` (initialWorkflowId null). Keeps the initialWorkflowId
	// effect from resetting `selected` back to null on a background list reload.
	const adoptedDraftRef = useRef<string | null>(null);

	// Resolve the selected workflow from the id the route opened us with. Once the
	// list loads, find the match; a null id means "new workflow" (build a fresh
	// draft on first message). Re-runs only when the id or the loaded set changes.
	useEffect(() => {
		if (initialWorkflowId) {
			adoptedDraftRef.current = null;
			const match = workflows.find((w) => w.id === initialWorkflowId);
			if (match) {
				setSelected((prev) => (prev?.id === match.id ? prev : match));
			}
			return;
		}
		const draftId = adoptedDraftRef.current;
		if (draftId) {
			const match = workflows.find((w) => w.id === draftId);
			if (match) {
				setSelected((prev) => (prev?.id === match.id ? prev : match));
			}
			return;
		}
		setSelected((prev) => (prev === null ? prev : null));
	}, [initialWorkflowId, workflows]);

	// Lazily resolve the workflow id the builder edits: reuse the selected
	// workflow, or create an empty draft on the first builder message (the
	// new-workflow chicken-and-egg, mirroring the agent builder).
	const resolveWorkflowId = useCallback(async () => {
		if (selected) {
			return selected.id;
		}
		try {
			const draft = await create({
				id: "",
				name: "New workflow",
				nodes: [],
				edges: [],
				triggers: [],
			});
			adoptedDraftRef.current = draft.id;
			setSelected(draft);
			return draft.id;
		} catch {
			return null;
		}
	}, [selected, create]);

	// After a builder turn settles, re-read the persisted definition so the
	// on-page snapshot + the sidebar list reflect the new graph.
	const handleWorkflowChanged = useCallback(
		async (id: string) => {
			try {
				const wf = await fetchWorkflow(target, id);
				setSelected(wf);
				notifyWorkflowsChanged();
			} catch {
				// A transient fetch failure shouldn't break the chat thread.
			}
		},
		[target]
	);

	const builderSnapshot = useMemo(() => workflowSnapshot(selected), [selected]);

	// Hand the global Ask Ryu panel over to the workflow builder while this page is
	// focused — it docks as a sidebar and drives the `workflow_builder__*` tools.
	useAssistantBuilder({
		kind: "workflow",
		onChanged: handleWorkflowChanged,
		resolveId: resolveWorkflowId,
		snapshot: builderSnapshot,
		targetId: selected?.id ?? null,
		targetName: selected?.name ?? "New workflow",
	});

	const titleBarTitle = useMemo(
		() => (
			<span className="flex min-w-0 items-center gap-2">
				<HugeiconsIcon
					className="size-4 shrink-0 opacity-70"
					icon={WorkflowSquare01Icon}
				/>
				<span className="truncate font-semibold">
					{selected?.name?.trim() || "Build a workflow"}
				</span>
			</span>
		),
		[selected?.name]
	);
	useTitleBar(titleBarTitle, null);

	if (loading && initialWorkflowId && !selected) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

	if (error) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={WorkflowSquare01Icon} />
					</EmptyMedia>
					<EmptyTitle>Could not load your workflows</EmptyTitle>
					<EmptyDescription>
						Something went wrong while loading your workflows. Check your
						connection and try again.
					</EmptyDescription>
				</EmptyHeader>
				<Button onClick={() => reload()} variant="outline">
					Try again
				</Button>
			</Empty>
		);
	}

	return (
		<div className="flex h-full overflow-hidden">
			{/* Left rail: pick a workflow to build with AI, or start fresh. Mirrors the
			    Create-menu "Build with AI" entry so any existing workflow is reachable
			    for NL editing (the canvas lives in the companion app). */}
			<aside className="flex w-60 shrink-0 flex-col border-border border-r">
				<div className="flex items-center gap-2 border-border border-b px-3 py-2.5">
					<HugeiconsIcon
						className="size-4 opacity-70"
						icon={WorkflowSquare01Icon}
					/>
					<span className="font-semibold text-sm">Build with AI</span>
				</div>
				<div className="p-2">
					<Button
						className="w-full justify-start"
						onClick={() => {
							adoptedDraftRef.current = null;
							setSelected(null);
						}}
						size="sm"
						variant={selected === null ? "secondary" : "ghost"}
					>
						New workflow
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
					{loading ? (
						<div className="flex items-center gap-2 px-2 py-3 text-muted-foreground text-xs">
							<Spinner className="size-3" />
							Loading…
						</div>
					) : workflows.length === 0 ? (
						<p className="px-2 py-3 text-muted-foreground text-xs">
							No workflows yet. Describe one to Ryu on the right to build your
							first.
						</p>
					) : (
						<ul className="flex flex-col gap-0.5">
							{workflows.map((w) => (
								<li key={w.id}>
									<Button
										className="w-full justify-start truncate"
										onClick={() => setSelected(w)}
										size="sm"
										variant={selected?.id === w.id ? "secondary" : "ghost"}
									>
										<span className="truncate">{w.name || "Untitled"}</span>
									</Button>
								</li>
							))}
						</ul>
					)}
				</div>
			</aside>

			{/* Main: builder guidance + a live snapshot of the workflow being built,
			    plus a jump into the visual canvas (the companion app). */}
			<div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
				<div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0">
							<h1 className="truncate font-semibold text-lg">
								{selected?.name?.trim() || "Build a workflow"}
							</h1>
							<p className="text-muted-foreground text-sm">
								Describe what you want to automate in the Ask Ryu panel and Ryu
								builds the graph. Open it in the canvas to fine-tune, run, or add
								triggers.
							</p>
						</div>
						<Button
							disabled={!selected}
							onClick={() =>
								selected &&
								openTab(`/workflows/${selected.id}`, { title: selected.name })
							}
							variant="outline"
						>
							Open in canvas
						</Button>
					</div>

					<div className="rounded-lg border bg-card p-4 text-card-foreground">
						<p className="mb-2 font-medium text-sm">Current workflow</p>
						<pre className="overflow-x-auto whitespace-pre-wrap text-muted-foreground text-xs leading-relaxed">
							{builderSnapshot}
						</pre>
					</div>
				</div>
			</div>
		</div>
	);
}
