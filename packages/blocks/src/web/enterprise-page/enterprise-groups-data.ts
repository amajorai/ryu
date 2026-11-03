import type { ProductSource } from "../product-page/profile-types.ts";
import { ENTERPRISE_DOCS, ENTERPRISE_SOURCES } from "./enterprise-sources.ts";

/*
 * The three themed groups on /enterprise (Governance, Security, Support). Each
 * item names its source and a verbatim quote; enterprise-data.test.ts checks
 * them. The "Enterprise" tag marks only what the docs gate on an Enterprise
 * entitlement. No SLA, uptime figure or certification is claimed: no source
 * in the repo states one.
 */

const IDENTITY = ENTERPRISE_SOURCES.identity;
const ADMIN = ENTERPRISE_SOURCES.admin;
const BUDGETS = ENTERPRISE_SOURCES.budgets;
const PLANS = ENTERPRISE_SOURCES.plans;
const PLAN_CHANGES = ENTERPRISE_SOURCES.planChanges;
const SEATS = ENTERPRISE_SOURCES.seats;

export type EnterpriseGroupId = "governance" | "security" | "support";

export interface EnterpriseItem {
	readonly description: string;
	/** True only where the docs say the control needs an Enterprise entitlement. */
	readonly enterprise?: boolean;
	readonly source: ProductSource;
	readonly title: string;
}

export interface EnterpriseGroup {
	readonly docs: { readonly label: string; readonly path: string };
	readonly id: EnterpriseGroupId;
	readonly items: readonly EnterpriseItem[];
	readonly kicker: string;
	readonly summary: string;
	readonly title: string;
}

export const ENTERPRISE_GROUPS: readonly EnterpriseGroup[] = [
	{
		id: "governance",
		kicker: "Governance",
		title: "Decide who signs in and what they can spend",
		summary:
			"Identity comes from your directory; roles and budgets are set by your admins.",
		docs: { label: "Enterprise SSO and SCIM", path: ENTERPRISE_DOCS.identity },
		items: [
			{
				title: "Single sign-on",
				description:
					"Employees sign in through your identity provider over OIDC or SAML 2.0, on a domain you verify.",
				enterprise: true,
				source: {
					path: IDENTITY,
					quote: "Ryu supports OIDC and SAML 2.0 connections.",
				},
			},
			{
				title: "SCIM directory sync",
				description:
					"Deactivating someone in your directory signs them out, removes their membership, and revokes the Gateway keys issued to them.",
				enterprise: true,
				source: {
					path: IDENTITY,
					quote:
						"revokes the personal gateway keys and Fleet nodes the organization issued to them",
				},
			},
			{
				title: "Roles",
				description:
					"Primary owner, owner, admin, member, viewer, and billing roles, extended by custom roles.",
				source: {
					path: ADMIN,
					quote:
						"Every member has one of the built-in roles below, optionally extended by custom roles.",
				},
			},
			{
				title: "Budgets and rate limits",
				description:
					"Cap spend for the organization, a member, a team, a key, a project, or a bot, over daily, weekly, monthly, or lifetime windows.",
				source: {
					path: BUDGETS,
					quote:
						"Organization admins set budgets and rate limits in the control plane.",
				},
			},
			{
				title: "Audit log export",
				description:
					"Export organization and Gateway control activity as CSV, without request bodies, provider secrets, or SCIM tokens.",
				enterprise: true,
				source: {
					path: ADMIN,
					quote:
						"It never includes request bodies, provider secrets, or SCIM tokens.",
				},
			},
		],
	},
	{
		id: "security",
		kicker: "Security",
		title: "Keep access narrow and records clean",
		summary:
			"Access policy applies to everything members do inside the organization.",
		docs: {
			label: "Organization admin controls",
			path: ENTERPRISE_DOCS.admin,
		},
		items: [
			{
				title: "Access policy",
				description:
					"An IP allowlist, required two-factor, and a maximum session age.",
				source: {
					path: ADMIN,
					quote:
						"has three controls: an IP allowlist, required two-factor, and a session max age.",
				},
			},
			{
				title: "Zero data retention",
				description:
					"Prompts and completions routed through Ryu are not retained, on every plan.",
				source: {
					path: ADMIN,
					quote:
						"is on for every plan: prompts and completions routed through Ryu are not retained.",
				},
			},
			{
				title: "Signed audit streaming",
				description:
					"Send every control audit event as JSON to your HTTPS endpoint, signed with HMAC-SHA256.",
				source: { path: ADMIN, quote: "an HMAC-SHA256 of" },
			},
			{
				title: "Request logs without content",
				description:
					"Request logs never hold prompts or responses, and keys show only as redacted prefixes.",
				source: {
					path: ADMIN,
					quote:
						"Request logs never contain prompts or responses, and keys appear only as redacted prefixes.",
				},
			},
			{
				title: "Refusals on record",
				description:
					"Refused sessions, API keys, and Secret Vault requests are written to the audit log.",
				source: {
					path: ADMIN,
					quote: "The audit log also records refused access",
				},
			},
			{
				title: "Contracted data region",
				description:
					"Data controls show whether your agreement includes a contracted data region.",
				enterprise: true,
				source: {
					path: ADMIN,
					quote:
						"shows whether your Enterprise agreement includes a contracted data region.",
				},
			},
		],
	},
	{
		id: "support",
		kicker: "Support",
		title: "Agree the terms before you roll out",
		summary:
			"Enterprise is a contract, so the support you get is the support you agree.",
		docs: {
			label: "Enterprise plan",
			path: `${ENTERPRISE_DOCS.plans}#enterprise`,
		},
		items: [
			{
				title: "Talk it through",
				description:
					"Discuss your rollout, the controls you need, and Enterprise access with us.",
				source: {
					path: IDENTITY,
					quote:
						"discuss your organization's rollout, required controls, and Enterprise access.",
				},
			},
			{
				title: "Terms in writing",
				description:
					"The agreement states your seat allowance, workflow capacity, credit pool, support level, and cloud-computer arrangement.",
				source: {
					path: PLAN_CHANGES,
					quote:
						"The Enterprise agreement states the seat allowance, workflow capacity, credit pool, support level, and cloud-computer arrangement.",
				},
			},
			{
				title: "Named onboarding",
				description:
					"Ask for named onboarding, procurement terms, or custom data-region and retention requirements.",
				source: {
					path: PLANS,
					quote:
						"custom data-region or retention requirements, procurement terms, or named onboarding.",
				},
			},
			{
				title: "Past 50 seats",
				description:
					"Teams and Business stop at 50 seats; larger organizations move to Enterprise.",
				source: { path: SEATS, quote: "Larger organizations use Enterprise." },
			},
		],
	},
];

/** The docs' own caveat, shown under the Support group. */
export const ENTERPRISE_GATED_NOTE = {
	text: "Group-to-role mapping, private networking, dedicated deployment, data-region controls, and contractual support are gated separately. Confirm each one is in your agreement before you rely on it.",
	source: {
		path: IDENTITY,
		quote:
			"Group-to-role mapping, private networking, dedicated deployment, data-region controls, and contractual support are separately gated capabilities.",
	},
} as const;
