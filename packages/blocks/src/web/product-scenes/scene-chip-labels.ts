/**
 * Marks a scene chip's English word for the catalog. The scenes render on the
 * server, in English, and the web DOM localizer swaps each chip's exact text
 * for its catalog value; the i18n extractor catalogs each `tl("…")` source,
 * which it cannot read from a bare lowercase `label` prop.
 */
const tl = (source: string): string => source;

/**
 * Chip words shared by the product scenes. "tools" is the plain plural noun
 * (its value is under sense review in `tools/check-i18n-short-keys-colon.mjs`,
 * so the "{n} tools" counter fragment cannot return); "memory", "plan" and
 * "backup" are lowercase chip words the catalog had no entry for.
 */
export const SCENE_CHIP_LABELS = {
	backup: tl("backup"),
	memory: tl("memory"),
	plan: tl("plan"),
	tools: tl("tools"),
} as const;
