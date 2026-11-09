import type { HostServices } from "./rpc.ts";

/**
 * Companions reviewed to author and run owner-identity workflows host-direct.
 *
 * A saved workflow runs its Tool, Mcp, GhostAction, Script and Agent nodes as
 * the owner with no per-call approval, so writing, versioning, triggering or
 * running one is equivalent to the reserved `tool:call` /
 * `hook:run-agent:write` grants. The Gateway keeps `workflows:crud` /
 * `workflows:runstate` owner-exclusive to these ids
 * (`apps/gateway/src/governance/mod.rs`); this mirrors that list so a grant set
 * that slipped through (an operator allowlist override, a stale seed, or an
 * approval persisted before the grant became owner-exclusive) still cannot
 * reach the owner-token `/workflows` authoring and run APIs. Desktop and
 * mobile both apply it, so neither client is the softer door.
 */
const REVIEWED_WORKFLOW_AUTHORS: ReadonlySet<string> = new Set([
	"@ryu/workflows",
	"com.ryu.workflows",
	"@ryu/feedback-board",
	"com.ryu.feedback-board",
]);

/**
 * The host verbs that write a definition, snapshot or trigger binding, or
 * start/continue a run. Binding a Connect trigger makes an existing owner
 * workflow run on an external event, so it is authoring too.
 */
export const WORKFLOW_AUTHORING_VERBS = [
	"workflowsSave",
	"workflowsDelete",
	"workflowsVersionCreate",
	"workflowsVersionRestore",
	"workflowsTemplateInstall",
	"workflowsBindConnectTrigger",
	"workflowsRemoveConnectBinding",
	"workflowsRun",
	"workflowsResume",
] as const satisfies readonly (keyof HostServices)[];

export function isReviewedWorkflowAuthor(pluginId: string): boolean {
	return REVIEWED_WORKFLOW_AUTHORS.has(pluginId.trim().toLowerCase());
}

function refuseWorkflowAuthoring(): Promise<never> {
	return Promise.reject(
		new Error(
			"Only the reviewed Workflows apps can save or run workflows from an app."
		)
	);
}

/**
 * Returns `services` unchanged for a reviewed workflow author; for any other
 * companion, every authoring/run verb is replaced with a refusal that never
 * reaches Core. Read-only verbs (list, get, run status, catalogs) are kept.
 */
export function gateWorkflowAuthoring(
	pluginId: string,
	services: Partial<HostServices>
): Partial<HostServices> {
	if (isReviewedWorkflowAuthor(pluginId)) {
		return services;
	}
	const gated: Partial<HostServices> = { ...services };
	for (const verb of WORKFLOW_AUTHORING_VERBS) {
		if (gated[verb]) {
			gated[verb] = refuseWorkflowAuthoring;
		}
	}
	return gated;
}
