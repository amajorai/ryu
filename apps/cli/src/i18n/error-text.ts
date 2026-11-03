// The reason a CLI screen splices into a translated wrapper such as
// tf("Could not save: {error}", …). tf() fills placeholders verbatim, so a
// reason thrown as a catalogued English literal ("Identity verification was
// not confirmed.") would stay English after a translated prefix. This runs the
// reason through the same exact-literal lookup as JSX copy; text the catalog
// does not hold (server messages, ids, paths) passes through unchanged.

import { type CliTranslator, tr } from "./translate.ts";

/** The message of a caught value: an Error's message, otherwise its string form. */
export function caughtMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Build an {@link errorText} bound to one translator (tests pin a locale). */
export function createErrorText(
	translate: CliTranslator["tr"]
): (error: unknown) => string {
	return (error) => translate(caughtMessage(error));
}

/** A caught value's message in the CLI's language when it is catalogued copy. */
export const errorText = createErrorText(tr);
