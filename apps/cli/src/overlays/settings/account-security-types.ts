export interface UnloadedSecuritySession {
	user?: undefined;
}
export interface UnloadedEmailChange {
	hasActive?: undefined;
}

export type Operation = "password" | "email" | "enable" | "disable" | "backup";
export type Stage = "idle" | "factor" | "value" | "totp" | "backup";
export const SCOPE = "account.security";
