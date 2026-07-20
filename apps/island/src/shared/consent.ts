// Shared island-consent preference: the cross-surface contract persisted in Core
// under the `island-consent` key. The desktop app reads/writes the SAME key from
// its Settings → Island tab, so the island companion (a separate Electron
// process) mirrors its local consent here — the privacy toggles are editable from
// the desktop without the island UI.
//
// The island remains the LOCALLY AUTHORITATIVE store for the hard gate (see
// `main/services/consent.ts`): on a local change it pushes the full state here, and
// on a desktop change it pulls from here and applies it. This module is pure (no
// Electron / filesystem deps) so it can be shared by both the main-process sync
// and the desktop client.
//
// The value is the JSON blob `{ chat, contextRead, proactive }` matching
// `ConsentState`. `chat` is a boolean (defaults true); `contextRead`/`proactive`
// are tri-state (`true` granted, `false` declined, `null` unanswered). The
// coercion below is byte-identical to `main/services/consent-logic.ts` so a
// desktop-written blob normalizes the same way the local store does.

import type { ConsentState } from "./ipc.ts";

/** Preference key shared with the desktop + Core KV store. */
export const ISLAND_CONSENT_PREF_KEY = "island-consent";

/** Default consent: chat on, screen context + proactive unanswered (`null` = ask). */
export const DEFAULT_ISLAND_CONSENT: ConsentState = {
	chat: true,
	contextRead: null,
	proactive: null,
};

/** Coerce arbitrary persisted JSON into a strict tri-state value. */
function coerceTriState(value: unknown): boolean | null {
	if (value === true || value === false) {
		return value;
	}
	return null;
}

/** Normalize a partial/untrusted consent object to the canonical shape. */
export function normalizeConsentBlob(
	partial: Partial<ConsentState>
): ConsentState {
	return {
		chat: partial.chat === false ? false : DEFAULT_ISLAND_CONSENT.chat,
		contextRead: coerceTriState(partial.contextRead),
		proactive: coerceTriState(partial.proactive),
	};
}

/**
 * Tolerantly coerce a raw preference value (JSON string from Core, or `null`)
 * into a {@link ConsentState}. A missing key or malformed blob falls back to the
 * default (chat on, the gated capabilities unanswered).
 */
export function parseConsent(raw: string | null): ConsentState {
	if (!raw) {
		return DEFAULT_ISLAND_CONSENT;
	}
	try {
		return normalizeConsentBlob(JSON.parse(raw) as Partial<ConsentState>);
	} catch {
		return DEFAULT_ISLAND_CONSENT;
	}
}

/** Serialize a {@link ConsentState} to the JSON string Core stores as the value. */
export function serializeConsent(state: ConsentState): string {
	return JSON.stringify({
		chat: state.chat,
		contextRead: state.contextRead,
		proactive: state.proactive,
	});
}
