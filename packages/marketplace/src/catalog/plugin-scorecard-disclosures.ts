// Plugin scorecard: disclosure and listing-error check families.

import { translate as tl } from "@ryu/i18n/lite";
import { z } from "zod";

import type { ScorecardCheck } from "./scorecard-contract.ts";
import { check } from "./scorecard-contract.ts";
import type { CatalogEntry, PluginCatalogDetail } from "./types.ts";

/** Reserved first-party id namespaces. A community listing whose manifest claims
 *  one of these is impersonating Ryu, which is a hard failure, not a warning. */
const RESERVED_ID_PREFIXES = [
	"@ryu/",
	"@amajor/",
	"com.ryu.",
	"ai.ryu.",
	"com.amajor.",
];

/** True when the permission summary declares an unscoped capability — the shape
 * the breadth check treats as "asks for everything of this kind". */
const permissionArraySchema = z.custom<unknown[]>(Array.isArray);
const permissionObjectSchema = z.record(z.string(), z.unknown());
// Keep the original key bag: decoding a record discards an own __proto__ key.
const permissionObjectBoundarySchema = z.custom<
	z.infer<typeof permissionObjectSchema>
>((value) => permissionObjectSchema.safeParse(value).success);
const broadPermissionSchema = z.unknown().transform((value) => {
	if (value === true) {
		return true;
	}
	const record = permissionObjectBoundarySchema.safeParse(value);
	if (record.success) {
		return Object.values(record.data).some((permission) => {
			const list = permissionArraySchema.safeParse(permission);
			return (
				permission === true ||
				permission === "*" ||
				(list.success && list.data.includes("*"))
			);
		});
	}
	const list = permissionArraySchema.safeParse(value);
	return list.success && list.data.includes("*");
});
const isBroad = broadPermissionSchema.parse;

type PermissionSummary = NonNullable<PluginCatalogDetail["permissions"]>;

function permissionBreadthCheck(
	permissions: PermissionSummary
): ScorecardCheck {
	const broad = [
		isBroad(permissions.network) ? tl("network") : null,
		isBroad(permissions.fs) ? tl("filesystem") : null,
		isBroad(permissions.childProcess) ? tl("subprocesses") : null,
	].filter((value) => value !== null);
	return broad.length === 0
		? check(
				"permission-breadth",
				"disclosures",
				tl("Narrow permissions"),
				3,
				"pass",
				tl("Every runtime permission it requests is scoped.")
			)
		: check(
				"permission-breadth",
				"disclosures",
				tl("Narrow permissions"),
				3,
				"warn",
				tl("Requests unrestricted {access} access.", {
					access: broad.join(", "),
				})
			);
}

export function disclosureChecks(
	entry: CatalogEntry | null,
	detail: PluginCatalogDetail | null
): ScorecardCheck[] {
	const checks: ScorecardCheck[] = [];
	const permissions = detail?.permissions ?? null;
	const grants = detail?.permissionGrants ?? entry?.requires?.grants ?? [];
	const reachesNetwork =
		isBroad(permissions?.network) ||
		grants.some((g) => /net|web|http|fetch/i.test(g));

	checks.push(
		detail?.privacyPolicyUrl
			? check(
					"privacy-policy",
					"disclosures",
					tl("Privacy policy"),
					2,
					"pass",
					tl("Publishes a privacy policy.")
				)
			: check(
					"privacy-policy",
					"disclosures",
					tl("Privacy policy"),
					2,
					reachesNetwork ? "fail" : "warn",
					reachesNetwork
						? tl(
								"No privacy policy, and this plugin can reach the network with your data."
							)
						: tl("No privacy policy is published.")
				)
	);

	checks.push(
		detail?.termsOfServiceUrl
			? check(
					"terms",
					"disclosures",
					tl("Terms of service"),
					1,
					"pass",
					tl("Publishes terms of service.")
				)
			: check(
					"terms",
					"disclosures",
					tl("Terms of service"),
					1,
					"warn",
					tl("No terms of service are published.")
				)
	);

	if (permissions?.declared === true) {
		checks.push(permissionBreadthCheck(permissions));
	} else if (detail) {
		checks.push(
			check(
				"permission-breadth",
				"disclosures",
				tl("Narrow permissions"),
				3,
				"pass",
				tl("Declares no runtime permissions, so it runs fully sandboxed.")
			)
		);
	}

	const publicRoutes = (detail?.apiSurface?.sidecars ?? []).flatMap((s) =>
		(s.routes ?? []).filter((r) => r.auth === "none" || r.auth === "public")
	);
	if (detail?.apiSurface?.sidecars?.length) {
		checks.push(
			publicRoutes.length === 0
				? check(
						"network-surface",
						"disclosures",
						tl("Authenticated endpoints"),
						2,
						"pass",
						tl(
							"Every HTTP route its background service exposes requires authentication."
						)
					)
				: check(
						"network-surface",
						"disclosures",
						tl("Authenticated endpoints"),
						2,
						"warn",
						tl(
							"{count, plural, one {# HTTP route is} other {# HTTP routes are}} exposed without authentication.",
							{ count: publicRoutes.length }
						)
					)
		);
	}

	const homepage =
		detail?.website ?? detail?.repositoryUrl ?? entry?.repo_url ?? null;
	checks.push(
		homepage
			? check(
					"homepage",
					"disclosures",
					tl("Source is inspectable"),
					1,
					"pass",
					tl("Links to a homepage or repository you can read.")
				)
			: check(
					"homepage",
					"disclosures",
					tl("Source is inspectable"),
					1,
					"warn",
					tl("Links to no homepage or repository.")
				)
	);

	return checks;
}

function identityCheck(claimedId: string): ScorecardCheck {
	const squatting = RESERVED_ID_PREFIXES.some((p) =>
		claimedId.toLowerCase().startsWith(p)
	);
	return squatting
		? check(
				"identity",
				"errors",
				tl("Identity is its own"),
				3,
				"fail",
				tl(
					'Its manifest claims the reserved id "{id}", impersonating a first-party plugin.',
					{ id: claimedId }
				)
			)
		: check(
				"identity",
				"errors",
				tl("Identity is its own"),
				3,
				"pass",
				tl('Publishes under its own id "{id}".', { id: claimedId })
			);
}

function manifestIntegrityCheck(
	surface: NonNullable<PluginCatalogDetail["apiSurface"]>
): ScorecardCheck | null {
	const contributions = [
		...(surface.commands ?? []),
		...(surface.tools ?? []),
		...(surface.agents ?? []),
		...(surface.workflows ?? []),
		...(surface.policies ?? []),
	];
	if (contributions.length === 0) {
		return null;
	}
	const dangling = contributions.filter((c) => !c.name);
	return dangling.length === 0
		? check(
				"manifest-integrity",
				"errors",
				tl("Contributions resolve"),
				2,
				"pass",
				tl("Every declared contribution points at something this plugin ships.")
			)
		: check(
				"manifest-integrity",
				"errors",
				tl("Contributions resolve"),
				2,
				"warn",
				tl(
					"{count, plural, one {# declared contribution references} other {# declared contributions reference}} something the plugin does not ship.",
					{ count: dangling.length }
				)
			);
}

export function errorChecks(
	entry: CatalogEntry | null,
	detail: PluginCatalogDetail | null
): ScorecardCheck[] {
	const checks: ScorecardCheck[] = [];

	if (detail?.enrichmentError) {
		checks.push(
			check(
				"enrichment",
				"errors",
				tl("Listing reads cleanly"),
				3,
				"fail",
				detail.enrichmentError
			)
		);
	} else if (detail) {
		checks.push(
			check(
				"enrichment",
				"errors",
				tl("Listing reads cleanly"),
				3,
				"pass",
				tl("The listing and its manifest were read without errors.")
			)
		);
	}

	// An id-squatting community listing: its manifest claims a reserved
	// first-party namespace. Hard fail — this is impersonation, not sloppiness.
	const claimedId = detail?.manifestId ?? null;
	const origin = detail?.origin ?? entry?.origin ?? null;
	if (claimedId && origin === "community") {
		checks.push(identityCheck(claimedId));
	}

	const surface = detail?.apiSurface ?? null;
	const integrity = surface ? manifestIntegrityCheck(surface) : null;
	if (integrity) {
		checks.push(integrity);
	}

	return checks;
}
