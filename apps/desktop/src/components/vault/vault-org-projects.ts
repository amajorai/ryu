// The organization projects this node maps a folder to (`/api/org-project-
// mappings`), offered when exporting so the export can include one project's
// shared values (roadmap P1-15). The control plane decides whether the
// signed-in member can reach the project; this list is only a picker.

import { z } from "zod";
import { type ApiTarget, request } from "@/src/lib/api/client.ts";

const mappingsResponseSchema = z
	.object({
		mappings: z.array(
			z
				.object({ organizationId: z.string(), projectId: z.string() })
				.passthrough()
		),
	})
	.passthrough();

export type OrgProjectMappings = z.infer<typeof mappingsResponseSchema>;

/** The distinct mapped project ids, sorted, leaving blank ids out. */
export function orgProjectOptions(response: OrgProjectMappings): string[] {
	const ids = new Set<string>();
	for (const mapping of response.mappings) {
		const id = mapping.projectId.trim();
		if (id !== "") {
			ids.add(id);
		}
	}
	return [...ids].sort((left, right) => left.localeCompare(right));
}

/** Mapped organization projects; none when the node does not answer. */
export async function listMappedOrgProjects(
	target: ApiTarget
): Promise<string[]> {
	try {
		const response = await request(
			target,
			"/api/org-project-mappings",
			undefined,
			mappingsResponseSchema
		);
		return orgProjectOptions(response);
	} catch {
		return [];
	}
}
