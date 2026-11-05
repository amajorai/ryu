import type { TwoFactorActions } from "@ryu/settings/hooks/useTwoFactorDialog";
import { isStepUpRequired } from "@ryu/step-up";

/**
 * A two-factor call the server refused until the session proves its existing
 * second factor (`STEP_UP_REQUIRED`). While two-factor is on, turning it off or
 * re-minting its backup codes needs that proof; the password alone is not
 * enough.
 */
export class TwoFactorStepUpRequiredError extends Error {}

/**
 * Throws for a failed Better Auth result: a `TwoFactorStepUpRequiredError` when
 * the gate asked for a step-up, otherwise a plain error with the server's
 * message.
 */
export function throwTwoFactorResultError(error: {
	code?: string;
	message?: string;
}): never {
	if (isStepUpRequired({ error })) {
		throw new TwoFactorStepUpRequiredError(error.message);
	}
	throw new Error(error.message);
}

type StepUpPrompt = (scope: "account.security") => Promise<boolean>;

/**
 * `actions` whose disable and backup-code calls, when the server asks for a
 * step-up, open `prompt` and retry once after the user proves a factor. A
 * dismissed prompt rejects with the server's refusal, which the dialog toasts.
 */
export function withTwoFactorStepUp(
	actions: TwoFactorActions,
	prompt: StepUpPrompt
): TwoFactorActions {
	const retryAfterStepUp = async <T>(run: () => Promise<T>): Promise<T> => {
		try {
			return await run();
		} catch (error) {
			if (!(error instanceof TwoFactorStepUpRequiredError)) {
				throw error;
			}
			if (!(await prompt("account.security"))) {
				throw error;
			}
			return await run();
		}
	};
	return {
		...actions,
		disable: (password) => retryAfterStepUp(() => actions.disable(password)),
		regenerateBackupCodes: (password) =>
			retryAfterStepUp(() => actions.regenerateBackupCodes(password)),
	};
}
