import type { GatewaySection } from "@/src/store/useGatewayDialog.ts";
import type { GATEWAY_SECTIONS } from "./gateway-sections.ts";

/**
 * Sidebar-grouped layout for the gateway sections, mirroring the main
 * SettingsDialog (inset sidebar + scrollable content pane).
 */
/**
 * Nav groups, retitled around the question each group answers rather than the
 * subsystem it belongs to ("Policy" / "Observability" / "Node" meant nothing to
 * anyone who hadn't read the code). Order is by how often a person needs it.
 *
 * The "Node" group's position is load-bearing: {@link buildEntityNavGroups}
 * output (manifest-registered app/plugin settings tabs) is spliced in directly
 * before it, so app tabs land above the computer-level infra and below the
 * gateway's own sections.
 */
export const GATEWAY_NAV_GROUPS: { items: GatewaySection[]; title?: string }[] =
	[
		{ items: ["overview", "workspace", "permissions", "defaults"] },
		{
			title: "AI & models",
			items: ["providers", "keys", "routing"],
		},
		{
			title: "Limits & safety",
			items: [
				"budgets",
				"guardrails",
				"traffic-map",
				"policies",
				"runtime",
				"hooks",
			],
		},
		{
			title: "Connect",
			items: ["api", "network", "integrations", "connections", "email-alerts"],
		},
		{
			title: "Developer",
			items: ["git", "worktrees", "environments", "cloud-environments", "mcp"],
		},
		{
			title: "Transfer",
			items: ["import", "export"],
		},
		{ title: "Reports", items: ["usage", "audit", "evals"] },
		// Node-level Core-infra tabs moved out of the App Settings dialog (not apps —
		// apps register their own tabs dynamically under the Apps/Plugins headers).
		{
			title: "This device",
			// A section listed in GATEWAY_SECTIONS but missing from a group here renders
			// NOWHERE, with no type error and no warning, so the two lists move together.
			items: [
				"computer",
				"onboarding",
				"privacy",
				"storage",
				"encryption",
				"updates",
				"health",
			],
		},
		{ title: "Danger", items: ["danger"] },
	];

/** Case-insensitive match of a query against a section's label, hint, keywords. */
export function sectionMatches(
	section: (typeof GATEWAY_SECTIONS)[number],
	query: string
): boolean {
	const haystack =
		`${section.label} ${section.hint} ${section.keywords ?? ""} ${section.value}`.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((term) => haystack.includes(term));
}
