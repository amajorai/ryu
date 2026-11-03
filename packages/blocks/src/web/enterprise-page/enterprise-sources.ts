/*
 * Repo files the /enterprise page's copy comes from. enterprise-data.test.ts
 * checks that each exists and that every quoted line appears in it.
 */

const DOCS = "apps/fumadocs/content/docs";

export const ENTERPRISE_SOURCES = {
	identity: `${DOCS}/security/enterprise-identity.mdx`,
	admin: `${DOCS}/security/organization-admin-controls.mdx`,
	budgets: `${DOCS}/gateway/hosted-budgets.mdx`,
	plans: `${DOCS}/billing/plans.mdx`,
	planChanges: `${DOCS}/billing/plan-changes.mdx`,
	seats: `${DOCS}/billing/seats.mdx`,
	openCore: `${DOCS}/start-here/architecture/open-core.mdx`,
	threeProducts: `${DOCS}/start-here/architecture/three-products.mdx`,
	hostedAgents: `${DOCS}/billing/hosted-agents.mdx`,
	catalog: "packages/blocks/src/web/data/catalog/core-box.tsx",
	company: "packages/blocks/src/web/data/company.ts",
} as const;

/** Docs-site paths the page links to (rendered through `docsHref`). */
export const ENTERPRISE_DOCS = {
	identity: "/docs/security/enterprise-identity",
	admin: "/docs/security/organization-admin-controls",
	plans: "/docs/billing/plans",
	openCore: "/docs/start-here/architecture/open-core",
	infra: "/docs/start-here/architecture/three-products",
} as const;
