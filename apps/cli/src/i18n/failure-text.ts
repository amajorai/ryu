// The reason a chat or workflow failure toast splices into its translated
// prefix (tf("fork failed: {0}", …)). A refused or unreachable connection to
// Core reads as the localized "Core isn't reachable" sentence; any other
// caught value goes through errorText, so a catalogued thrown template
// ("Fork conversation failed: {status}") is translated with its values filled
// and uncatalogued text (server messages, ids) passes through unchanged.

import { unreachableMessage } from "../core/native-errors.ts";
import { createErrorText } from "./error-text.ts";
import { type CliTranslator, tf, trMessage } from "./translate.ts";

/** Build a {@link failureText} bound to one translator (tests pin a catalog). */
export function createFailureText(
	translator: Pick<CliTranslator, "tf" | "trMessage">
): (error: unknown) => string {
	const text = createErrorText(translator.trMessage);
	return (error) =>
		unreachableMessage(error, undefined, translator.tf) ?? text(error);
}

/** A caught failure's reason in the CLI's language, ready for a toast. */
export const failureText = createFailureText({ tf, trMessage });
