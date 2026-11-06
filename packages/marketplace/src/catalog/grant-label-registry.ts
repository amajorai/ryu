// packages/marketplace/src/catalog/grant-label-registry.ts
//
// The one registry of permission-grant copy, shared by the Store permissions
// list, the install confirmation, the dependencies panel and the desktop App
// permissions editor. A grant resolves to an exact entry (host grants, then
// app-domain grants), then to an open-ended family (`tool:command:<bin>`,
// `mcp:<server>`, …), and only then to the "Permission: {id}" fallback.
//
// The copy is returned in the reader's language: exact entries are catalog
// literals translated here with the runtime `translate`, families are whole ICU
// messages. Consent is the moment a user reads these, so no grant may reach the
// UI as a made-up English label ("Tool execute") again; the registry test checks
// every grant a shipped manifest declares.

import { translate as tl } from "@ryu/i18n/lite";
import { type GrantCopy, grantFamilyCopy } from "./grant-label-families.ts";
import { APP_GRANT_COPY } from "./grant-label-registry-apps.ts";
import { HOST_GRANT_COPY } from "./grant-label-registry-host.ts";

/** Unicode left-to-right isolate around a raw grant id, so `tool:foo` keeps its
 *  reading order inside a right-to-left sentence. */
const LTR_ISOLATE_START = "\u2066";
const LTR_ISOLATE_END = "\u2069";

/** The authored (English) copy for a grant with an exact registry entry. */
export function exactGrantCopy(grant: string): GrantCopy | null {
	const key = grant.toLowerCase();
	return HOST_GRANT_COPY.get(key) ?? APP_GRANT_COPY.get(key) ?? null;
}

/** Translate a catalog literal; a string carrying ICU syntax is never fed back
 *  through the formatter. */
function translateLiteral(text: string): string {
	return /[{}]/.test(text) ? text : tl(text);
}

/** Translated label and description for a known grant (exact entry or family),
 *  or `null` when the registry does not know it. */
export function resolveGrantCopy(grant: string): GrantCopy | null {
	const exact = exactGrantCopy(grant);
	if (exact) {
		return {
			label: translateLiteral(exact.label),
			description: translateLiteral(exact.description),
		};
	}
	return grantFamilyCopy(grant);
}

/** The label shown for a grant the registry does not know: the raw id, isolated
 *  left-to-right, inside a translated sentence. Never a guessed English name. */
export function unknownGrantLabel(grant: string): string {
	return tl("Permission: {id}", {
		id: `${LTR_ISOLATE_START}${grant}${LTR_ISOLATE_END}`,
	});
}
