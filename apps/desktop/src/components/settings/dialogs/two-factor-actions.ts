import type { TwoFactorActions } from "@ryu/settings/hooks/useTwoFactorDialog";
import { z } from "zod";
import { authClient, storeSessionToken } from "@/lib/auth-client.ts";

// Better Auth replaces the session when two-factor is turned on or off and
// returns the replacement bearer in `set-auth-token`. The desktop signs every
// request with its stored bearer, so it adopts the replacement before the
// session is re-read; otherwise the revoked token signs the account out.
const adoptRotatedSession = {
	onSuccess: async (context: { response: Response }) => {
		const rotated = context.response.headers.get("set-auth-token");
		if (rotated) {
			await storeSessionToken(rotated);
		}
	},
};

// The dialog's Better Auth calls; the shared flow toasts what they throw.
export const twoFactorActions: TwoFactorActions = {
	enable: async (password) => {
		const result = await authClient.twoFactor.enable({ password });
		if (result.error) {
			throw new Error(result.error.message);
		}
		if (result.data?.method !== "totp") {
			throw new Error("Two-factor setup did not return a TOTP secret.");
		}
		// Enrollment mints the backup codes; verification only confirms the
		// authenticator, so these are the codes shown after a valid code.
		return {
			backupCodes: result.data.backupCodes ?? [],
			totpUri: result.data.totpURI,
		};
	},
	verify: async (code) => {
		const result = await authClient.twoFactor.verifyTotp({
			code,
			fetchOptions: adoptRotatedSession,
		});
		if (result.error) {
			throw new Error(result.error.message);
		}
		return z
			.object({ backupCodes: z.array(z.string()).optional() })
			.nullish()
			.parse(result.data)?.backupCodes;
	},
	disable: async (password) => {
		const result = await authClient.twoFactor.disable({
			password,
			fetchOptions: adoptRotatedSession,
		});
		if (result.error) {
			throw new Error(result.error.message);
		}
	},
	regenerateBackupCodes: async (password) => {
		const result = await authClient.twoFactor.generateBackupCodes({
			password,
		});
		if (result.error) {
			throw new Error(result.error.message);
		}
		return result.data?.backupCodes ?? [];
	},
};
