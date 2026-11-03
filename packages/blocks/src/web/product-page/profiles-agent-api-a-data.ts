import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { docsHref } from "../data/resources.tsx";
import {
	ENGLISH_LIMIT_VALUES,
	formatCount,
	formatUsd,
	formatUsdRate,
	PUBLISHED_PRICING,
} from "../data/standalone-pricing.ts";
import type { ProductInterfaceRow, ProductProfile } from "./profile-types.ts";

/**
 * Ryu Box's profile, split out of ./profiles-agent-api-a.ts to keep each file
 * under the size limit, plus the rows every agent-api-a profile shares. Same
 * grounding rules: every entry names its source file and a verbatim quote
 * (checked by ./profile-grounding.ts); every price is computed from
 * `PRICING_COPY`. Box tells a capacity story: sizes, rates, and what survives
 * a stop.
 */

const DOCS = "apps/fumadocs/content/docs";
const BOX = `${DOCS}/standalone/box.mdx`;
const BOX_API = `${DOCS}/standalone/box-api.mdx`;
const BOX_SDK = `${DOCS}/standalone/sdk/box.mdx`;

/**
 * English formatting for a profile line built around a computed value (a
 * price, a service name), written as one catalog message so the DOM localizer
 * translates the rendered sentence through its template. Import it as `tl`.
 */
export const profileMessage: LiteralMessage = (source, values = {}) =>
	formatMessage(source, values, "en");
const tl = profileMessage;
const { box } = PUBLISHED_PRICING;

/** The one file every displayed price comes from (see ./profile-grounding.ts). */
export const PRICING_SOURCE = {
	path: "packages/blocks/src/web/data/standalone-pricing.ts",
} as const;

/** Where the public API hosts are listed (box, gateway, mail, notify). */
export const API_HOSTS_SOURCE_PATH =
	"apps/web/src/lib/standalone-product-hosts.ts";

const UNPUBLISHED_PACKAGES = "apps/web/src/lib/service-openapi-discovery.ts";

/** `@ryuhq/services` exists in the repo but is not on npm: say so, never `npm install` it. */
export function servicesSdkRow(
	service: string,
	sdkDocsPath: string
): ProductInterfaceRow {
	return {
		kind: "SDK",
		name: "@ryuhq/services",
		summary: tl(
			"The TypeScript SDK puts {service} behind one new Ryu(), with idempotency keys, retries, and typed errors.",
			{ service }
		),
		href: docsHref(sdkDocsPath),
		status: "not-published",
		note: "Not on npm yet. The Python client in ryu-sdk is not on PyPI yet either.",
		source: {
			path: UNPUBLISHED_PACKAGES,
			quote:
				"TypeScript SDK for the standalone services. Not yet published to npm.",
		},
	};
}

/** The `ryu-services` CLI and its stdio MCP server, also unpublished. */
export function servicesCliRow(
	command: string,
	cliDocsPath: string,
	/** What this service's CLI does, when it is not "the same calls" (Connect). */
	override?: { summary: string; path: string; quote: string }
): ProductInterfaceRow {
	return {
		kind: "CLI",
		name: command,
		summary:
			override?.summary ??
			"The ryu-services command line and its MCP server run the same calls from a shell, a CI job, or an AI host.",
		href: docsHref(cliDocsPath),
		status: "not-published",
		note: "Not on npm yet, so it cannot be installed outside the Ryu repository.",
		source: override
			? { path: override.path, quote: override.quote }
			: {
					path: UNPUBLISHED_PACKAGES,
					quote:
						"The `ryu-services` CLI and MCP server for the standalone services (read-only by default). Not yet published to npm.",
				},
	};
}

const BOX_CREATE = [
	`curl -sS -X POST "\${RYU_BOX_URL:-https://box.ryuhq.com}/v1/boxes" \\`,
	'  -H "Authorization: Bearer $RYU_BOX_API_KEY" \\',
	'  -H "Idempotency-Key: build-runner-1" \\',
	'  -H "Content-Type: application/json" \\',
	`  -d '{"name":"build-runner","size":"small"}'`,
].join("\n");

const BOX_COMMAND = [
	`curl -sS -X POST "\${RYU_BOX_URL:-https://box.ryuhq.com}/v1/boxes/<box-id>/commands" \\`,
	'  -H "Authorization: Bearer $RYU_BOX_API_KEY" \\',
	'  -H "Content-Type: application/json" \\',
	`  -d '{"command":"cat","args":["/etc/os-release"]}'`,
].join("\n");

export const BOX_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Machine",
			value: "Linux, with no GPU or Windows option",
			source: { path: BOX, quote: "Box has no GPU or Windows option." },
		},
		{
			label: "Default image",
			value: "ubuntu:24.04",
			source: {
				path: BOX_SDK,
				quote: "A new Box runs the default `ubuntu:24.04` image",
			},
		},
		{
			label: "Isolation",
			value: "Its own container, screen, browser, and gVisor sandbox",
			source: {
				path: BOX,
				quote:
					"each Box keeps its own container, screen, browser, and gVisor sandbox.",
			},
		},
		{
			label: "What persists",
			value: "Files survive commands, stop and resume, and forks",
			source: {
				path: BOX,
				quote:
					"Its filesystem survives commands, stop/resume cycles, and forks.",
			},
		},
		{
			label: "Capacity",
			value: "No queue: each Box starts on the first capacity available",
			source: { path: BOX, quote: "Ryu does not queue Boxes." },
		},
	],
	code: [
		{
			id: "box-create",
			label: "Create a Box",
			language: "bash",
			code: BOX_CREATE,
			source: {
				path: BOX_SDK,
				quote: '-H "Idempotency-Key: build-runner-1" \\',
			},
		},
		{
			id: "box-command",
			label: "Run a command",
			language: "bash",
			code: BOX_COMMAND,
			source: {
				path: BOX_SDK,
				quote: `-d '{"command":"cat","args":["/etc/os-release"]}'`,
			},
		},
	],
	interfaces: [
		{
			kind: "REST",
			name: "Box API",
			summary:
				"Create, stop, resume, and fork Boxes; run commands and processes; read files; open previews, terminals, and snapshots.",
			href: docsHref("/docs/standalone/box-api"),
			source: {
				path: BOX_API,
				quote:
					"| `POST` | `/v1/boxes/:id/stop` | Stop the workspace while retaining its disk;",
			},
		},
		{
			kind: "REST",
			name: "Desktop actions and stream",
			summary:
				"Agents click, type, and take screenshots through the desktop actions route; people watch over an authenticated WebSocket stream.",
			href: docsHref("/docs/standalone/box-api#desktop"),
			source: {
				path: BOX,
				quote:
					"Agents drive it through `POST /v1/boxes/:id/desktop/actions` (screenshot, click, type, key, scroll, focus an app)",
			},
		},
		servicesSdkRow("Box", "/docs/standalone/sdk/box"),
		servicesCliRow("ryu-services box", "/docs/standalone/sdk/box-cli-mcp"),
	],
	openapi: {
		href: "/openapi/box.json",
		baseUrl: "https://box.ryuhq.com",
		source: { path: API_HOSTS_SOURCE_PATH, quote: '"box.ryuhq.com",' },
	},
	limits: {
		title: "Sizes, rates, and limits",
		rows: [
			{
				label: "small",
				value: tl("{price} per running hour", {
					price: formatUsdRate(box.smallHourUsd),
				}),
				note: "2 vCPU, 4 GiB",
				source: PRICING_SOURCE,
			},
			{
				label: "default",
				value: tl("{price} per running hour", {
					price: formatUsdRate(box.defaultHourUsd),
				}),
				note: "4 vCPU, 8 GiB",
				source: PRICING_SOURCE,
			},
			{
				label: "large",
				value: tl("{price} per running hour", {
					price: formatUsdRate(box.largeHourUsd),
				}),
				note: "8 vCPU, 16 GiB",
				source: PRICING_SOURCE,
			},
			{
				label: "Each start",
				value: ENGLISH_LIMIT_VALUES.boxMinimum,
				note: "Billed in whole minutes after that. A stopped Box costs nothing for compute.",
				source: PRICING_SOURCE,
			},
			{
				label: "Saved state and snapshots",
				value: tl("{price} per GiB-month", {
					price: formatUsd(box.storageGibMonthUsd, 2),
				}),
				note: tl(
					"Above the {includedGib} GiB a paid organization includes; {trialGib} GiB without a paid plan.",
					{
						includedGib: formatCount(box.includedStorageGib.paid),
						trialGib: formatCount(box.includedStorageGib.trial),
					}
				),
				source: PRICING_SOURCE,
			},
			{
				label: "Running Boxes at once",
				value: "1 to 20, by plan",
				note: "1 without a paid plan; Plus and Pro 2; Max 4; Teams Lite and Teams 10; Business 20.",
				source: {
					path: BOX,
					quote: "Your plan limits how many Boxes run at the same time.",
				},
			},
			{
				label: "Viewers per Box",
				value: "4",
				note: "Stopping, parking, or deleting the Box closes every stream.",
				source: {
					path: BOX,
					quote: "At most four viewers watch one Box at a time.",
				},
			},
		],
	},
	quickstart: [
		{
			title: "Get a tenant key",
			description:
				"Hosted Box is early access and enabled for each organization by Ryu. Ask Ryu for your tenant key once access is on.",
			source: {
				path: BOX_SDK,
				quote:
					"you need a tenant key for your organization; ask Ryu for it once your access is enabled.",
			},
		},
		{
			title: "Export it",
			description:
				"The key is sent only to the Box origin, as a bearer token. Without RYU_BOX_URL, calls go to box.ryuhq.com.",
			command: 'export RYU_BOX_API_KEY="<tenant-key>"',
			source: { path: BOX_SDK, quote: 'export RYU_BOX_API_KEY="<tenant-key>"' },
		},
		{
			title: "Create, then run",
			description:
				"Create the Box with an idempotency key so a retry is safe, then run commands in it as shown above.",
			source: {
				path: BOX_SDK,
				quote: "Creating requires an `Idempotency-Key`",
			},
		},
		{
			title: "Stop it when you are done",
			description:
				"Stopping saves the workspace before the machine is released. Resume restores the files onto a fresh machine.",
			source: {
				path: BOX,
				quote:
					"When you stop a Box, Ryu saves its workspace to Ryu's storage before it deletes the machine.",
			},
		},
	],
	compareSlugs: ["boat"],
	related: [
		{
			label: "Box lifecycle and workers",
			href: "/docs/standalone/box-lifecycle",
			kind: "docs",
		},
		{ label: "Boxes in Ryu Core", href: "/docs/core/boxes", kind: "docs" },
		{
			label: "Sandboxing and isolation",
			href: "/docs/security/sandboxing-isolation",
			kind: "docs",
		},
	],
	docs: [
		{
			label: "Ryu Box",
			path: "/docs/standalone/box",
			description: "Placement, pricing, storage, and running limits.",
		},
		{
			label: "Box SDK quickstart",
			path: "/docs/standalone/sdk/box",
			description: "A first call with curl, the SDK, the CLI, and MCP.",
		},
		{
			label: "Box API",
			path: "/docs/standalone/box-api",
			description: "Every route and the credential boundary.",
		},
	],
};
