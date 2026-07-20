import { useCallback, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	createWorkflow as apiCreateWorkflow,
	deleteWorkflow as apiDeleteWorkflow,
	resumeWorkflow as apiResumeWorkflow,
	runWorkflow as apiRunWorkflow,
	fetchWorkflows,
	type Workflow,
	type WorkflowRun,
} from "@/src/lib/api/workflows.ts";
import { useCoreRefresh } from "@/src/lib/core-refresh.ts";
import { PlanCapError } from "@/src/lib/gating/planCapBridge.ts";
import { useEntityCap } from "@/src/lib/gating/useEntityCap.ts";
import { useActiveNode } from "./useActiveNode.ts";

/** Fires whenever a workflow is created, saved, or deleted, so every
 *  `useWorkflows` consumer (sidebar section + the page) stays in sync without a
 *  shared store. */
const WORKFLOWS_CHANGED_EVENT = "ryu:workflows-changed";

export function notifyWorkflowsChanged() {
	window.dispatchEvent(new CustomEvent(WORKFLOWS_CHANGED_EVENT));
}

export interface UseWorkflowsResult {
	create: (definition: unknown) => Promise<Workflow>;
	error: string | null;
	loading: boolean;
	reload: () => Promise<void>;
	remove: (id: string) => Promise<void>;
	resume: (runId: string, payload: string) => Promise<WorkflowRun>;
	run: (id: string, input: Record<string, string>) => Promise<WorkflowRun>;
	workflows: Workflow[];
}

/// Loads workflow definitions from the active Core node and exposes create /
/// delete / run operations. Create and run reject with the Core validation /
/// execution error message so the page can surface it verbatim (invalid DAGs).
export function useWorkflows(): UseWorkflowsResult {
	const activeNode = useActiveNode();
	const url = activeNode.url;
	const token = activeNode.token ?? null;

	const { guard, limitFor } = useEntityCap();

	const [workflows, setWorkflows] = useState<Workflow[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		const target: ApiTarget = { url, token };
		try {
			const list = await fetchWorkflows(target);
			setWorkflows(list);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load workflows");
		} finally {
			setLoading(false);
		}
	}, [url, token]);

	useEffect(() => {
		reload().catch(() => undefined);
	}, [reload]);

	// Auto-recover when Core reconnects or the user hits "Refresh all".
	useCoreRefresh(reload);

	// Reload when any other consumer mutates the workflow set (create/save/delete).
	useEffect(() => {
		const onChanged = () => {
			reload().catch(() => undefined);
		};
		window.addEventListener(WORKFLOWS_CHANGED_EVENT, onChanged);
		return () => window.removeEventListener(WORKFLOWS_CHANGED_EVENT, onChanged);
	}, [reload]);

	const create = useCallback(
		async (definition: unknown) => {
			// `create` is an UPSERT (it also persists edits to an existing workflow),
			// so only the genuinely-new case counts against the cap — saving an
			// existing workflow while at the limit must still work. A new workflow
			// carries an empty/absent id or one not yet in the list. Off the managed
			// path this is a no-op (self-host uncapped).
			const defId = (definition as { id?: unknown })?.id;
			const isNew =
				typeof defId !== "string" ||
				defId === "" ||
				!workflows.some((w) => w.id === defId);
			if (isNew && !guard("maxWorkflows", workflows.length)) {
				throw new PlanCapError("maxWorkflows", limitFor("maxWorkflows"));
			}
			const workflow = await apiCreateWorkflow({ url, token }, definition);
			setWorkflows((prev) => {
				const next = prev.filter((w) => w.id !== workflow.id);
				return [workflow, ...next];
			});
			notifyWorkflowsChanged();
			return workflow;
		},
		[url, token, guard, limitFor, workflows]
	);

	const remove = useCallback(
		async (id: string) => {
			await apiDeleteWorkflow({ url, token }, id);
			setWorkflows((prev) => prev.filter((w) => w.id !== id));
			notifyWorkflowsChanged();
		},
		[url, token]
	);

	const run = useCallback(
		async (id: string, input: Record<string, string>) =>
			await apiRunWorkflow({ url, token }, id, input),
		[url, token]
	);

	const resume = useCallback(
		async (runId: string, payload: string) =>
			await apiResumeWorkflow({ url, token }, runId, payload),
		[url, token]
	);

	return { workflows, loading, error, reload, create, remove, run, resume };
}
