import { z } from "zod";
import type { LanguagePacksResult } from "./ipc.ts";

// UI language preference persisted in Core's KV store under the `ui-language`
// key. The Island is a separate Electron process that cannot read Desktop's
// localStorage, so its main process reads this key and serves it with the
// language-pack catalog; both Island windows (the main renderer and the
// screen-surface window) build their runtime from that one answer.
//
// Writers: the Island picker, and Desktop, which mirrors its own choice here
// (`apps/desktop/src/lib/ui-language-preference.ts`). Desktop seeds an unset key
// at launch and writes on every later Desktop change, so the Island follows
// Desktop without a launch overriding a newer Island choice.
//
// - `auto`: follow the OS language (an official pack is matched by locale).
// - `fixed`: use `packId`; `null` is an explicit English choice.

/** Core preference key; written by the Island picker and Desktop (see above). */
export const UI_LANGUAGE_PREF_KEY = "ui-language";

const MAX_PACK_ID_LENGTH = 128;

const packIdSchema = z.string().min(1).max(MAX_PACK_ID_LENGTH).nullable();

const selectionSchema = z.object({
	mode: z.enum(["auto", "fixed"]),
	packId: packIdSchema.catch(null),
});

export type UiLanguageSelection = z.infer<typeof selectionSchema>;

/** The catalog read with the selection the main process resolved for it. */
export type LanguagePacksSnapshot = LanguagePacksResult & {
	selection?: UiLanguageSelection | null;
};

/** Parse the raw preference JSON; anything unreadable means "no choice saved". */
export function parseUiLanguageSelection(
	raw: string | null
): UiLanguageSelection | null {
	if (!raw) {
		return null;
	}
	try {
		const parsed = selectionSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Read the selection a main-process catalog answer carries (IPC is untrusted). */
export function selectionFromLanguagePacks(
	result: LanguagePacksResult
): UiLanguageSelection | null {
	const parsed = z
		.object({ selection: selectionSchema.nullable() })
		.safeParse(result);
	return parsed.success ? parsed.data.selection : null;
}

/** Validate a pack id sent by the renderer; `undefined` rejects the request. */
export function parseSelectedPackId(value: unknown): string | null | undefined {
	const parsed = packIdSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/** Stable identity for a selection, used as the runtime's `selectionKey`. */
export function languageSelectionKey(
	selection: UiLanguageSelection | null
): string {
	if (!selection) {
		return "local";
	}
	return selection.mode === "auto" ? "auto" : `fixed:${selection.packId ?? ""}`;
}

/** Island bridge for saving a choice (`window.islandLanguage`). */
export interface IslandLanguageApi {
	select(packId: string | null): Promise<boolean>;
}
