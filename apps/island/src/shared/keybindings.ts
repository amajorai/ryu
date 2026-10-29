import { z } from "zod";
// Cross-process contract for the shared `keybindings` Core preference.
// Desktop writes overrides from Settings → Keyboard shortcuts; the island reads
// them so composer cycle chords stay in sync. The blob is a JSON map of action
// id → chord (or null when cleared). Composer defaults live in @ryu/blocks.

/** Preference key shared with the desktop's preferences client + Core KV store. */
export const KEYBINDINGS_PREF_KEY = "keybindings";

/** Saved overrides (action id → chord, or null when cleared). */
export type KeybindingOverrides = Record<string, string | null>;

const keybindingOverridesSchema = z
	.record(z.string(), z.string().nullable().optional().catch(undefined))
	.transform((entries) =>
		Object.fromEntries(
			Object.entries(entries).flatMap(([key, value]) =>
				value === undefined ? [] : [[key, value]]
			)
		)
	)
	.pipe(z.record(z.string(), z.string().nullable()))
	.catch({});

/** Tolerantly parse a raw Core preference blob into overrides. */
export function parseKeybindingOverrides(
	raw: string | null
): KeybindingOverrides {
	if (!raw) {
		return {};
	}
	try {
		return keybindingOverridesSchema.parse(JSON.parse(raw));
	} catch {
		return {};
	}
}
