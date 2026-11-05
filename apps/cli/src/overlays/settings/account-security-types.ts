export interface UnloadedSecuritySession {
	user?: undefined;
}
export interface UnloadedEmailChange {
	hasActive?: undefined;
}

export type Operation = "password" | "email" | "enable" | "disable" | "backup";
export type Stage = "idle" | "factor" | "value" | "totp" | "backup";
export const SCOPE = "account.security";
/**
 * Operations that need an account.security step-up first. Once 2FA is on the
 * server refuses disable and backup-code regeneration without one, and that
 * scope then accepts only a second factor (totp, emailed code or backup code).
 */
export const STEP_UP_OPERATIONS: ReadonlySet<Operation> = new Set([
	"password",
	"email",
	"disable",
	"backup",
]);
