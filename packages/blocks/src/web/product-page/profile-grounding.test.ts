import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	groundingErrors,
	normalizeWhitespace,
	PRICING_SOURCE_PATH,
	repoRoot,
	resolveDocsPath,
} from "./profile-grounding.ts";
import type { ProductProfile } from "./profile-types.ts";
import { PRODUCT_PROFILES } from "./profiles.ts";

const ABOUT = "apps/web/content/pages/about.mdx";
const BOX_API_DOCS = "apps/fumadocs/content/docs/standalone/box-api.mdx";
const HOSTS = "apps/web/src/lib/standalone-product-hosts.ts";
const BOX_BASE_LINE = "export BOX_API_BASE=http://127.0.0.1:8090/v1";

const grounded: ProductProfile = {
	facts: [
		{
			label: "Built by",
			value: "A Major Pte. Ltd.",
			// Reflowed on purpose: quotes match with whitespace normalised.
			source: {
				path: ABOUT,
				quote: "Ryu is built by A Major\n  Pte. Ltd. in Singapore.",
			},
		},
		{
			label: "Small Box",
			value: "$0.025 per hour",
			source: { path: PRICING_SOURCE_PATH },
		},
	],
	code: [
		{
			id: "env",
			label: "Point at the API",
			language: "bash",
			code: `${BOX_BASE_LINE}\nexport BOX_API_TOKEN=replace-me`,
			source: { path: BOX_API_DOCS, quote: BOX_BASE_LINE },
		},
	],
	quickstart: [
		{ title: "Read the API", description: "Start from the reference." },
		{
			title: "Set the base URL",
			description: "Point the client at your service.",
			command: BOX_BASE_LINE,
			source: { path: BOX_API_DOCS, quote: BOX_BASE_LINE },
		},
	],
	docs: [
		{ label: "Box API", path: "/docs/standalone/box-api" },
		{ label: "Core", path: "/docs/core" },
	],
	related: [
		{ label: "Ryu 101", href: "/guides/ryu-101", kind: "guide" },
		{
			label: "Telegram bot",
			href: "/help/how-to-set-up-a-telegram-bot-and-get-your-bot-token",
			kind: "help",
		},
		{ label: "Box docs", href: "/docs/standalone/box", kind: "docs" },
	],
	compareSlugs: ["cursor"],
	openapi: {
		href: "/openapi/box.json",
		baseUrl: "https://box.ryuhq.com",
		source: { path: HOSTS, quote: '"box.ryuhq.com"' },
	},
};

test("repoRoot is the repository root", () => {
	expect(existsSync(join(repoRoot(), "AGENTS.md"))).toBe(true);
	expect(existsSync(join(repoRoot(), PRICING_SOURCE_PATH))).toBe(true);
});

test("whitespace normalisation collapses runs and trims", () => {
	expect(normalizeWhitespace("  a\n\t b  c ")).toBe("a b c");
});

test("docs paths resolve to a page or a section index", () => {
	expect(resolveDocsPath("/docs/standalone/box-api")).toEndWith(
		"standalone/box-api.mdx"
	);
	expect(resolveDocsPath("/docs/core")).toEndWith("core/index.mdx");
	expect(resolveDocsPath("/docs/core#anchor")).toEndWith("core/index.mdx");
	expect(resolveDocsPath("/docs/not-a-page")).toBeUndefined();
	expect(resolveDocsPath("/guides/ryu-101")).toBeUndefined();
});

test("a fully sourced profile has no grounding errors", () => {
	expect(groundingErrors(grounded)).toEqual([]);
});

test("missing files, absolute paths and absent quotes are reported", () => {
	const profile: ProductProfile = {
		facts: [
			{ label: "Gone", value: "x", source: { path: "apps/web/nope.md" } },
			{ label: "Abs", value: "x", source: { path: "/etc/hosts" } },
			{
				label: "Misquoted",
				value: "x",
				source: { path: ABOUT, quote: "Ryu is built on Mars." },
			},
		],
	};
	expect(groundingErrors(profile)).toEqual([
		'fact "Gone": source file does not exist (apps/web/nope.md)',
		'fact "Abs": source path must be repo-relative (/etc/hosts)',
		`fact "Misquoted": quote not found in ${ABOUT}: "Ryu is built on Mars."`,
	]);
});

test("prices must come from the published pricing table", () => {
	const profile: ProductProfile = {
		facts: [
			{
				label: "Rate",
				value: "$0.04 per hour",
				source: { path: ABOUT, quote: "Ryu is built by A Major" },
			},
		],
		limits: {
			title: "Limits",
			rows: [
				{
					label: "Default",
					value: "$0.04",
					source: { path: PRICING_SOURCE_PATH },
				},
			],
		},
	};
	expect(groundingErrors(profile)).toEqual([
		`fact "Rate": a price must come from ${PRICING_SOURCE_PATH}`,
	]);
});

test("code and commands must contain their quote and never install unpublished packages", () => {
	const profile: ProductProfile = {
		facts: [],
		code: [
			{
				id: "drifted",
				label: "Drifted",
				language: "bash",
				code: "export BOX_API_BASE=https://elsewhere.example",
				source: { path: BOX_API_DOCS, quote: BOX_BASE_LINE },
			},
			{
				id: "install",
				label: "Install",
				language: "bash",
				code: `npm install @ryuhq/services\n${BOX_BASE_LINE}`,
				source: { path: BOX_API_DOCS, quote: BOX_BASE_LINE },
			},
		],
		quickstart: [
			{
				title: "Install",
				description: "Add the SDK.",
				command: "bun add @ryuhq/services-cli",
				source: { path: BOX_API_DOCS, quote: BOX_BASE_LINE },
			},
		],
	};
	expect(groundingErrors(profile)).toEqual([
		'code "drifted": its quote is not in the sample',
		'code "install": @ryuhq/services* is not on npm',
		'quickstart "Install": its quote is not the command',
		'quickstart "Install": @ryuhq/services* is not on npm',
	]);
});

test("links must resolve to real docs, content, comparisons and OpenAPI documents", () => {
	const profile: ProductProfile = {
		facts: [],
		docs: [{ label: "Missing", path: "/docs/standalone/nope" }],
		related: [
			{ label: "No guide", href: "/guides/not-a-guide", kind: "guide" },
			{ label: "Wrong shape", href: "/blog", kind: "blog" },
			{ label: "No docs", href: "/docs/nope", kind: "docs" },
		],
		compareSlugs: ["not-a-rival"],
		openapi: {
			href: "/openapi/nope.json",
			baseUrl: "https://nope.ryuhq.com",
			source: { path: HOSTS },
		},
	};
	expect(groundingErrors(profile)).toEqual([
		'docs "Missing": path does not resolve (/docs/standalone/nope)',
		'related "No guide": no guide page at /guides/not-a-guide',
		'related "Wrong shape": no blog page at /blog',
		'related "No docs": docs path does not resolve (/docs/nope)',
		'compare "not-a-rival": no comparison data',
		"openapi: no document at /openapi/nope.json",
		`openapi: ${HOSTS} does not name https://nope.ryuhq.com`,
	]);
});

test("every registered profile is grounded", () => {
	for (const [slug, profile] of Object.entries(PRODUCT_PROFILES)) {
		if (profile) {
			expect([slug, groundingErrors(profile)]).toEqual([slug, []]);
		}
	}
});
