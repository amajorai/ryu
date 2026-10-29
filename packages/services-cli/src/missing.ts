// packages/services-cli/src/missing.ts
//
// Words a service's missing settings for a person. `doctor` and the MCP
// server's startup skip lines share it, so neither reads alternative setups
// (Mail's hosted or self-hosted keys, Passport's administration or runtime
// key) as settings that are all required.

import type { RyuService } from "@ryuhq/services";

/**
 * What to set: every variable a service lists is needed (`set RYU_SITES_URL
 * and RYU_SITES_API_KEY`; Messaging names the organization in every route, so
 * it needs RYU_ORGANIZATION_ID whatever the key), except Mail's, which are
 * alternative setups, and Passport's key, which may be the administration
 * token or the runtime grant. Empty when nothing is listed.
 */
export function missingPhrase(
	service: RyuService,
	missing: readonly string[]
): string {
	if (missing.length === 0) {
		return "";
	}
	if (
		service === "mail" &&
		missing.includes("RYU_API_KEY") &&
		missing.includes("RYU_MAIL_GATEWAY_KEY")
	) {
		// Without RYU_MAIL_API_KEY in the list, RYU_MAIL_URL names the
		// control-plane origin: hosted Mail, where the self-hosted bearer does
		// not apply.
		return missing.includes("RYU_MAIL_API_KEY")
			? "set one of: RYU_API_KEY or RYU_MAIL_GATEWAY_KEY for hosted Mail, or RYU_MAIL_URL and RYU_MAIL_API_KEY for a self-hosted server"
			: "set one of: RYU_API_KEY or RYU_MAIL_GATEWAY_KEY for hosted Mail";
	}
	if (service === "passport" && missing.includes("RYU_PASSPORT_API_KEY")) {
		const required = missing.filter(
			(name) =>
				name !== "RYU_PASSPORT_API_KEY" && name !== "RYU_PASSPORT_RUNTIME_KEY"
		);
		const key =
			"one of RYU_PASSPORT_API_KEY (administration) or RYU_PASSPORT_RUNTIME_KEY (an agent's runtime grant)";
		return required.length > 0
			? `set ${required.join(" and ")} and ${key}`
			: `set ${key}`;
	}
	return `set ${missing.join(" and ")}`;
}
