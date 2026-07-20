// Pure consent predicates, free of any Electron/filesystem dependency so they can
// be unit-tested in isolation. `consent.ts` wraps these around the persisted
// store; the privacy HARD GATE and the engine gate both derive from here.

import type { ConsentState } from "../../shared/ipc.ts";

/** Chat is granted by default; only an explicit `false` revokes it. */
export const DEFAULT_CONSENT: ConsentState = {
	chat: true,
	contextRead: null,
	proactive: null,
};

/** Coerce arbitrary persisted JSON into a strict tri-state value. */
export function coerceTriState(value: unknown): boolean | null {
	if (value === true || value === false) {
		return value;
	}
	return null;
}

/** Normalize a partial/untrusted consent object to the canonical shape. */
export function normalizeConsent(partial: Partial<ConsentState>): ConsentState {
	return {
		chat: partial.chat === false ? false : DEFAULT_CONSENT.chat,
		contextRead: coerceTriState(partial.contextRead),
		proactive: coerceTriState(partial.proactive),
	};
}

/**
 * The Shadow HARD GATE. Only an explicit grant opens it; `null` (unanswered) and
 * `false` (declined) both keep every request away from :3030.
 */
export function contextReadAllowed(consent: ConsentState): boolean {
	return consent.contextRead === true;
}

/** True only when chat is granted. */
export function chatAllowed(consent: ConsentState): boolean {
	return consent.chat === true;
}

/**
 * The proactive-engine gate. The engine reads context and then suggests, so it
 * needs BOTH `contextRead` and `proactive` granted.
 */
export function engineAllowed(consent: ConsentState): boolean {
	return consent.contextRead === true && consent.proactive === true;
}

/** True while the first-run consent card still needs an answer. */
export function consentPromptNeeded(consent: ConsentState): boolean {
	return consent.contextRead === null || consent.proactive === null;
}
