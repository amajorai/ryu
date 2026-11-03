import type { ProductSource } from "../product-page/profile-types.ts";
import { ENTERPRISE_SOURCES } from "./enterprise-sources.ts";

/*
 * Ryu Infra's three deployment units, side by side, from the open-core and
 * product-model docs. Every cell names its source; enterprise-data.test.ts
 * checks each quote.
 */

const IDENTITY = ENTERPRISE_SOURCES.identity;
const OPEN_CORE = ENTERPRISE_SOURCES.openCore;
const HOSTED_AGENTS = ENTERPRISE_SOURCES.hostedAgents;
const CATALOG = ENTERPRISE_SOURCES.catalog;

export interface DeploymentCell {
	readonly source: ProductSource;
	readonly text: string;
}

export interface DeploymentOption {
	readonly id: "cloud" | "node" | "private";
	readonly name: string;
	readonly summary: string;
}

export const DEPLOYMENT_OPTIONS: readonly [
	DeploymentOption,
	DeploymentOption,
	DeploymentOption,
] = [
	{ id: "cloud", name: "Ryu Cloud", summary: "Managed by Ryu" },
	{
		id: "node",
		name: "Self-hosted Ryu Node",
		summary: "Open source, on your machines",
	},
	{
		id: "private",
		name: "Private/Full Ryu Deployment",
		summary: "Customer-operated, under commercial terms",
	},
];

export interface DeploymentRow {
	/** One cell per `DEPLOYMENT_OPTIONS` entry, in the same order. */
	readonly cells: readonly [DeploymentCell, DeploymentCell, DeploymentCell];
	readonly label: string;
}

export const DEPLOYMENT_ROWS: readonly DeploymentRow[] = [
	{
		label: "What you run",
		cells: [
			{
				text: "A managed Ryu server for your organization",
				source: {
					path: CATALOG,
					quote: "Managed cloud nodes for your agents.",
				},
			},
			{
				text: "Core and the Gateway, with ryu-cli and the SDK clients",
				source: {
					path: OPEN_CORE,
					quote: "The Self-hosted Ryu Node contains:",
				},
			},
			{
				text: "Ryu's control plane and product surfaces around one or more nodes",
				source: {
					path: OPEN_CORE,
					quote:
						"adds the proprietary control plane and product surfaces around one or more nodes.",
				},
			},
		],
	},
	{
		label: "Who operates it",
		cells: [
			{
				text: "Ryu, in the EU or Singapore",
				source: {
					path: CATALOG,
					quote:
						"Teams and Business plans include one, in the EU or Singapore.",
				},
			},
			{
				text: "You own the machine, storage, provider credentials, and network",
				source: {
					path: OPEN_CORE,
					quote:
						"The operator owns the machine, storage, provider credentials, network, and operational policies.",
				},
			},
			{
				text: "You do, on Ryu's commercial backend",
				source: {
					path: OPEN_CORE,
					quote:
						"It remains customer-operated, but it depends on that backend.",
				},
			},
		],
	},
	{
		label: "Ryu account",
		cells: [
			{
				text: "An organization on Teams, Business, or Enterprise",
				source: {
					path: HOSTED_AGENTS,
					quote:
						"gives an organization one shared agent workspace on Teams, Business, or Enterprise.",
				},
			},
			{
				text: "Not needed for local models, your own keys, or headless use",
				source: {
					path: OPEN_CORE,
					quote:
						"Local models, BYOK providers, and headless operation work without a Ryu account",
				},
			},
			{
				text: "Accounts, organizations, and roles are part of it",
				source: {
					path: OPEN_CORE,
					quote:
						"It covers account sessions, organizations, RBAC, entitlements",
				},
			},
		],
	},
	{
		label: "SSO, SCIM, and audit export",
		cells: [
			{
				text: "With an Enterprise entitlement",
				source: {
					path: IDENTITY,
					quote: "an active Enterprise entitlement for the organization",
				},
			},
			{
				text: "Not included: organization governance sits outside the node",
				source: {
					path: OPEN_CORE,
					quote:
						"Managed inference, organization governance, billing, and paid Marketplace operations are outside this unit.",
				},
			},
			{
				text: "Turned on by a vendor-signed Enterprise license",
				source: {
					path: OPEN_CORE,
					quote:
						"A self-hosted Enterprise deployment receives a vendor-signed license.",
				},
			},
		],
	},
	{
		label: "Stronger isolation",
		cells: [
			{
				text: "Dedicated or self-hosted deployment on Enterprise",
				source: {
					path: HOSTED_AGENTS,
					quote: "Enterprise can use dedicated or self-hosted deployment",
				},
			},
			{
				text: "Your own machine, network, and policies",
				source: {
					path: OPEN_CORE,
					quote:
						"The operator owns the machine, storage, provider credentials, network, and operational policies.",
				},
			},
			{
				text: "Customer-operated, with the full control plane",
				source: {
					path: OPEN_CORE,
					quote: "It remains customer-operated",
				},
			},
		],
	},
	{
		label: "Terms",
		cells: [
			{
				text: "Included with Teams and Business, contracted on Enterprise",
				source: {
					path: HOSTED_AGENTS,
					quote: "Enterprise is a contracted plan",
				},
			},
			{
				text: "Apache-2.0 for Core, AGPL-3.0 for the Gateway",
				source: {
					path: OPEN_CORE,
					quote:
						"1. **Core** (Apache-2.0), the orchestration engine on port 7980.",
				},
			},
			{
				text: "Applicable commercial terms",
				source: {
					path: OPEN_CORE,
					quote: "available under the applicable commercial terms.",
				},
			},
		],
	},
];
