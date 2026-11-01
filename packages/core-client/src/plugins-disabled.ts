// packages/core-client/src/plugins-disabled.ts
//
// `503 app_disabled` detection for gated feature endpoints.
// Re-exported through `./plugins.ts`.

import { pluginJsonObject, pluginString } from "./plugins-wire.ts";

// ── App-disabled (503) detection for gated feature endpoints ──────────────────

/** A parsed `503 { error:"app_disabled", app, message }` body. Feature endpoints
 *  whose owning plugin is disabled (`/api/meetings/*`, `/api/spaces/*`, …) return
 *  this so a client can offer a one-click ENABLE instead of surfacing a raw 503. */
export interface AppDisabledError {
	/** The plugin id to enable (e.g. `"meetings"`, `"spaces"`). */
	app: string;
	/** Core's human-readable prompt (e.g. "Enable the Meetings app"). */
	message: string;
}

/** Detect the `503 app_disabled` contract on a failed response and read the
 *  owning plugin id. Returns `null` for any other failure (including a 503 that is
 *  NOT `app_disabled`). Clones the response first, so the caller can still read the
 *  original body when this returns `null`. One definition for native AND tui. */
export async function parseAppDisabled(
	resp: Response
): Promise<AppDisabledError | null> {
	if (resp.status !== 503) {
		return null;
	}
	try {
		const text = await resp.clone().text();
		if (!text) {
			return null;
		}
		const parsed = pluginJsonObject.safeParse(JSON.parse(text));
		if (!parsed.success) {
			return null;
		}
		const body = parsed.data;
		if (
			body.error === "app_disabled" &&
			pluginString.safeParse(body.app).success
		) {
			return {
				app: pluginString.parse(body.app),
				message: pluginString.safeParse(body.message).success
					? pluginString.parse(body.message)
					: `Enable the ${body.app} app`,
			};
		}
	} catch {
		// Not JSON, or body already consumed — treat as "not the app_disabled case".
	}
	return null;
}
