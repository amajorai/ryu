import {
	type PasswordIssue,
	passwordValidationIssue,
} from "@ryuhq/protocol/password-policy";
import { tr } from "../../i18n/translate.ts";

/**
 * The CLI's words for the first password rule a new password breaks. The
 * shared policy hands out stable codes; the sentences live here so the CLI
 * catalog subset carries them.
 */
export function passwordIssueText(issue: PasswordIssue): string {
	switch (issue) {
		case "length":
			return tr("Password needs at least 8 characters");
		case "max_length":
			return tr("Password must be 128 characters or fewer");
		case "uppercase":
			return tr("Password needs one uppercase letter");
		case "number":
			return tr("Password needs one number");
		case "symbol":
			return tr("Password needs one symbol");
		default:
			return tr("Choose a stronger password");
	}
}

/** The first rule `value` breaks, in the reader's language, or `null`. */
export function passwordProblem(value: string): string | null {
	const issue = passwordValidationIssue(value);
	return issue ? passwordIssueText(issue) : null;
}
