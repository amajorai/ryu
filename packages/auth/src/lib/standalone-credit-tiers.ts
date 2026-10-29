/** Credit funding is independent of the workspace subscription catalog. */
export const STANDALONE_CREDIT_TIERS = [
	{ id: "prototype", name: "Prototype", faceCents: 500 },
	{ id: "accelerate", name: "Accelerate", faceCents: 5000 },
] as const;

export type StandaloneCreditTierId =
	(typeof STANDALONE_CREDIT_TIERS)[number]["id"];

export function standaloneCreditTier(id: unknown) {
	return STANDALONE_CREDIT_TIERS.find((tier) => tier.id === id);
}

/** Base deposit fee, charged on each funding payment. All values are cents. */
export function standaloneCreditQuote(faceCents: number) {
	const feeCents = Math.max(500, Math.ceil((faceCents * 27) / 100));
	return { faceCents, feeCents, chargeCents: faceCents + feeCents };
}

export function isStandaloneServiceDebit(reason: string): boolean {
	return [
		"gateway_usage",
		"openrouter",
		"composio",
		"sandbox",
		"treg",
		// Ryu-hosted standalone services, settled from each service's usage.
		"box",
		"notify",
		"passport",
		"connect_native",
		"connect_vendor",
		// Not `connect_composed`: a composed tool's maker fee is a transfer to
		// another organization, not a metered service.
		"mail",
		"messaging",
	].includes(reason);
}
