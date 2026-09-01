/**
 * Anonymous account access is temporarily disabled while the hosted browser
 * waitlist is active. Keep this as one explicit switch so re-enabling guest
 * access also requires an intentional review of its waitlist policy.
 */
export const GUEST_MODE_ENABLED = false;

export const GUEST_MODE_DISABLED_MESSAGE =
	"Guest mode is temporarily unavailable while the waitlist is active.";

/** True for the Better Auth anonymous sign-in endpoint while it is disabled. */
export function shouldRejectGuestSignIn(path: string): boolean {
	return !GUEST_MODE_ENABLED && path === "/sign-in/anonymous";
}
