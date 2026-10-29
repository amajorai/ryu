import { toast } from "@ryu/ui/components/sileo.tsx";
import { z } from "zod";
import { controlPlaneRefusalMessage } from "./access-refusal.ts";

/**
 * Core's refusal for a signed-in caller whose token carries no claim for the
 * node's organization. The control plane leaves an organization out of the
 * token when its policy refuses the session, most often because it requires
 * two-factor and this session was signed in without it.
 */
export const ORG_ACCESS_NOT_IN_SESSION_CODE = "org_access_not_in_session";

/** What the desktop says instead of `… failed: 403` for that refusal. */
export const ORG_ACCESS_NOT_IN_SESSION_MESSAGE =
	"Your sign-in doesn't include access to this node's organization. If it requires two-factor, sign out from your account menu and sign in again with a passkey or your authenticator app, or confirm with your authenticator app by running `ryu-cli secrets confirm CODE --method totp` in a terminal. Then try again.";

const orgAccessRefusalSchema = z.object({
	code: z.literal(ORG_ACCESS_NOT_IN_SESSION_CODE),
	status: z.literal(403),
});

/** Whether `error` is Core's {@link ORG_ACCESS_NOT_IN_SESSION_CODE} refusal. */
export function isOrgAccessNotInSession(error: unknown): boolean {
	return orgAccessRefusalSchema.safeParse(error).success;
}

/**
 * The description line for a failed user action: the thrown error's own
 * message when it has one, otherwise nothing (the title already says what
 * failed, so a generic "Unknown error" adds no information).
 */
export function actionErrorDescription(error: unknown): string | undefined {
	if (isOrgAccessNotInSession(error)) {
		return ORG_ACCESS_NOT_IN_SESSION_MESSAGE;
	}
	const refusal = controlPlaneRefusalMessage(error);
	if (refusal) {
		return refusal;
	}
	if (error instanceof Error) {
		return error.message.trim() || undefined;
	}
	if (typeof error === "string") {
		return error.trim() || undefined;
	}
	return;
}

/**
 * Surface a failed user-initiated action (save, delete, toggle, send…) as an
 * error toast instead of swallowing it. Use for fire-and-forget handlers whose
 * failure the person would otherwise never see.
 */
export function toastActionError(title: string, error: unknown): void {
	toast.error({ title, description: actionErrorDescription(error) });
}
