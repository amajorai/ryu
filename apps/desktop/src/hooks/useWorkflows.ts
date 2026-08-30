import { useCallback, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	createWorkflow as apiCreateWorkflow,
	deleteWorkflow as apiDeleteWorkflow,
	resumeWorkflow as apiResumeWorkflow,
	runWorkflow as apiRunWorkflow,
	fetchWorkflows,
	type RunWorkflowOptions,
	type Workflow,
	type WorkflowRun,
} from "@/src/lib/api/workflows.ts";
import { useCoreRefresh } from "@/src/lib/core-refresh.ts";
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
	run: (
		id: string,
		input: Record<string, string>,
		options?: RunWorkflowOptions
	) => Promise<WorkflowRun>;
	workflows: Workflow[];
}

/// Loads workflow definitions from the active Core node and exposes create /
/// delete / run operations. Create and run reject with the Core validation /
/// execution error message so the page can surface it verbatim (invalid DAGs).
export function useWorkflows(): UseWorkflowsResult {
	const activeNode = useActiveNode();
	const url = activeNode.url;
	const token = activeNode.token ?? null;
	const userJwt = activeNode.userJwt ?? null;

	const [workflows, setWorkflows] = useState<Workflow[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		const target: ApiTarget = { url, token, userJwt };
		try {
			const list = await fetchWorkflows(target);
			setWorkflows(list);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load workflows");
		} finally {
			setLoading(false);
		}
	}, [url, token, userJwt]);

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
			const workflow = await apiCreateWorkflow(
				{ url, token, userJwt },
				definition
			);
			setWorkflows((prev) => {
				const next = prev.filter((w) => w.id !== workflow.id);
				return [workflow, ...next];
			});
			notifyWorkflowsChanged();
			return workflow;
		},
		[url, token, userJwt]
	);

	const remove = useCallback(
		async (id: string) => {
			await apiDeleteWorkflow({ url, token, userJwt }, id);
			setWorkflows((prev) => prev.filter((w) => w.id !== id));
			notifyWorkflowsChanged();
		},
		[url, token, userJwt]
	);

	const run = useCallback(
		async (
			id: string,
			input: Record<string, string>,
			options?: RunWorkflowOptions
		) => await apiRunWorkflow({ url, token, userJwt }, id, input, options),
		[url, token, userJwt]
	);

	const resume = useCallback(
		async (runId: string, payload: string) =>
			await apiResumeWorkflow({ url, token, userJwt }, runId, payload),
		[url, token, userJwt]
	);

	return { workflows, loading, error, reload, create, remove, run, resume };
}
