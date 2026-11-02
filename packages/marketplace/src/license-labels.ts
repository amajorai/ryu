// Reader-language labels for the wire enums the license and seller-report
// rows show as badges. The wire values stay stable and English; these map
// each one to a literal tl() call so the extractor carries it.

import { translate } from "@ryu/i18n/core";
import type { LicenseStatus } from "./types.ts";

type Translate = (source: string) => string;

const KIND_LABELS = new Map<string, (tl: Translate) => string>([
	["agent", (tl) => tl("Agent Template")],
	["app", (tl) => tl("App")],
	["bundle", (tl) => tl("Bundle")],
	["knowledge", (tl) => tl("Knowledge")],
	["language_pack", (tl) => tl("Language Pack")],
	["mcp", (tl) => tl("MCP Server")],
	["model", (tl) => tl("Model")],
	["output_style", (tl) => tl("Output Style")],
	["plugin", (tl) => tl("Plugin")],
	["profile", (tl) => tl("Profile")],
	["skill", (tl) => tl("Skill")],
	["space", (tl) => tl("Space")],
	["stack_template", (tl) => tl("Stack Template")],
	["theme", (tl) => tl("Theme")],
	["workflow", (tl) => tl("Workflow")],
]);

/** The singular label for a catalog kind; an unknown kind shows as sent. */
export function marketplaceKindLabel(
	kind: string,
	tl: Translate = translate
): string {
	return KIND_LABELS.get(kind)?.(tl) ?? kind;
}

/** The badge for a license that is no longer active. */
export function licenseStatusLabel(
	status: LicenseStatus,
	tl: Translate = translate
): string {
	switch (status) {
		case "active":
			return tl("Active");
		case "expired":
			return tl("Expired");
		case "refunded":
			return tl("Refunded");
		case "disputed":
			return tl("Disputed");
		default:
			return status;
	}
}

/** Why a buyer reported a listing. */
export function sellerReportReasonLabel(
	reason: string,
	tl: Translate = translate
): string {
	switch (reason) {
		case "broken":
			return tl("Not working");
		case "other":
			return tl("Other");
		case "malicious":
			return tl("Malicious");
		case "spam":
			return tl("Spam");
		case "inappropriate":
			return tl("Inappropriate");
		case "ip":
			return tl("IP / copyright");
		default:
			return reason;
	}
}
