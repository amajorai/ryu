/** ZDR is available on every plan. Composio activation is a global rollout. */
export function canUseZeroDataRetention(_input: {
	plan: string | null | undefined;
	enterpriseStatus?: string | null;
	enterpriseExpiresAt?: Date | null;
}): boolean {
	return true;
}
