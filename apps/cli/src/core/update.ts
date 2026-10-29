// Update-check reader - the TS port of apps/cli's api::fetch_update_check
// (apps/cli/src/api.rs). apps/cli asks Core `GET /api/update/check` on launch and
// prints a one-line "▲ Ryu X is available" notice; the TUI had no equivalent
// (the parity audit flagged update-check as MISSING). This surfaces the same
// verdict as a launch toast + a palette action. Core-client has no typed reader
// for this endpoint, so it uses the shared HTTP primitives directly. Any error
// (Core down, no network) resolves to null so a launch notice never blocks the UI.

import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "@ryuhq/core-client/client";
import { z } from "zod";

/** A trimmed update verdict, mirroring apps/cli's `UpdateNotice`. */
export interface UpdateNotice {
	available: boolean;
	current: string;
	htmlUrl: string | null;
	latest: string;
}

// GET /api/update/check wire shape (snake_case as Core serializes it).
const updateVerdictSchema = z.object({
	current: z.string().catch(""),
	html_url: z.string().nullable().catch(null),
	latest: z.string().catch(""),
	update_available: z.boolean().catch(false),
});

/** Ask Core whether a newer Ryu release is available. Resolves null on any error
 * so a startup notice never blocks the TUI (parity with apps/cli's None-on-error). */
export async function fetchUpdateCheck(
	target: ApiTarget
): Promise<UpdateNotice | null> {
	try {
		const resp = await fetchForTarget(target)(
			apiUrl(target, "/api/update/check"),
			{
				headers: makeHeaders(target.token, target.userJwt),
				signal: AbortSignal.timeout(3000),
			}
		);
		if (!resp.ok) {
			return null;
		}
		const json = updateVerdictSchema.parse(await resp.json());
		return {
			current: json.current ?? "",
			latest: json.latest ?? "",
			available: json.update_available ?? false,
			htmlUrl: json.html_url ?? null,
		};
	} catch {
		return null;
	}
}
