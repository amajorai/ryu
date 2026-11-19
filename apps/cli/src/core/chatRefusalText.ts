// A refused chat turn in the CLI's language. chatStream reports a non-2xx
// stream as `HTTP {status} · {reason}` (English, built in core/chatStream.ts);
// this splits that prefix off so the reason goes through trMessage (an exact
// catalog entry or a catalogued template filled with its values) and the
// sentence is rebuilt with the catalogued wrapper. A bare `HTTP {status}` and
// any other text are returned unchanged.

import { CLI_TRANSLATOR, type CliTranslator } from "../i18n/translate.ts";

const HTTP_REFUSAL = /^HTTP (\d{3}) · ([\s\S]+)$/u;

/** Build {@link chatRefusalText} bound to one translator (tests pin a catalog). */
export function createChatRefusalText(
	translator: Pick<CliTranslator, "tf" | "trMessage">
): (message: string) => string {
	const { tf, trMessage } = translator;
	return (message) => {
		const match = HTTP_REFUSAL.exec(message);
		const status = match?.[1];
		const reason = match?.[2];
		if (!(status && reason)) {
			return message;
		}
		return tf("HTTP {status} · {reason}", {
			status,
			reason: trMessage(reason),
		});
	};
}

/** A chat stream refusal (`HTTP 402 · …`) with its reason localized. */
export const chatRefusalText = createChatRefusalText(CLI_TRANSLATOR);
