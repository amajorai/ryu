import { translate } from "@ryu/i18n/core";
import { StepUpRequestError } from "@ryu/step-up";
import { emailWaitSentence, type Translate } from "./email-wait-line.ts";

// The step-up email cooldown, said in the reader's language. The server's
// 429 (`POST /api/step-up/challenge`) carries its wait in seconds; the
// sentence is built here, one whole catalogued ICU message per unit, because a
// server sentence with a count in it cannot match a plural catalog key.

/**
 * The cooldown line for a refused code or link request, or `null` when the
 * refusal is not a cooldown. A cooldown that names no wait keeps the server's
 * sentence, which is catalogued as is.
 */
export function stepUpEmailWaitLine(
	error: unknown,
	tl: Translate = translate
): string | null {
	if (!(error instanceof StepUpRequestError && error.status === 429)) {
		return null;
	}
	if (error.retryAfter === undefined) {
		return error.message;
	}
	return emailWaitSentence(error.retryAfter, tl);
}
