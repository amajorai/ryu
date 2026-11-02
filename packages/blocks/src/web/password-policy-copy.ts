import { translate } from "@ryu/i18n/core";
import type {
	PasswordIssue,
	PasswordRuleId,
	PasswordStrength,
} from "@ryuhq/protocol/password-policy";

// The password policy in `@ryuhq/protocol` is English-only and hands out
// stable codes. These turn the codes into the reader's language with literal
// tl() calls the extractor sees. Web, Desktop and the extension share them;
// pass the hook translator from `useLiteralMessages()` inside a component.

type Translate = (source: string) => string;

/** The inline error for the first rule a password breaks. */
export function passwordIssueText(
	issue: PasswordIssue,
	tl: Translate = translate
): string {
	switch (issue) {
		case "length":
			return tl("Password needs at least 8 characters");
		case "max_length":
			return tl("Password must be 128 characters or fewer");
		case "uppercase":
			return tl("Password needs one uppercase letter");
		case "number":
			return tl("Password needs one number");
		case "symbol":
			return tl("Password needs one symbol");
		default:
			return tl("Choose a stronger password");
	}
}

/** One line of the requirements checklist. */
export function passwordRuleText(
	rule: PasswordRuleId,
	tl: Translate = translate
): string {
	switch (rule) {
		case "length":
			return tl("At least 8 characters");
		case "uppercase":
			return tl("One uppercase letter");
		case "number":
			return tl("One number");
		case "symbol":
			return tl("One symbol");
		default:
			return rule;
	}
}

/** The strength meter's word for its state. */
export function passwordStrengthText(
	strength: PasswordStrength,
	tl: Translate = translate
): string {
	switch (strength) {
		case "fair":
			return tl("Fair");
		case "good":
			return tl("Good");
		case "strong":
			return tl("Strong");
		default:
			return tl("Too weak");
	}
}
