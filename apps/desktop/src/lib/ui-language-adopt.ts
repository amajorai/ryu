import { LANGUAGE_PACK_STORAGE_KEY } from "@ryu/i18n/core";
import type { LanguageMode } from "@/src/hooks/useLanguageMode.ts";
import type { ApiTarget } from "./api/client.ts";
import { getPreference } from "./api/preferences.ts";
import {
	choiceOf,
	lastSyncedUiLanguage,
	serializeUiLanguagePreference,
	settledUiLanguageSync,
	UI_LANGUAGE_PREF_KEY,
	type UiLanguagePreference,
	uiLanguagePreference,
	uiLanguageSyncInFlight,
} from "./ui-language-preference.ts";

// The Island picker writes a fixed choice to Core's shared `ui-language`
// preference (`apps/island/src/main/services/language-packs.ts`). Desktop
// adopts that choice so Desktop, the Island and Core-rendered copy show one
// language: the last writer wins. Only a fixed choice is adopted (the Island
// never writes `auto`), and never a value Desktop itself last wrote, so the two
// writers cannot ping-pong.

const MAX_PACK_ID_LENGTH = 128;
const MAX_READ_ATTEMPTS = 3;

/** A fixed choice Desktop should adopt; `packId: null` is English. */
export interface AdoptedUiLanguage {
	/** Desktop's synced value when the choice was read, to drop stale results. */
	basis: string | undefined;
	packId: string | null;
}

/** The fixed pack id a stored value carries, or `undefined` when it is not one. */
function fixedPackId(raw: string | null): string | null | undefined {
	if (!raw) {
		return;
	}
	try {
		const parsed = JSON.parse(raw) as { mode?: unknown; packId?: unknown };
		if (parsed.mode !== "fixed") {
			return;
		}
		if (parsed.packId === null || parsed.packId === undefined) {
			return null;
		}
		return typeof parsed.packId === "string" &&
			parsed.packId.length > 0 &&
			parsed.packId.length <= MAX_PACK_ID_LENGTH
			? parsed.packId
			: undefined;
	} catch {
		return;
	}
}

/**
 * The pack id to adopt from the stored value, or `undefined` to keep Desktop's
 * choice: the stored value is not a fixed choice, Desktop wrote it last, or
 * Desktop already shows it.
 */
export function adoptableUiLanguage(
	raw: string | null,
	current: UiLanguagePreference,
	lastSynced: string | undefined
): string | null | undefined {
	const packId = fixedPackId(raw);
	if (packId === undefined) {
		return;
	}
	const choice = choiceOf(
		serializeUiLanguagePreference(uiLanguagePreference("fixed", packId))
	);
	if (lastSynced !== undefined && choiceOf(lastSynced) === choice) {
		return;
	}
	if (current.mode === "fixed" && current.packId === packId) {
		return;
	}
	return packId;
}

/**
 * Read the shared key after Desktop's own writes settle and return a choice
 * made elsewhere to adopt. A Desktop change during the read invalidates the
 * result, since that newer change is the last writer. Failures adopt nothing.
 */
export async function readAdoptableUiLanguage(
	target: ApiTarget,
	current: () => UiLanguagePreference
): Promise<AdoptedUiLanguage | null> {
	// A sync that starts during the read (Desktop's first sync at launch runs
	// in the same commit) makes the read stale, so it is retried after it.
	for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
		await settledUiLanguageSync(target);
		const basis = lastSyncedUiLanguage(target);
		let raw: string | null;
		try {
			raw = await getPreference(target, UI_LANGUAGE_PREF_KEY);
		} catch {
			return null;
		}
		if (
			!uiLanguageSyncInFlight(target) &&
			lastSyncedUiLanguage(target) === basis
		) {
			const packId = adoptableUiLanguage(raw, current(), basis);
			return packId === undefined ? null : { basis, packId };
		}
	}
	return null;
}

/** Whether an adoption read earlier still reflects Desktop's latest write. */
export function adoptionStillCurrent(
	target: ApiTarget,
	adopted: AdoptedUiLanguage
): boolean {
	return (
		!uiLanguageSyncInFlight(target) &&
		lastSyncedUiLanguage(target) === adopted.basis
	);
}

/**
 * Whether Desktop's fixed pack is still loading: the saved pack is not in the
 * catalog yet, so the runtime briefly shows English. Syncing that transient
 * value would read as a new Desktop choice and overwrite the shared key.
 */
export function fixedPackLoading(
	mode: LanguageMode,
	selectedPackId: string | null,
	availablePacks: readonly { id: string }[]
): boolean {
	if (mode !== "fixed" || selectedPackId !== null) {
		return false;
	}
	let saved: string | null;
	try {
		saved = localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY);
	} catch {
		return false;
	}
	return saved !== null && !availablePacks.some((pack) => pack.id === saved);
}
