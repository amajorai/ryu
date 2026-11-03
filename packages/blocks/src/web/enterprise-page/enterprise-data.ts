import { OPEN_SOURCE_REPOS } from "../data/company.ts";
import type {
	ProductCodeSample,
	ProductSource,
} from "../product-page/profile-types.ts";
import {
	DEPLOYMENT_OPTIONS,
	DEPLOYMENT_ROWS,
} from "./enterprise-deployment-data.ts";
import {
	ENTERPRISE_GATED_NOTE,
	ENTERPRISE_GROUPS,
} from "./enterprise-groups-data.ts";
import { ENTERPRISE_SOURCES } from "./enterprise-sources.ts";

/*
 * The /enterprise page's fact sheet, rollout checklist, identity endpoints and
 * sub-nav, plus the copy list for the banned-word check. Groups and the
 * deployment table live in their own data files.
 */

const IDENTITY = ENTERPRISE_SOURCES.identity;
const ADMIN = ENTERPRISE_SOURCES.admin;
const PLANS = ENTERPRISE_SOURCES.plans;
const THREE_PRODUCTS = ENTERPRISE_SOURCES.threeProducts;
const COMPANY = ENTERPRISE_SOURCES.company;

export interface EnterpriseFact {
	readonly external?: boolean;
	readonly href?: string;
	readonly label: string;
	readonly source: ProductSource;
	readonly value: string;
}

const RYU_REPO = OPEN_SOURCE_REPOS.find((repo) => repo.name === "amajorai/ryu");

export const ENTERPRISE_FACTS: readonly EnterpriseFact[] = [
	{
		label: "Price",
		value: "Custom",
		source: {
			path: PLANS,
			quote: "| **Enterprise** | Custom | Organization contract |",
		},
	},
	{
		label: "Scope",
		value: "Organization contract",
		source: {
			path: PLANS,
			quote: "| **Enterprise** | Custom | Organization contract |",
		},
	},
	{
		label: "When to choose it",
		value: "More than 50 seats or custom terms",
		source: { path: PLANS, quote: "More than 50 seats or custom terms" },
	},
	{
		label: "Deployment",
		value: "Ryu Cloud, self-hosted, or private",
		source: {
			path: THREE_PRODUCTS,
			quote:
				"Choose Ryu Cloud, run a Self-hosted Ryu Node, or operate the full private deployment.",
		},
	},
	{
		label: "Single sign-on",
		value: "OIDC and SAML 2.0",
		source: {
			path: IDENTITY,
			quote: "Ryu supports OIDC and SAML 2.0 connections.",
		},
	},
	{
		label: "Directory sync",
		value: "SCIM 2.0",
		source: { path: IDENTITY, quote: "SCIM 2.0 Users endpoint" },
	},
	{
		label: "Data retention",
		value: "Zero data retention on every plan",
		source: { path: ADMIN, quote: "is on for every plan" },
	},
	{
		label: "Open source",
		value: (RYU_REPO?.licenses ?? []).join(" and "),
		href: RYU_REPO?.href,
		external: true,
		source: { path: COMPANY, quote: "AGPL-3.0-or-later" },
	},
];

export interface RolloutStep {
	readonly description: string;
	readonly source: ProductSource;
	readonly title: string;
}

/** The docs' safe-rollout checklist, in order. */
export const ROLLOUT_STEPS: readonly RolloutStep[] = [
	{
		title: "Start small",
		description: "Begin with one organization and one directory group.",
		source: {
			path: IDENTITY,
			quote:
				"For larger rollouts, start with one organization and one directory group.",
		},
	},
	{
		title: "Keep a way back in",
		description:
			"Keep one owner or admin with a non-SSO recovery method until the first SSO sign-in works.",
		source: {
			path: IDENTITY,
			quote:
				"Keep at least one owner/admin account with a working non-SSO recovery method until the first SSO login succeeds.",
		},
	},
	{
		title: "Test both sides",
		description:
			"Sign in with an employee account and with an account that is deliberately unassigned.",
		source: {
			path: IDENTITY,
			quote:
				"Test an employee account and an intentionally unassigned account.",
		},
	},
	{
		title: "Check removal",
		description:
			"Deactivate a test user in the directory and confirm they can no longer open the organization.",
		source: {
			path: IDENTITY,
			quote:
				"Deactivate a test user in the directory, then verify that they no longer appear as an organization member and cannot open the organization.",
		},
	},
	{
		title: "Rotate the token",
		description:
			"Rotate the SCIM token afterwards if setup happened on a shared screen or in a ticket.",
		source: {
			path: IDENTITY,
			quote:
				"Rotate the SCIM token after testing if the setup was performed in a shared screen or ticket.",
		},
	},
];

/** The two URLs a directory administrator copies into the identity provider. */
export const IDENTITY_ENDPOINTS: readonly ProductCodeSample[] = [
	{
		id: "saml-acs",
		label: "SAML ACS URL",
		language: "http",
		code: "https://<your-ryu-auth-host>/api/auth/sso/saml2/sp/acs/<provider-id>",
		source: {
			path: IDENTITY,
			quote:
				"https://<your-ryu-auth-host>/api/auth/sso/saml2/sp/acs/<provider-id>",
		},
	},
	{
		id: "scim-base",
		label: "SCIM base URL",
		language: "http",
		code: "https://<your-ryu-auth-host>/api/auth/scim/v2",
		source: {
			path: IDENTITY,
			quote: "https://<your-ryu-auth-host>/api/auth/scim/v2",
		},
	},
];

/** Anchors for the page's sub-nav, in page order. */
export const ENTERPRISE_NAV = [
	{ id: "at-a-glance", label: "At a glance" },
	{ id: "controls", label: "Controls" },
	{ id: "governance", label: "Governance" },
	{ id: "security", label: "Security" },
	{ id: "support", label: "Support" },
	{ id: "deployment", label: "Deployment" },
	{ id: "rollout", label: "Rollout" },
] as const;

/** Every visible string above, for the banned-copy check. */
export function enterpriseCopyStrings(): string[] {
	const texts: string[] = [ENTERPRISE_GATED_NOTE.text];
	for (const group of ENTERPRISE_GROUPS) {
		texts.push(group.kicker, group.title, group.summary, group.docs.label);
		for (const item of group.items) {
			texts.push(item.title, item.description);
		}
	}
	for (const fact of ENTERPRISE_FACTS) {
		texts.push(fact.label, fact.value);
	}
	for (const option of DEPLOYMENT_OPTIONS) {
		texts.push(option.name, option.summary);
	}
	for (const row of DEPLOYMENT_ROWS) {
		texts.push(row.label);
		for (const cell of row.cells) {
			texts.push(cell.text);
		}
	}
	for (const step of ROLLOUT_STEPS) {
		texts.push(step.title, step.description);
	}
	return texts;
}
