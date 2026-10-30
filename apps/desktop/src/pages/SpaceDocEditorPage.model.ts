export const SAVE_DEBOUNCE_MS = 800;

/** Cap on page-context text shipped to the assistant's first message. */
export const ASSISTANT_CONTEXT_CAP = 4000;

/** Distinct, readable caret colors assigned to collaborators by a stable hash of
 * their identity, so the same person keeps the same color across sessions. */
export const CURSOR_COLORS = [
	"#ef4444",
	"#f59e0b",
	"#10b981",
	"#3b82f6",
	"#8b5cf6",
	"#ec4899",
	"#14b8a6",
	"#f97316",
] as const;

/** Pick a deterministic caret color for an identity seed (email / name). */
export const HASH_MODULUS = 2_147_483_647;

export function cursorColorFor(seed: string): string {
	let hash = 0;
	for (let i = 0; i < seed.length; i += 1) {
		hash = (hash * 31 + seed.charCodeAt(i)) % HASH_MODULUS;
	}
	return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

export type SaveState = "idle" | "saving" | "saved" | "error";

export const SAVE_LABEL = {
	idle: "",
	saving: "Saving…",
	saved: "Saved",
	error: "Saved on this device",
} satisfies Record<SaveState, string>;
