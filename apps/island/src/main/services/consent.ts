// Main-process consent store and the privacy HARD GATE.
//
// Consent is per-capability: `chat` (talk to Core), `contextRead` (screen/window
// capture via Shadow :3030), and `proactive` (the suggestion engine). `chat`
// defaults ON because the island is a chat surface; `contextRead` and `proactive`
// are UNSET (`null`) until the user answers the first-run consent card, so `null`
// reads as "ask".
//
// Two gates enforce the privacy contract:
//   - `isContextReadAllowed()` MUST be true before any request reaches Shadow.
//     The Shadow IPC layer consults this and returns a quiet "declined" result
//     otherwise, so when `contextRead` is false there are ZERO calls to :3030.
//   - `shouldRunEngine()` MUST be true before the proactive suggestion engine
//     starts a cycle. It requires both `contextRead` and `proactive` granted
//     (the engine reads context, then suggests).
//
// State persists as JSON under Electron's `userData` directory and survives
// restarts. Changes notify subscribers (the renderer + tray) so the consent card
// and indicators stay in sync regardless of which surface flipped the toggle.
//
// DESKTOP SYNC (privacy-gate note): consent is also mirrored to/from Core's
// `island-consent` preference so the desktop app can edit these toggles (the
// island's own Settings tab was removed). `main/index.ts` wires the two-way sync;
// `applyConsentState` below is the inbound path it uses for a desktop-originated
// change. CONSEQUENCE: if Core already holds an explicit grant (e.g. the desktop
// set `contextRead: true`), the island ADOPTS it on launch and opens the Shadow
// gate WITHOUT showing its first-run consent card. This is intentional — it is the
// same user on a device-bound sensor — but it means the local store is no longer
// the sole authority across restarts; Core's mirrored value can pre-answer the gate.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { ConsentPatch, ConsentState } from "../../shared/ipc.ts";
import {
	chatAllowed,
	consentPromptNeeded,
	contextReadAllowed,
	engineAllowed,
	normalizeConsent,
} from "./consent-logic.ts";

const CONSENT_FILE = "island-consent.json";

let cached: ConsentState | null = null;
const listeners = new Set<(state: ConsentState) => void>();

function consentPath(): string {
	return join(app.getPath("userData"), CONSENT_FILE);
}

/** Load consent, falling back to defaults on any read or parse error. */
export function getConsent(): ConsentState {
	if (cached) {
		return cached;
	}
	let parsed: Partial<ConsentState> = {};
	try {
		const path = consentPath();
		if (existsSync(path)) {
			parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ConsentState>;
		}
	} catch {
		parsed = {};
	}
	cached = normalizeConsent(parsed);
	return cached;
}

function persist(state: ConsentState): void {
	try {
		writeFileSync(consentPath(), JSON.stringify(state, null, 2), "utf8");
	} catch {
		// Best-effort persistence; keep the in-memory value regardless.
	}
}

/** Merge and persist a consent patch, notifying subscribers. */
export function setConsent(patch: ConsentPatch): ConsentState {
	const next = normalizeConsent({ ...getConsent(), ...patch });
	cached = next;
	persist(next);
	for (const listener of listeners) {
		listener(next);
	}
	return next;
}

/**
 * Apply a full consent state that originated OUTSIDE the island (the desktop, via
 * Core's `island-consent` preference). Persists + notifies subscribers exactly
 * like {@link setConsent}, but takes the complete normalized state rather than a
 * patch. `main/index.ts` calls this from the Core-pref sync path; it does NOT
 * re-mirror to Core (the caller owns loop avoidance).
 */
export function applyConsentState(state: ConsentState): void {
	cached = state;
	persist(state);
	for (const listener of listeners) {
		listener(state);
	}
}

/** Subscribe to consent changes; returns an unsubscribe function. */
export function onConsentChanged(
	listener: (state: ConsentState) => void
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * HARD GATE for Shadow egress. When this is false, NO request may go to :3030.
 * `null` (unanswered) and `false` (declined) both block; only an explicit grant
 * opens the gate.
 */
export function isContextReadAllowed(): boolean {
	return contextReadAllowed(getConsent());
}

/** True only when chat is granted (defaults true unless explicitly declined). */
export function isChatAllowed(): boolean {
	return chatAllowed(getConsent());
}

/**
 * Gate the proactive suggestion engine. The engine reads screen context and then
 * suggests, so it needs BOTH `contextRead` and `proactive` granted. Any engine
 * module (present or future) must consult this before starting a cycle.
 */
export function shouldRunEngine(): boolean {
	return engineAllowed(getConsent());
}

/** True when the first-run consent card still needs an answer. */
export function needsConsentPrompt(): boolean {
	return consentPromptNeeded(getConsent());
}
