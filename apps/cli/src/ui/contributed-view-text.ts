// The toast for a failed plugin-contributed view action, in the CLI's language:
// the catalogued wrapper names the action, and the caught reason goes through
// failureText so catalogued copy and the unreachable sentence translate while
// server text passes through unchanged.

import { createFailureText } from "../i18n/failure-text.ts";
import { CLI_TRANSLATOR, type CliTranslator } from "../i18n/translate.ts";

/** Build {@link actionFailedText} bound to one translator (tests pin a catalog). */
export function createActionFailedText(
	translator: Pick<CliTranslator, "tf" | "trMessage">
): (actionId: string, error: unknown) => string {
	const reason = createFailureText(translator);
	const { tf } = translator;
	return (actionId, error) =>
		tf("Action {id} failed: {error}", { id: actionId, error: reason(error) });
}

/** The error toast after a contributed view action fails. */
export const actionFailedText = createActionFailedText(CLI_TRANSLATOR);
