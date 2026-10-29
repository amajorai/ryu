import { z } from "zod";
import { fetchForTarget, type RyuFetch } from "./client.ts";

/**
 * Mandatory second-factor enrollment, as a signed-in client sees it.
 *
 * The control plane answers every request from an account that holds neither
 * an authenticator app nor a passkey with `403 {code: "mfa_enrollment_required"}`.
 * Client gates read the status endpoint below, which an unenrolled session may
 * still call, and send the user to the website's setup page instead of letting
 * each screen fail on its own 403.
 */

/** Response code the control plane answers with until a factor is enrolled. */
export const MFA_ENROLLMENT_REQUIRED_CODE = "mfa_enrollment_required";

/** Website page where an account adds a passkey or an authenticator app. */
export const MFA_ENROLLMENT_WEB_PATH = "/settings/setup-2fa";

export interface MfaEnrollmentTarget {
	fetch?: RyuFetch;
	token?: string | null;
	url: string;
}

/**
 * - `required`: the account must add a factor before it can use the control plane.
 * - `clear`: the mandate applies to this account and it has enrolled, or the
 *   control plane predates the mandate.
 * - `exempt`: the mandate does not apply to the account right now (it is
 *   waitlisted or anonymous, or the mandate is off). Unlike `clear` this can
 *   change without the user doing anything, for example when an admin approves
 *   the account, so gates keep asking and treat it like `clear` for rendering.
 * - `unknown`: the status could not be read. The control plane still enforces
 *   the mandate on every request, so gates keep the app open and ask again on
 *   their next check instead of locking the user out on a network blip.
 */
export type MfaEnrollmentAccess = "clear" | "exempt" | "required" | "unknown";

const enrollmentStatusSchema = z.object({
	// Absent on a control plane that predates the field.
	enforced: z.boolean().optional(),
	required: z.boolean(),
});

/** Read whether the signed-in account still has to enroll a second factor. */
export async function fetchMfaEnrollmentAccess(
	target: MfaEnrollmentTarget,
	signal?: AbortSignal
): Promise<MfaEnrollmentAccess> {
	const token = target.token?.trim();
	try {
		const response = await fetchForTarget(target)(
			`${target.url.replace(/\/+$/, "")}/api/auth/mfa-enrollment/status`,
			{
				credentials: "include",
				headers: token ? { Authorization: `Bearer ${token}` } : {},
				signal,
			}
		);
		// A control plane that predates the mandate has no status endpoint.
		if (response.status === 404) {
			return "clear";
		}
		if (!response.ok) {
			return "unknown";
		}
		const status = enrollmentStatusSchema.safeParse(await response.json());
		if (!status.success) {
			return "unknown";
		}
		if (status.data.required) {
			return "required";
		}
		return status.data.enforced === false ? "exempt" : "clear";
	} catch {
		return "unknown";
	}
}

/** The website's setup page for a second factor, on the given web origin. */
export function mfaEnrollmentSetupUrl(webOrigin: string): string {
	return `${webOrigin.replace(/\/+$/, "")}${MFA_ENROLLMENT_WEB_PATH}`;
}

/** Whether a control-plane error is the enrollment refusal. */
export function isMfaEnrollmentRequiredError(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		error.code === MFA_ENROLLMENT_REQUIRED_CODE
	);
}
