import { z } from "zod";
import { normalizeConsentBlob } from "../../shared/consent.ts";
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

const triStateSchema = z.boolean().nullable().catch(null);
/** Coerce arbitrary persisted JSON into a strict tri-state value. */
export function coerceTriState(
	value: Parameters<typeof triStateSchema.parse>[0]
): boolean | null {
	return triStateSchema.parse(value);
}

/** Use the same persisted consent contract as desktop synchronization. */
export function normalizeConsent(
	partial: Parameters<typeof normalizeConsentBlob>[0]
): ConsentState {
	return normalizeConsentBlob(partial);
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

/** Connection events need proactive consent, but never screen/context consent. */
export function proactiveAllowed(consent: ConsentState): boolean {
	return consent.proactive === true;
}

/** True while the first-run consent card still needs an answer. */
export function consentPromptNeeded(consent: ConsentState): boolean {
	return consent.contextRead === null || consent.proactive === null;
}
