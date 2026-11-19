import type { LiteralMessage } from "@ryu/i18n/react";
import { crmLabel } from "./crm-label.tsx";
import { LOCALIZABLE_SEED_LABELS } from "./crm-seed-labels.ts";

/**
 * The CRM backend rejects a field write with an English
 * `"<field slug>: <reason>"` message (`ApiError::Validation` in
 * `apps-store/crm/backend/src/error.rs`, reasons from `store/validation.rs`),
 * plus `" (and N more field errors)"` when several fields failed. This turns a
 * known reason into a whole translated sentence naming the field; anything
 * else keeps the message as the backend sent it.
 */
const VALIDATION_MESSAGE =
	/^([a-z0-9_]+): (.+?)(?: \(and (\d+) more field errors\))?$/u;

type ReasonSentence = (field: string, tl: LiteralMessage) => string;

const REASON_SENTENCES: Readonly<Record<string, ReasonSentence>> = {
	"a URL must not contain spaces": (field, tl) =>
		tl("{field} must be a URL without spaces.", { field }),
	"a phone number must contain at least one digit": (field, tl) =>
		tl("{field} must be a phone number with at least one digit.", { field }),
	"expected a number": (field, tl) =>
		tl("{field} must be a number.", { field }),
	"expected a percentage": (field, tl) =>
		tl("{field} must be a percentage.", { field }),
	"expected a rating": (field, tl) =>
		tl("{field} must be a rating.", { field }),
	"expected an amount": (field, tl) =>
		tl("{field} must be an amount.", { field }),
	"expected true or false": (field, tl) =>
		tl("{field} must be true or false.", { field }),
	"not a valid URL": (field, tl) =>
		tl("{field} is not a valid URL.", { field }),
	"not a valid date": (field, tl) =>
		tl("{field} is not a valid date.", { field }),
	"not a valid date and time": (field, tl) =>
		tl("{field} is not a valid date and time.", { field }),
	"not a valid email address": (field, tl) =>
		tl("{field} is not a valid email address.", { field }),
};

/** A field's display name in the active locale (seed names translate). */
function fieldDisplayName(name: string, tl: LiteralMessage): string {
	return LOCALIZABLE_SEED_LABELS.has(name) ? tl(name) : crmLabel(name, tl);
}

/** The text to show for a failed CRM field write. */
export function crmValidationText(
	cause: unknown,
	fields: readonly { name: string; slug: string }[],
	tl: LiteralMessage
): string {
	const message = cause instanceof Error ? cause.message : String(cause);
	const match = VALIDATION_MESSAGE.exec(message);
	if (!match) {
		return message;
	}
	const [, slug, reason, more] = match;
	const key = reason ?? "";
	const sentence = Object.hasOwn(REASON_SENTENCES, key)
		? REASON_SENTENCES[key]
		: undefined;
	const field = fields.find((candidate) => candidate.slug === slug);
	if (!(sentence && field)) {
		return message;
	}
	const text = sentence(fieldDisplayName(field.name, tl), tl);
	if (!more) {
		return text;
	}
	return tl(
		"{error} {count, plural, one {# more field also needs fixing.} other {# more fields also need fixing.}}",
		{ count: Number(more), error: text }
	);
}
