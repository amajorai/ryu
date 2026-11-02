// Plugin-specific marketplace scorecard rules.
//
// Each check family lives in its own module (review/hygiene, maintenance,
// disclosures/errors) so a category can be reasoned about and tested alone.

import {
	type DesignSystemSurface,
	designSystemChecks,
} from "./design-system-scorecard.ts";
import {
	disclosureChecks,
	errorChecks,
} from "./plugin-scorecard-disclosures.ts";
import { maintenanceChecks } from "./plugin-scorecard-maintenance.ts";
import { hygieneChecks, reviewChecks } from "./plugin-scorecard-review.ts";
import type { Scorecard } from "./scorecard-contract.ts";
import { buildScorecard } from "./scorecard-contract.ts";
import type { CatalogEntry, PluginCatalogDetail } from "./types.ts";

function designSystemSurface(
	entry: CatalogEntry | null,
	detail: PluginCatalogDetail | null
): DesignSystemSurface {
	const api = detail?.apiSurface;
	const hasCompanion =
		entry?.type === "app" ||
		entry?.kinds.includes("companion") === true ||
		detail?.runnables?.some((runnable) => runnable.kind === "companion") ===
			true ||
		api?.runnables?.some((runnable) => runnable.kind === "companion") === true;
	if (hasCompanion) {
		return "companion";
	}
	const hasHostSurface =
		(api?.views?.length ?? 0) > 0 ||
		(api?.settingsTabs?.length ?? 0) > 0 ||
		(api?.composerControls?.length ?? 0) > 0;
	if (hasHostSurface) {
		return "host";
	}
	if (api) {
		return "none";
	}
	return "unknown";
}

/**
 * Run the full automated scan over a plugin listing.
 *
 * Both inputs are optional and the result is always well-formed: a listing with
 * no detail loaded yet still scores what the card alone can answer, so the badge
 * does not pop in and out while the detail request is in flight.
 *
 * `now` is injectable purely so the maintenance checks are deterministic in
 * tests; callers should omit it.
 */
export function runScorecard(
	entry: CatalogEntry | null,
	detail: PluginCatalogDetail | null,
	now: number = Date.now()
): Scorecard {
	const checks = [
		...reviewChecks(entry, detail),
		...disclosureChecks(entry, detail),
		...maintenanceChecks(entry, detail, now),
		...hygieneChecks(entry, detail),
		...errorChecks(entry, detail),
		...designSystemChecks({
			evidence: detail?.designSystem,
			surface: designSystemSurface(entry, detail),
		}),
	];
	return buildScorecard(checks, "marketplace-plugin-2");
}
