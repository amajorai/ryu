// Automatic version-history labels, in the reader's language.
//
// Core writes an English label on the source-history checkpoints it makes by
// itself ("Workflow saved" on every workflow save, "Before restore" ahead of a
// restore, "Document imported", …). Version panels showed that English to
// every reader. A user's own snapshot label shares the same `label` field, so
// a panel renders `versionLabelText(label, tl)`: an exact system label becomes
// its translation, and anything else stays exactly as the user typed it.
//
// When Core gains a new automatic label, add it here: the guard test in
// `tools/system-version-labels.test.mjs` fails until it is.

/** Any `tl()`-shaped translator: `useLiteralMessages()`, `translate`, … */
export type VersionLabelTranslator = (source: string) => string;

/** The English labels Core writes on automatic version checkpoints. */
export const SYSTEM_VERSION_LABELS: readonly string[] = [
	"Agent created",
	"Agent saved",
	"App narrowed identity mode",
	"App updated agent",
	"Before restore",
	"Document created",
	"Document imported",
	"Document restored",
	"Document saved",
	"Restore agent version",
	"Restore document version",
	"Restore prompt",
	"Restore skill version",
	"Skill saved",
	"Trace import",
	"Workflow saved",
];

/**
 * The translation of a system label, or null when `label` is not one. Each
 * case calls `tl` with a literal so the catalog extractor sees the message.
 */
export function systemVersionLabel(
	label: string,
	tl: VersionLabelTranslator
): string | null {
	switch (label) {
		case "Agent created":
			return tl("Agent created");
		case "Agent saved":
			return tl("Agent saved");
		case "App narrowed identity mode":
			return tl("App narrowed identity mode");
		case "App updated agent":
			return tl("App updated agent");
		case "Before restore":
			return tl("Before restore");
		case "Document created":
			return tl("Document created");
		case "Document imported":
			return tl("Document imported");
		case "Document restored":
			return tl("Document restored");
		case "Document saved":
			return tl("Document saved");
		case "Restore agent version":
			return tl("Restore agent version");
		case "Restore document version":
			return tl("Restore document version");
		case "Restore prompt":
			return tl("Restore prompt");
		case "Restore skill version":
			return tl("Restore skill version");
		case "Skill saved":
			return tl("Skill saved");
		case "Trace import":
			return tl("Trace import");
		case "Workflow saved":
			return tl("Workflow saved");
		default:
			return null;
	}
}

/**
 * The text a version badge shows: the translated system label, or the user's
 * label unchanged. Render it inside `data-ryu-i18n="off"` so the DOM
 * localizer leaves a user label that happens to match a catalog string alone.
 */
export function versionLabelText(
	label: string,
	tl: VersionLabelTranslator
): string {
	return systemVersionLabel(label, tl) ?? label;
}
