// Mandatory second-factor enrollment, as the terminal tells it. The control
// plane refuses an account with neither an authenticator app nor a passkey
// (`403 {code: "mfa_enrollment_required"}`); the website's setup page is where
// the account adds one. The TUI gate and one-shot commands share this copy.

import { mfaEnrollmentSetupUrl } from "@ryuhq/core-client/mfa-enrollment";
import { FRONTEND_URL } from "./waitlist.ts";

/** The website page where the signed-in account adds a second factor. */
export const MFA_ENROLLMENT_SETUP_URL = mfaEnrollmentSetupUrl(FRONTEND_URL);

export const MFA_ENROLLMENT_TITLE = "Set up two-factor authentication";

/** Why the account is blocked, and what does not count as a second factor. */
export const MFA_ENROLLMENT_REASON =
	"Your Ryu account needs a passkey or an authenticator app before it can continue. Email codes don't count.";

/** The one paragraph a one-shot command prints when the control plane refuses it. */
export function mfaEnrollmentCommandMessage(
	setupUrl: string = MFA_ENROLLMENT_SETUP_URL
): string {
	return `Two-factor authentication required. ${MFA_ENROLLMENT_REASON} Set one up at ${setupUrl}, then run this command again.`;
}
