/** Shared client for the installed language-pack catalog.
 *
 * The endpoint returns data-only packs from Core. Validation happens again in
 * each UI runtime, but doing it here keeps Native and other non-desktop hosts
 * from ever putting an unchecked remote object into React context.
 */

import { type LanguagePack, validateLanguagePack } from "@ryu/i18n/core";
import { z } from "zod";

const installedPackState = z.object({ enabled: z.boolean().catch(true) });

import {
	type AppResponseValue,
	appResponseValueSchema,
} from "./app-request-json.ts";
import type { ApiTarget } from "./client.ts";
import { request } from "./client.ts";

const MAX_IMPORT_ARCHIVE_BYTES = 8 * 1024 * 1024;

// Whole native JSON is admitted by transport. Only the business field read is
// observed here; validateLanguagePack remains the complete pack authority.
const languageResponseCellsSchema = z.custom<Record<string, AppResponseValue>>(
	(value) =>
		z.instanceof(Object).safeParse(value).success &&
		Object.values(new Object(value)).every(
			(cell) => appResponseValueSchema.safeParse(cell).success
		)
);
function languageResponseField(
	value: AppResponseValue,
	field: "packs" | "pack"
): AppResponseValue {
	if (value === null || value === undefined) {
		throw new TypeError(
			`Language-pack response has no readable ${field} property`
		);
	}
	return languageResponseCellsSchema.parse(new Object(value))[field];
}

export async function fetchInstalledLanguagePacks(
	target: ApiTarget
): Promise<LanguagePack[]> {
	const response = await request(
		target,
		"/api/language-packs/installed",
		{},
		appResponseValueSchema
	);
	const responsePacks = languageResponseField(response, "packs");
	if (!Array.isArray(responsePacks)) {
		return [];
	}
	const packs: LanguagePack[] = [];
	for (const raw of responsePacks) {
		try {
			const pack = validateLanguagePack(raw);
			const enabled = installedPackState.parse(raw).enabled;
			packs.push({ ...pack, enabled });
		} catch {
			// One malformed installed record must not hide the rest of the catalog.
		}
	}
	return packs;
}

function archiveBase64(bytes: Uint8Array): string {
	if (bytes.byteLength > MAX_IMPORT_ARCHIVE_BYTES) {
		throw new Error("language-pack archive exceeds the 8 MiB import limit");
	}
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x80_00) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x80_00));
	}
	return btoa(binary);
}

/** Import and activate a local, validated-by-Core language-pack archive. */
export async function importLanguagePack(
	target: ApiTarget,
	archive: Uint8Array
): Promise<LanguagePack> {
	const result = await request(
		target,
		"/api/language-packs/import",
		{
			body: { archive_base64: archiveBase64(archive) },
			method: "POST",
		},
		appResponseValueSchema
	);
	return validateLanguagePack(languageResponseField(result, "pack"));
}
