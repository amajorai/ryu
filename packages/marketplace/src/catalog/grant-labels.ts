// Plain-language names + one-line descriptions for the permission grants an app
// (plugin) requests, so a user understands what they are approving or revoking
// instead of reading raw identifiers like `hook:run-agent`. Shared by the enable
// consent dialog (store), the dependencies panel AND the desktop per-app
// permissions / revocation view, so the vocabulary is the same everywhere. The
// copy lives in one registry (`grant-label-registry.ts`) and comes back in the
// reader's language.

import { resolveGrantCopy, unknownGrantLabel } from "./grant-label-registry.ts";

/** Translated label for a grant identifier. An unknown grant (including one
 *  named like an inherited object property) reads "Permission: <id>" with the
 *  raw id, never a humanized guess such as "Tool execute". An empty or
 *  separators-only id is returned as is. */
export function grantLabel(grant: string): string {
	const known = resolveGrantCopy(grant);
	if (known) {
		return known.label;
	}
	if (!/[\p{L}\p{N}]/u.test(grant)) {
		return grant;
	}
	return unknownGrantLabel(grant);
}

/** Translated one-line description of what a grant lets the app do, or `null`
 *  if unknown (callers can fall back to showing the raw identifier). */
export function grantDescription(grant: string): string | null {
	return resolveGrantCopy(grant)?.description ?? null;
}
