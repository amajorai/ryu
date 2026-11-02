// The text of a provider sign-in event, in the reader's language.
//
// Core's native ChatGPT-plan and Kiro flows send each sentence twice, like a
// cloud-task routing notice: the English text (`instructions` on an `auth_url`
// event, `message` on `info` and `error`) and `i18n`, the same sentence as a
// Core message `{ message: <English ICU source>, args }`
// (apps/core/src/pi_config/oauth_login/login_text.rs). Bridge flows send no
// `i18n`, so their provider text is shown as sent.

import type { PiLoginEvent } from "@/src/lib/api/pi-config.ts";
import {
	cloudTaskNoticeText,
	type NoticeTranslate,
} from "@/src/lib/cloud-task-notice-text.ts";

export function providerLoginEventText(
	event: PiLoginEvent,
	text: string | undefined,
	tl: NoticeTranslate
): string | null {
	if (text === undefined) {
		return null;
	}
	const i18n = "i18n" in event ? event.i18n : undefined;
	return cloudTaskNoticeText({ i18n, message: text }, tl);
}
