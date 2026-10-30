import type { WorkflowRunRecord } from "@ryu/app-host/rpc";
// Renders the `data-ryu-workflow` part a workflow-as-chat-turn produces — a
// live per-node checklist of the DAG as it executes (planner → implementer →
// verifier …). Core emits repeated frames sharing `"id":"workflow-run"` so the
// AI SDK reconciles them into one part carrying the LATEST snapshot; the card
// therefore updates in place rather than stacking. See
// `apps/core/src/sidecar/adapters/mod.rs` (`route_workflow_chat_stream`).

import { useLiteralMessages } from "@ryu/i18n/react";
import { TodoList } from "@ryu/ui/components/agents/todo-list";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { type SubmitEvent, useEffect, useState } from "react";
import type { RenderedMessage } from "./utils/native-sdk-observation.ts";
import {
	extractWorkflowRun,
	type WorkflowRunProgress,
} from "./workflow-run-data.ts";

export type {
	WorkflowNodeProgress,
	WorkflowRunProgress,
} from "./workflow-run-data.ts";
export {
	extractWorkflowRun,
	isWorkflowRunProgress,
} from "./workflow-run-data.ts";

export type WorkflowResumeHandler = (
	runId: string,
	payload: string
) => Promise<WorkflowRunRecord> | Promise<void>;

/** The latest `data-ryu-workflow` snapshot on a message, or null. A repeated
 *  frame of the same type can arrive as a single object (in-place reconcile) or
 *  an array of frames (older merge behaviour); both are handled by taking the
 *  newest. */
/** Map a workflow node status onto the TodoList vocabulary. "running" and
 *  "failed" have no TodoList twin, so they borrow "in-progress" / "cancelled"
 *  (the red X surface) — the animated ring of in-progress reads as "doing this
 *  step now", which is exactly what a running node means. */
const NODE_STATUS_TO_TODO = {
	pending: "pending",
	running: "in-progress",
	completed: "completed",
	failed: "cancelled",
	skipped: "cancelled",
} as const;

/** A workflow run rendered as a collapsible checklist: workflow name as the
 *  title, one row per node with a status ring/check. `collapseOnComplete` is
 *  off so the finished "planner → implementer → verifier" chain stays visible
 *  under the streamed answer instead of folding away the moment it finishes. */
export function WorkflowRunProgressCard({
	msg,
	onResume,
}: {
	msg: Pick<RenderedMessage, "parts">;
	onResume?: WorkflowResumeHandler;
}) {
	const tl = useLiteralMessages();
	const run = extractWorkflowRun(msg);
	if (!run) {
		return null;
	}
	const items = run.nodes.map((node) => ({
		id: node.id,
		title:
			node.kind && node.kind !== node.id
				? `${node.kind} · ${node.id}`
				: node.id,
		status: NODE_STATUS_TO_TODO[node.status] ?? "pending",
		detail: node.status === "failed" && node.error ? node.error : undefined,
	}));
	return (
		<>
			<TodoList
				collapseOnComplete={false}
				defaultOpen
				items={items}
				maxHeight={320}
				title={tl("Workflow: {workflowName}", {
					workflowName: run.workflowName,
				})}
			/>
			{run.status === "awaiting_input" && onResume ? (
				<WorkflowResumePrompt key={run.runId} onResume={onResume} run={run} />
			) : null}
		</>
	);
}

function WorkflowResumePrompt({
	onResume,
	run,
}: {
	onResume: WorkflowResumeHandler;
	run: WorkflowRunProgress;
}) {
	const tl = useLiteralMessages();
	const [payload, setPayload] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [submitted, setSubmitted] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setPayload("");
		setSubmitting(false);
		setSubmitted(false);
		setError(null);
	}, [run.runId]);

	const submit = async (event: SubmitEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (submitting || submitted) {
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			await onResume(run.runId, payload);
			setSubmitted(true);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not resume workflow."
			);
		} finally {
			setSubmitting(false);
		}
	};

	if (submitted) {
		return (
			<p
				aria-live="polite"
				className="mt-2 rounded-lg bg-muted/50 px-3 py-2 text-muted-foreground text-sm"
			>
				Response sent. The workflow will continue when the run updates.
			</p>
		);
	}

	return (
		<form
			aria-label={tl("Resume workflow {workflowName}", {
				workflowName: run.workflowName,
			})}
			className="mt-2 flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3"
			onSubmit={submit}
		>
			<p className="font-medium text-sm">This workflow is waiting for input.</p>
			<div className="flex items-center gap-2">
				<Input
					aria-label="Workflow response"
					disabled={submitting}
					onChange={(event) => setPayload(event.target.value)}
					placeholder="Enter a response…"
					value={payload}
				/>
				<Button disabled={submitting} size="sm" type="submit">
					{submitting ? "Resuming…" : "Resume"}
				</Button>
			</div>
			{error ? (
				<p aria-live="assertive" className="text-status-destructive text-xs">
					{error}
				</p>
			) : null}
		</form>
	);
}
