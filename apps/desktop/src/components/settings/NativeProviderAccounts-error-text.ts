// The text of a native-account failure, in the reader's language.
//
// Core answers a failed native-account route with `{ error, code, i18n }` and
// a failed login's progress with `error`, `errorCode` and `errorI18n`
// (apps/core/src/pi_config/native_accounts/errors.rs): the English sentence and
// the same sentence as a Core message `{ message: <English ICU source>, args }`.
// An older Core sends only the English text, which is shown as sent.

import type { NativeLoginOperation } from "@ryuhq/core-client/native-accounts.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import {
	cloudTaskNoticeText,
	type NoticeTranslate,
} from "@/src/lib/cloud-task-notice-text.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a refusal says the agent has no native account custody. */
export function nativeAccountsUnsupported(cause: unknown): boolean {
	if (!(cause instanceof ApiError)) {
		return false;
	}
	if ([404, 405].includes(cause.status)) {
		return true;
	}
	return (
		cause.status === 400 &&
		(cause.code === "native_account_unsupported" ||
			cause.serverMessage === "Not a native ACP agent" ||
			cause.serverMessage ===
				"This agent does not support native account custody")
	);
}

/** A failed request's text: Core's coded sentence, else its text, else `fallback`. */
export function nativeAccountErrorText(
	cause: unknown,
	tl: NoticeTranslate,
	fallback: string
): string {
	if (cause instanceof ApiError) {
		const message = cause.serverMessage ?? cause.message;
		const i18n = isRecord(cause.body) ? cause.body.i18n : undefined;
		return cloudTaskNoticeText({ i18n, message }, tl);
	}
	return cause instanceof Error ? cause.message : fallback;
}

/** A failed login operation's text, or `null` while it has none. */
export function nativeOperationErrorText(
	operation: NativeLoginOperation,
	tl: NoticeTranslate
): string | null {
	if (!operation.error) {
		return null;
	}
	const i18n = "errorI18n" in operation ? operation.errorI18n : undefined;
	return cloudTaskNoticeText({ i18n, message: operation.error }, tl);
}
