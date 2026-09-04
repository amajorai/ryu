/** Shared client for the installed language-pack catalog.
 *
 * The endpoint returns data-only packs from Core. Validation happens again in
 * each UI runtime, but doing it here keeps Native and other non-desktop hosts
 * from ever putting an unchecked remote object into React context.
 */

import { type LanguagePack, validateLanguagePack } from "@ryu/i18n/core";
import type { ApiTarget } from "./client.ts";
import { request } from "./client.ts";

const MAX_IMPORT_ARCHIVE_BYTES = 8 * 1024 * 1024;

interface InstalledLanguagePacksResponse {
	packs?: unknown;
}

export async function fetchInstalledLanguagePacks(
	target: ApiTarget
): Promise<LanguagePack[]> {
	const response = await request<InstalledLanguagePacksResponse>(
		target,
		"/api/language-packs/installed"
	);
	if (!Array.isArray(response.packs)) {
		return [];
	}
	const packs: LanguagePack[] = [];
	for (const raw of response.packs) {
		try {
			const pack = validateLanguagePack(raw);
			const enabled =
				typeof raw === "object" &&
				raw !== null &&
				"enabled" in raw &&
				typeof raw.enabled === "boolean"
					? raw.enabled
					: true;
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
	const result = await request<{ pack?: unknown }>(
		target,
		"/api/language-packs/import",
		{
			body: { archive_base64: archiveBase64(archive) },
			method: "POST",
		}
	);
	return validateLanguagePack(result.pack);
}
