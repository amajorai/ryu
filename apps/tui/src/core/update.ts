// Update-check reader - the TS port of apps/cli's api::fetch_update_check
// (apps/cli/src/api.rs). apps/cli asks Core `GET /api/update/check` on launch and
// prints a one-line "▲ Ryu X is available" notice; the TUI had no equivalent
// (the parity audit flagged update-check as MISSING). This surfaces the same
// verdict as a launch toast + a palette action. Core-client has no typed reader
// for this endpoint, so it uses the shared HTTP primitives directly. Any error
// (Core down, no network) resolves to null so a launch notice never blocks the UI.

import { type ApiTarget, apiUrl, makeHeaders } from "@ryuhq/core-client/client";

/** A trimmed update verdict, mirroring apps/cli's `UpdateNotice`. */
export interface UpdateNotice {
	available: boolean;
	current: string;
	htmlUrl: string | null;
	latest: string;
}

// GET /api/update/check wire shape (snake_case as Core serializes it).
interface UpdateWire {
	current?: string;
	html_url?: string | null;
	latest?: string;
	update_available?: boolean;
}

/** Ask Core whether a newer Ryu release is available. Resolves null on any error
 * so a startup notice never blocks the TUI (parity with apps/cli's None-on-error). */
export async function fetchUpdateCheck(
	target: ApiTarget
): Promise<UpdateNotice | null> {
	try {
		const resp = await fetch(apiUrl(target, "/api/update/check"), {
			headers: makeHeaders(target.token),
			signal: AbortSignal.timeout(3000),
		});
		if (!resp.ok) {
			return null;
		}
		const json = (await resp.json()) as UpdateWire;
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
