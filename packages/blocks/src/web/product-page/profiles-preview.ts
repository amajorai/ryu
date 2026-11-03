import type { StageProductSlug } from "../backgrounds/stage-routes.ts";
import type {
	ProductArchetypeId,
	ProductDocLink,
	ProductFact,
	ProductProfile,
	ProductSource,
} from "./profile-types.ts";
import {
	DEVICES_PROFILE,
	ISLAND_PROFILE,
	MOBILE_PROFILE,
} from "./profiles-preview-surfaces.ts";

/**
 * Product profiles for Compute, Share, Island, Mobile, Devices and Hire
 * (unit preview). Every entry is grounded: each item names its source, and
 * ./profile-grounding.ts checks the file and quote exist. Prices are computed
 * from `PUBLISHED_PRICING`, never typed by hand. What a page needs:
 * `ARCHETYPE_REQUIREMENTS` in ./archetypes.ts and `profileGaps` in ./profiles.ts.
 *
 * Compute, Share and Hire come from the exchange docs, which say what the
 * Desktop pages do today and what is planned. Hire states no price, credit or
 * receipt (it has none). Island, Mobile and Devices live in
 * ./profiles-preview-surfaces.ts.
 */
export const ARCHETYPE = "preview" satisfies ProductArchetypeId;

export const PROFILE_SLUGS = [
	"compute",
	"share",
	"island",
	"mobile",
	"devices",
	"hire",
] as const satisfies readonly StageProductSlug[];

export type ProfileSlug = (typeof PROFILE_SLUGS)[number];

const DOCS = "apps/fumadocs/content/docs";
const EXCHANGE_DOC = `${DOCS}/surfaces/desktop/user-guide/compute-share.mdx`;
const HIRE_DOC = `${DOCS}/standalone/hire.mdx`;

/** Neither exchange surface has a public API yet. */
const NO_EXCHANGE_API: ProductFact = {
	label: "Public API",
	value: "None yet",
	source: {
		path: EXCHANGE_DOC,
		quote: "This build has no public lease, provider-enrollment, or payout API",
	},
};

const ROLLOUT: ProductSource = {
	path: EXCHANGE_DOC,
	quote: "Compute and Share are off by default and rolled out gradually.",
};

const EXCHANGE_DOCS: readonly ProductDocLink[] = [
	{
		label: "Compute and Share",
		path: "/docs/surfaces/desktop/user-guide/compute-share",
		description: "What the Desktop pages do today, and what is not live yet.",
	},
	{
		label: "Nodes, presence, and private networking",
		path: "/docs/core/node-and-presence",
	},
	{
		label: "Ryu products, services, and infra",
		path: "/docs/start-here/architecture/three-products",
	},
];

const COMPUTE_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Workload",
			value: "Any lane, CPU, or GPU",
			source: {
				path: EXCHANGE_DOC,
				quote: "**Workload** - any lane, CPU, or GPU.",
			},
		},
		{
			label: "Lease lengths",
			value: "15 minutes, 1 hour, or 4 hours",
			source: {
				path: EXCHANGE_DOC,
				quote: "**Lease length** - 15 minutes, 1 hour, or 4 hours.",
			},
		},
		{
			label: "Where",
			value: "Agent sidebar or command palette",
			source: {
				path: EXCHANGE_DOC,
				quote:
					"Open **Compute** or **Share** from the sidebar in Agent or the command palette.",
			},
		},
		NO_EXCHANGE_API,
	],
	status: {
		today: [
			{
				text: "Choose a workload and a lease length on the Compute page in Ryu Desktop.",
				source: {
					path: EXCHANGE_DOC,
					quote:
						"Choose workload and lease length; live provider search is not enabled yet",
				},
			},
			{
				text: "Off by default, and turned on for accounts gradually.",
				source: ROLLOUT,
			},
		],
		planned: [
			{
				text: "Live provider search. Find capacity stays off until the provider network is up.",
				source: {
					path: EXCHANGE_DOC,
					quote:
						"**Find capacity** stays disabled while the provider network is unavailable",
				},
			},
			{
				text: "Each lease runs in a short-lived, scoped workspace on the host.",
				source: {
					path: EXCHANGE_DOC,
					quote: "A lease is planned as a short-lived Ryu workcell",
				},
			},
			{
				text: "The lease owner gets the job result and a receipt for the measured work.",
				source: {
					path: EXCHANGE_DOC,
					quote:
						"The lease owner receives the job result and a receipt for the measured work.",
				},
			},
		],
		notPlanned: [
			{
				text: "SSH, VNC, or a login to the provider's machine.",
				source: {
					path: EXCHANGE_DOC,
					quote: "not SSH, VNC, or a login to the provider's machine",
				},
			},
		],
	},
	docs: EXCHANGE_DOCS,
};

const SHARE_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Offers",
			value: "A compute lane or a hosted agent",
			source: {
				path: EXCHANGE_DOC,
				quote:
					"**Hosted agent** - run a signed, approved agent package on the node.",
			},
		},
		{
			label: "Schedule",
			value: "When idle, or on a schedule",
			source: {
				path: EXCHANGE_DOC,
				quote: "Choose **When idle** or **On a schedule**.",
			},
		},
		{
			label: "Active work",
			value: "Protect active work refuses leases",
			source: {
				path: EXCHANGE_DOC,
				quote:
					"Keep **Protect active work** on if the node must refuse leases while you use it.",
			},
		},
		NO_EXCHANGE_API,
	],
	status: {
		today: [
			{
				text: "Choose an offer and a schedule on the Share page in Ryu Desktop.",
				source: {
					path: EXCHANGE_DOC,
					quote: "Choose an offer and schedule; publishing is not enabled yet",
				},
			},
			{
				text: "Preview your provider policy locally before anything is published.",
				source: {
					path: EXCHANGE_DOC,
					quote: "These controls are a local preview of the provider policy.",
				},
			},
		],
		planned: [
			{
				text: "Publish a listing, once enrollment, metering, and payout controls exist.",
				source: {
					path: EXCHANGE_DOC,
					quote:
						"**Publish listing** stays disabled until provider enrollment, metering, and payout controls are available.",
				},
			},
			{
				text: "Gateway enforces each lease's identity, grants, budget, audit, metering, and payout.",
				source: {
					path: EXCHANGE_DOC,
					quote:
						"**Gateway** must enforce the lease's identity, capability grants, budget, audit, metering, and payout rules.",
				},
			},
		],
		notPlanned: [
			{
				text: "Giving a renter your node token, host files, private keys, or an open remote session.",
				source: {
					path: EXCHANGE_DOC,
					quote:
						"A provider never gives a renter the node token, host files, private keys, or an unrestricted remote session.",
				},
			},
			{
				text: "Offering a Ryu-managed node as your own.",
				source: {
					path: EXCHANGE_DOC,
					quote: "are not offered as personal providers",
				},
			},
		],
	},
	docs: EXCHANGE_DOCS,
};

/** Hire's own "What to use now" answer. */
const RYU_APPS_TODAY: ProductSource = {
	path: HIRE_DOC,
	quote:
		"install it from [Ryu Apps](/docs/extend/develop/extensions/ryu-apps) and run it in",
};

const HIRE_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Status",
			value: "Not yet available",
			source: {
				path: HIRE_DOC,
				quote: "Ryu Hire is in early access and **not yet available**",
			},
		},
		{
			label: "Planned",
			value: "Run one specialist once, with nothing to install",
			source: {
				path: HIRE_DOC,
				quote:
					"review what it needs, and run it once without installing the agent.",
			},
		},
		{
			label: "API or self-hosted service",
			value: "None published",
			source: {
				path: HIRE_DOC,
				quote:
					"Ryu hasn't published a self-hosted Hire service or a Hire API contract.",
			},
		},
		{
			label: "Use today",
			value: "Ryu Apps in OS or Agent",
			source: RYU_APPS_TODAY,
		},
	],
	status: {
		today: [
			{
				text: "Install a specialist from Ryu Apps and run it in OS or Agent.",
				source: RYU_APPS_TODAY,
			},
			{
				text: "Installed apps keep a persistent workspace and the normal permission and audit path.",
				source: {
					path: HIRE_DOC,
					quote:
						"Installed apps run with a persistent workspace and the normal permission and audit path.",
				},
			},
		],
		planned: [
			{
				text: "Choose a specialist from the Ryu Apps catalog.",
				source: {
					path: HIRE_DOC,
					quote: "You would choose a specialist from the Ryu Apps catalog,",
				},
			},
			{
				text: "The specialist works in a managed execution context and returns the result.",
				source: {
					path: HIRE_DOC,
					quote:
						"The specialist works in a managed execution context and returns the result.",
				},
			},
		],
	},
	docs: [
		{
			label: "Ryu Hire",
			path: "/docs/standalone/hire",
			description: "The planned flow, and what to use now.",
		},
		{ label: "Ryu Apps", path: "/docs/extend/develop/extensions/ryu-apps" },
		{ label: "Standalone services", path: "/docs/standalone" },
	],
	related: [
		{
			label: "Compute and Share",
			href: "/docs/surfaces/desktop/user-guide/compute-share",
			kind: "docs",
		},
	],
};

export const PROFILES: Partial<Record<ProfileSlug, ProductProfile>> = {
	compute: COMPUTE_PROFILE,
	share: SHARE_PROFILE,
	island: ISLAND_PROFILE,
	mobile: MOBILE_PROFILE,
	devices: DEVICES_PROFILE,
	hire: HIRE_PROFILE,
};
