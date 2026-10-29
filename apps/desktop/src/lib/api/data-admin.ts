import { z } from "zod";
// apps/desktop/src/lib/api/data-admin.ts
//
// Typed client for Core's "danger zone" bulk-delete endpoints (`/api/data/*`).
// All the actual delete logic lives in Core (`apps/core/src/server/data_admin.rs`);
// this is a thin visual layer. Consumed by the Settings → Danger Zone tab.

import { type ApiTarget, request } from "./client.ts";

// NOTE: the per-category counts/clear client used to live here as a hardcoded
// `DataCategory` union plus a fixed-shape `DataCounts` interface naming Monitors
// and Meetings. Both are gone: those categories are declared by the owning app's
// manifest now, so the desktop discovers them from the contributions payload
// rather than compiling the app names in. The reader lives with its only
// consumer in `components/settings/DangerZoneSettings.tsx`. Re-adding a fixed
// union here would restore exactly the hardcoding that change removed.

/**
 * Wipe this ENTIRE node back to a fresh, just-installed state — every store DB,
 * session, download, and preference (only the encryption key is preserved so the
 * node can still boot). The wipe can't run live, so Core only arms it and reports
 * `restart_required`; the caller must restart Core for the wipe to happen on the
 * next boot. `confirm` is the node name the user typed to arm the action.
 *
 * Rejected by Core (400) if `confirm` is empty, or (403) on a shared org-bound node.
 */
export async function resetNode(
	target: ApiTarget,
	confirm: string
): Promise<{ ok: boolean; restartRequired: boolean }> {
	const json = await request<{ ok?: boolean; restart_required?: boolean }>(
		target,
		"/api/node/reset",
		{ method: "POST", body: { confirm } },
		resetNodeResponseSchema
	);
	return {
		ok: json?.ok ?? false,
		restartRequired: json?.restart_required ?? false,
	};
}

const resetNodeResponseSchema: z.ZodType<{
	ok?: boolean;
	restart_required?: boolean;
}> = retainValidatedResponse(
	z
		.object({
			ok: z.boolean().optional(),
			restart_required: z.boolean().optional(),
		})
		.passthrough()
);

function retainValidatedResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>((value) => fields.safeParse(value).success);
}
