import { type ApiTarget, apiUrl } from "@/src/lib/api/client.ts";

export interface AgentPostureResource {
	endpoint: string;
	listeners: Set<() => void>;
	pending: Promise<void> | null;
	settledScope: object | null;
}
// An in-flight write belongs to the physical record, independent of editor or
// query-client lifetime. Rendering and publication still belong to recordScope.
export const agentPostureResources = new Map<string, AgentPostureResource>();
export function postureResourceFor(
	target: ApiTarget,
	id: string | null
): AgentPostureResource | null {
	if (!(id && target.url.replace(/\/+$/, ""))) {
		return null;
	}
	const endpoint = apiUrl(target, `/api/agents/${encodeURIComponent(id)}`);
	let resource = agentPostureResources.get(endpoint);
	if (!resource) {
		resource = {
			endpoint,
			pending: null,
			settledScope: null,
			listeners: new Set(),
		};
		agentPostureResources.set(endpoint, resource);
	}
	return resource;
}

export function releasePostureResource(resource: AgentPostureResource) {
	if (
		!resource.pending &&
		resource.listeners.size === 0 &&
		agentPostureResources.get(resource.endpoint) === resource
	) {
		agentPostureResources.delete(resource.endpoint);
	}
}
