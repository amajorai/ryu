// Generic Core list-endpoint reader, the TS port of apps/cli's `fetch_feature_list`
// (apps/cli/src/api.rs ~617). Many tabs are "fetch a JSON array, show title /
// subtitle / badge / id per row" with nothing schema-specific. This keeps that
// shape in one place: give it an endpoint + the candidate keys for each field and
// it returns ListRow[]. Tabs with richer needs should instead use the typed
// @ryuhq/core-client subpath modules and map to ListRow themselves.

import { type ApiTarget, apiUrl, makeHeaders } from "@ryuhq/core-client/client";

/** One row in a list tab. Mirrors apps/cli's `ListRow`. */
export interface ListRow {
	/** Short status/count chip shown on the right (rendered as a termcn Badge). */
	badge?: string;
	id: string;
	subtitle?: string;
	title: string;
}

/** Endpoint + field-key mapping for a generic list tab (mirrors the per-tab
 * inline config in apps/cli's `refresh_feature_tab`). */
export interface FeatureListConfig {
	badgeKeys?: string[];
	/** Keys tried in order to find the array inside the response object. A bare
	 * top-level array is the fallback. */
	containerKeys?: string[];
	idKeys: string[];
	/** Core path, e.g. "/api/teams" or "/api/models/catalog?limit=30". */
	path: string;
	subtitleKeys?: string[];
	/** Keys tried in order for each row's title. */
	titleKeys: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

// Port of apps/cli's `pick_field`: first non-empty string/number/bool value, or
// the length of an array value, coerced to a display string.
const pickField = (row: Record<string, unknown>, keys: string[]): string => {
	for (const key of keys) {
		const value = row[key];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
		if (typeof value === "number" || typeof value === "boolean") {
			return String(value);
		}
		if (Array.isArray(value)) {
			return String(value.length);
		}
	}
	return "";
};

const findArray = (json: unknown, containerKeys: string[]): unknown[] => {
	if (isRecord(json)) {
		for (const key of containerKeys) {
			const candidate = json[key];
			if (Array.isArray(candidate)) {
				return candidate;
			}
		}
	}
	if (Array.isArray(json)) {
		return json;
	}
	return [];
};

/** Fetch a Core list endpoint and map it to ListRow[]. Throws on a non-2xx
 * response so the caller can surface the error (parity with the Rust client). */
export async function fetchFeatureList(
	target: ApiTarget,
	config: FeatureListConfig,
	signal?: AbortSignal
): Promise<ListRow[]> {
	const resp = await fetch(apiUrl(target, config.path), {
		headers: makeHeaders(target.token),
		signal,
	});
	if (!resp.ok) {
		throw new Error(`${config.path} failed: ${resp.status}`);
	}
	const json = (await resp.json()) as unknown;
	const arr = findArray(json, config.containerKeys ?? []);

	return arr.map((element): ListRow => {
		if (typeof element === "string") {
			return { id: element, title: element };
		}
		if (!isRecord(element)) {
			return { id: "", title: "—" };
		}
		const title = pickField(element, config.titleKeys) || "—";
		return {
			title,
			id: pickField(element, config.idKeys),
			subtitle: config.subtitleKeys
				? pickField(element, config.subtitleKeys) || undefined
				: undefined,
			badge: config.badgeKeys
				? pickField(element, config.badgeKeys) || undefined
				: undefined,
		};
	});
}

/** Build an async loader for {@link ListTab} from a {@link FeatureListConfig}. */
export const featureListLoader =
	(config: FeatureListConfig) =>
	(target: ApiTarget, signal?: AbortSignal): Promise<ListRow[]> =>
		fetchFeatureList(target, config, signal);
