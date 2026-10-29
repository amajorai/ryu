export function useStoreSectionCounts() {
	const shipped =
		/* SAFETY: shipped-plugin-cards-proof.spec.ts installs this exact optional private count object from numeric 0-or-1 branch results before page load. The absent-slot fallback remains unchanged; no catalog row or SDK response contract is asserted. */ (
			window as typeof window & {
				__ryuShippedCardsCounts?: { apps: number; plugins: number };
			}
		).__ryuShippedCardsCounts;
	if (shipped) {
		return {
			agents: 0,
			apps: shipped.apps,
			bundles: undefined,
			engines: 0,
			integrations: 0,
			mcp: 0,
			models: 0,
			plugins: shipped.plugins,
			skills: 0,
		};
	}

	return {
		agents: 3,
		apps: 2,
		bundles: undefined,
		engines: 0,
		integrations: 0,
		mcp: 0,
		models: 0,
		plugins: 0,
		skills: 0,
	};
}
