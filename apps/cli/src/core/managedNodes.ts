import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { z } from "zod";
import { accountBackendTarget } from "./authBackend.ts";
import type { Node } from "./nodes.ts";

const nonEmptyTextSchema = z.string().trim().min(1);
const coreAuthStatusSchema = z.object({
	authenticated: z.boolean().optional().catch(false),
	token: nonEmptyTextSchema.nullable().catch(null),
});
const managedNodeSchema = z.object({
	name: nonEmptyTextSchema,
	url: nonEmptyTextSchema,
	userJwt: nonEmptyTextSchema,
	orgId: nonEmptyTextSchema.nullable().catch(null),
});
const managedNodesSchema = z.object({
	nodes: z.array(managedNodeSchema.nullable().catch(null)).catch([]),
});

/**
 * Discover the active account's managed nodes using Core's local auth vault and
 * the control-plane's audience-bound per-node delegations. `null` means the
 * control plane could not be checked; an empty list is a valid signed-out or
 * no-visible-nodes result. The delegations are returned only in memory and the
 * node writer deliberately drops them before writing `nodes.json`.
 */
export async function fetchManagedNodes(
	coreTarget: ApiTarget,
	signal?: AbortSignal
): Promise<Node[] | null> {
	try {
		const auth = coreAuthStatusSchema.parse(
			await request(
				coreTarget,
				"/api/auth/status",
				{ signal },
				appResponseValueSchema
			)
		);
		const token = auth.authenticated ? auth.token : null;
		if (!token) {
			return [];
		}

		const controlPlaneTarget = accountBackendTarget(token);
		const response = managedNodesSchema.parse(
			await request(
				controlPlaneTarget,
				"/api/control-plane/nodes",
				{ signal },
				appResponseValueSchema
			)
		);

		return response.nodes.flatMap((managed): Node[] => {
			if (!managed) {
				return [];
			}
			const { name, url, userJwt, orgId } = managed;
			return [
				{
					name: `cloud-${name}`,
					url,
					token: null,
					userJwt,
					managed: true,
					orgId,
				},
			];
		});
	} catch {
		return null;
	}
}
