import { RYU_SUPPORTED_SCOPES } from "@ryu/auth/scopes";

export const DEFAULT_SCOPES = ["openid", "profile", "email", "offline_access"];
export const OAUTH_SCOPE_CATALOG = [...new Set(RYU_SUPPORTED_SCOPES)];

export type PendingAction = {
	clientId: string;
	kind: "delete" | "rotate";
} | null;

export function errorMessage(
	error: Error | null | undefined,
	fallback: string
): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

export function scopeLabel(scope: string): string {
	const [resource, action] = scope.split(":");
	if (!(resource && action)) {
		return scope;
	}
	return `${resource[0]?.toUpperCase() ?? ""}${resource.slice(1)} \u00b7 ${action}`;
}
