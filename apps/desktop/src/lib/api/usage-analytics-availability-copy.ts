// The sentences `usage-analytics.ts` returns as `availability.message` when a
// scope cannot be charted. They are listed here so the i18n extractor catalogs
// them: the dashboard renders the message through `tl()`, which finds the
// translation by this English text. Keep each entry identical to its source.
export const USAGE_ANALYTICS_AVAILABILITY_MESSAGES = {
	nodeMissing: "Select a node to view node analytics.",
	nodeOffline: "This node is offline or its audit history is unavailable.",
	organizationMissing: "Select an organization to view organization analytics.",
	personalFiltered:
		"Personal rollups do not retain provider and model dimensions yet. Clear the filter or switch to Organization or This node for a filtered breakdown.",
	personalFineGrained:
		"Personal fine-grained history is not reported by the profile rollup yet. Choose daily, weekly, or monthly, or inspect This node for interval traffic.",
} as const;
