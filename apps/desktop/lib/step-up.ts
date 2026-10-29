import { createStepUpClient } from "@ryu/step-up";
import { BACKEND_URL, getActiveToken } from "@/lib/auth-client.ts";

/**
 * The desktop app's step-up client.
 *
 * Token-authenticated, not cookie-authenticated: the desktop holds its session
 * as a bearer token in the local vault (see `auth-client.ts`), and the token is
 * read at call time rather than captured once, so switching accounts mid-session
 * points the prompt at the account actually acting.
 *
 * The protocol itself is shared with the website and the mobile app — see
 * `@ryu/step-up`.
 */
export const stepUpClient = createStepUpClient({
	baseUrl: BACKEND_URL,
	headers: (): Record<string, string> => {
		const token = getActiveToken();
		return token ? { Authorization: `Bearer ${token}` } : {};
	},
});

export {
	isStepUpRequired,
	STEP_UP_REQUIRED,
	type StepUpMethod,
	type StepUpScope,
	type StepUpStatus,
	stepUpPromptLine,
} from "@ryu/step-up";
