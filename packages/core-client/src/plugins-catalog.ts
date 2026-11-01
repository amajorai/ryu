// packages/core-client/src/plugins-catalog.ts
//
// Remote app catalog browsing and install-from-URL/catalog.
// Re-exported through `./plugins.ts`.

import { z } from "zod";
import {
	type AppResponseValue,
	appResponseValueSchema,
} from "./app-request-json.ts";
import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
	request,
} from "./client.ts";
import { parseLifecycleError } from "./plugins-errors.ts";
import type { SurfaceSupportSummary } from "./plugins-types.ts";
import {
	type pluginJsonFields,
	pluginJsonObject,
	pluginString,
} from "./plugins-wire.ts";

// ── App catalog (browse remote registry + install-from-URL) ───────────────────

/** A single installable-app entry from Core's remote registry
 *  (`GET /api/plugins/catalog`). Pure discovery metadata — lifecycle state
 *  (installed/enabled) lives on {@link AppInfo} and is joined by `id`. */
export interface CatalogEntry {
	built_in: boolean;
	description: string;
	id: string;
	kinds: string[];
	/** Non-executable capability layers this listing extends. */
	layers?: AppResponseValue[];
	/** Server-derived A Major Pass inclusion marker for catalog presentation. */
	membership_included?: boolean;
	name: string;
	permission_grants: string[];
	/** Commerce metadata for hosted Marketplace listings; absent/null means free. */
	pricing?: z.output<typeof pluginJsonFields> | null;
	source: string;
	/** Per-surface support levels and shared-shell inheritance. */
	surface_support?: SurfaceSupportSummary[];
	tags: AppResponseValue[];
	version: string;
}

// Complete typed catalog view plus the original full native JSON record.
// Remote tags/layers and pricing are explicitly copied as upstream JSON by
// Core; do not assert their individual cells are strings or commerce fields.
const pluginCatalogSurfaceFields = z.object({
	surface: pluginString,
	support: pluginString.nullish(),
	inheritedFrom: pluginString.nullish(),
});
const pluginCatalogEntryFields = z.object({
	built_in: z.boolean(),
	description: pluginString,
	id: pluginString,
	kinds: z.array(pluginString),
	layers: z.array(appResponseValueSchema).optional(),
	membership_included: z.boolean().optional(),
	name: pluginString,
	permission_grants: z.array(pluginString),
	pricing: pluginJsonObject.nullish(),
	source: pluginString,
	surface_support: z.array(pluginCatalogSurfaceFields).optional(),
	tags: z.array(appResponseValueSchema),
	version: pluginString,
});
const pluginCatalogEntryResponse = z.custom<
	z.output<typeof pluginCatalogEntryFields>
>(
	(value) =>
		pluginJsonObject.safeParse(value).success &&
		pluginCatalogEntryFields.safeParse(value).success
);
const pluginCatalogResponseFields = z.object({
	entries: z.array(pluginCatalogEntryResponse).nullish(),
});
const pluginCatalogResponse = z.custom<
	z.output<typeof pluginCatalogResponseFields>
>(
	(value) =>
		pluginJsonObject.safeParse(value).success &&
		pluginCatalogResponseFields.safeParse(value).success
);

/** `GET /api/plugins/catalog` — browse installable apps from the remote registry. */
export async function fetchAppsCatalog(
	target: ApiTarget
): Promise<CatalogEntry[]> {
	const data = await request(
		target,
		"/api/plugins/catalog",
		{},
		pluginCatalogResponse
	);
	return data.entries ?? [];
}

/** `POST /api/plugins/install` — install a plugin from an `https://` manifest.json URL.
 *  Core records it installed+disabled (enable is a separate, grant-gated step). */
export async function installAppFromUrl(
	target: ApiTarget,
	url: string
): Promise<void> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, "/api/plugins/install"),
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			body: JSON.stringify({ url }),
		}
	);
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, "/api/plugins/install");
		throw Object.assign(new Error(err.message), err);
	}
}

/** `POST /api/plugins/catalog/install { id }` — install a plugin from Core's
 * active catalog source. The endpoint applies the signed-package and node ACL
 * checks; catalog pricing is not part of the request's access decision. */
export async function installPluginFromCatalog(
	target: ApiTarget,
	id: string
): Promise<void> {
	const path = "/api/plugins/catalog/install";
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
		body: JSON.stringify({ id }),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, path);
		throw Object.assign(new Error(err.message), err);
	}
}
