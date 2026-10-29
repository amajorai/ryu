// Generic Core list-endpoint reader, the TS port of apps/cli's `fetch_feature_list`
// (apps/cli/src/api.rs ~617). Many tabs are "fetch a JSON array, show title /
// subtitle / badge / id per row" with nothing schema-specific. This keeps that
// shape in one place: give it an endpoint + the candidate keys for each field and
// it returns ListRow[]. Tabs with richer needs should instead use the typed
// @ryuhq/core-client subpath modules and map to ListRow themselves.

import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "@ryuhq/core-client/client";
import { z } from "zod";

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

const featurePayloadSchema = z.json();
type FeaturePayload = z.infer<typeof featurePayloadSchema>;
const featureRecordSchema = z.record(z.string(), featurePayloadSchema);
type FeatureRecord = z.infer<typeof featureRecordSchema>;
const featureArraySchema = z.array(featurePayloadSchema);
const displayFieldSchema = z.union([
	z.string().min(1),
	z.union([z.number(), z.boolean()]).transform((value) => String(value)),
	featureArraySchema.transform((value) => String(value.length)),
]);

// Port of pick_field: first nonempty scalar or array length, in configured order.
const pickField = (row: FeatureRecord, keys: string[]): string => {
	for (const key of keys) {
		const parsed = displayFieldSchema.safeParse(row[key]);
		if (parsed.success) {
			return parsed.data;
		}
	}
	return "";
};

const findArray = (
	json: FeaturePayload,
	containerKeys: string[]
): FeaturePayload[] => {
	const record = featureRecordSchema.safeParse(json);
	if (record.success) {
		for (const key of containerKeys) {
			const candidate = featureArraySchema.safeParse(record.data[key]);
			if (candidate.success) {
				return candidate.data;
			}
		}
	}
	const array = featureArraySchema.safeParse(json);
	return array.success ? array.data : [];
};

/** Fetch a Core list endpoint and map it to ListRow[]. Throws on a non-2xx
 * response so the caller can surface the error (parity with the Rust client). */
export async function fetchFeatureList(
	target: ApiTarget,
	config: FeatureListConfig,
	signal?: AbortSignal
): Promise<ListRow[]> {
	const resp = await fetchForTarget(target)(apiUrl(target, config.path), {
		headers: makeHeaders(target.token, target.userJwt),
		signal,
	});
	if (!resp.ok) {
		throw new Error(`${config.path} failed: ${resp.status}`);
	}
	const json = featurePayloadSchema.parse(await resp.json());
	const arr = findArray(json, config.containerKeys ?? []);

	return arr.map((element): ListRow => {
		const text = z.string().safeParse(element);
		if (text.success) {
			return { id: text.data, title: text.data };
		}
		const record = featureRecordSchema.safeParse(element);
		if (!record.success) {
			return { id: "", title: "—" };
		}
		const title = pickField(record.data, config.titleKeys) || "—";
		return {
			title,
			id: pickField(record.data, config.idKeys),
			subtitle: config.subtitleKeys
				? pickField(record.data, config.subtitleKeys) || undefined
				: undefined,
			badge: config.badgeKeys
				? pickField(record.data, config.badgeKeys) || undefined
				: undefined,
		};
	});
}

/** Build an async loader for {@link ListTab} from a {@link FeatureListConfig}. */
export const featureListLoader =
	(config: FeatureListConfig) =>
	(target: ApiTarget, signal?: AbortSignal): Promise<ListRow[]> =>
		fetchFeatureList(target, config, signal);
