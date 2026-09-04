import {
	LANGUAGE_PACKS_CHANGED_EVENT,
	type LanguagePack,
	languagePackArchive,
	validateLanguagePack,
} from "@ryu/i18n";
import { importLanguagePack as importLanguagePackAtNode } from "@ryuhq/core-client/language-packs";
import { type ApiTarget, request } from "./client.ts";

/** Read the validated language-pack payloads installed on the active Core node. */
export async function fetchInstalledLanguagePacks(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<LanguagePack[]> {
	const result = await request<{ packs?: unknown[] }>(
		target,
		"/api/language-packs/installed",
		{ signal }
	);
	const packs: LanguagePack[] = [];
	for (const value of result.packs ?? []) {
		try {
			const raw = value as { enabled?: unknown };
			const pack = validateLanguagePack(value);
			packs.push({ ...pack, enabled: raw.enabled !== false });
		} catch {
			// Core already validates this boundary. Keep the client fail-soft if a
			// newer node sends a pack schema this build cannot understand.
		}
	}
	return packs;
}

/** Toggle the Core lifecycle record for an installed language pack. */
export async function setLanguagePackEnabled(
	target: ApiTarget,
	{ id, enabled }: { id: string; enabled: boolean }
): Promise<void> {
	await request(
		target,
		`/api/marketplace/packages/language_pack/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`,
		{ method: "POST" }
	);
	window.dispatchEvent(new Event(LANGUAGE_PACKS_CHANGED_EVENT));
}

/** Import a portable language-pack archive into the active Core node. */
export function importLanguagePack(
	target: ApiTarget,
	archive: Uint8Array
): Promise<LanguagePack> {
	return importLanguagePackAtNode(target, archive);
}

/** Download a validated pack as the standard portable `.ryupack` archive. */
export function downloadLanguagePack(pack: LanguagePack): void {
	const bytes = languagePackArchive(pack);
	const archive = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(archive).set(bytes);
	const safeName = (pack.name || pack.id)
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
	const version = pack.version.replace(/^v/iu, "");
	const filename = `${safeName || "language-pack"}-${version}.ryupack`;
	const url = URL.createObjectURL(
		new Blob([archive], { type: "application/zip" })
	);
	const link = window.document.createElement("a");
	link.download = filename;
	link.href = url;
	window.document.body.append(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
