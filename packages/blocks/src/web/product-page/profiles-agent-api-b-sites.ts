import { docsHref } from "../data/resources.tsx";
import type { ProductProfile } from "./profile-types.ts";
import { servicesCliRow, servicesSdkRow } from "./profiles-agent-api-a-data.ts";

/**
 * Ryu Sites' profile, split out of ./profiles-agent-api-b.ts to keep each file
 * under the size limit. Sites tells a release story: save immutable versions,
 * deploy only the one you reviewed, and a secret in that exact version blocks
 * the deploy. Sites has no hosted service and no published price, and the
 * standalone release is not out yet; the facts say so rather than offering a
 * quickstart that cannot run.
 */

const DOCS = "apps/fumadocs/content/docs";
const SITES = `${DOCS}/standalone/sites.mdx`;
const SITES_API = `${DOCS}/standalone/sites-api.mdx`;
const SITES_SDK = `${DOCS}/standalone/sdk/sites.mdx`;

const AUTH = '  -H "Authorization: Bearer $RYU_SITES_API_KEY" \\';
const JSON_TYPE = '  -H "Content-Type: application/json" \\';

const SAVE_BODY = `-d '{"html":"<!doctype html><title>Launch</title><h1>Launch notes</h1>","message":"First draft","expectedRevision":0}'`;
const DEPLOY_BODY = `-d '{"versionId":"<version-id>","expectedRevision":1}'`;

const SITES_SAVE = [
	'curl -sS -X POST "$RYU_SITES_URL/api/sites/projects" \\',
	AUTH,
	JSON_TYPE,
	`  -d '{"name":"Launch notes","slug":"launch-notes"}'`,
	"",
	'curl -sS -X POST "$RYU_SITES_URL/api/sites/projects/<site-id>/versions" \\',
	AUTH,
	JSON_TYPE,
	`  ${SAVE_BODY}`,
].join("\n");

const SITES_DEPLOY = [
	'curl -sS -X POST "$RYU_SITES_URL/api/sites/projects/<site-id>/deploy" \\',
	AUTH,
	JSON_TYPE,
	`  ${DEPLOY_BODY}`,
].join("\n");

const PROJECT_URL = '"$RYU_SITES_URL/api/sites/projects/<site-id>';
const BEARER = '-H "Authorization: Bearer $RYU_SITES_API_KEY"';

export const SITES_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Hosting",
			value:
				"Self-hosted only: no Ryu-hosted service, price, or container image",
			source: {
				path: SITES,
				quote:
					"There is no Ryu-hosted Sites service, no published hosted rate, and no published container image.",
			},
		},
		{
			label: "Standalone release",
			value: "Needs a ryu-sites release after 0.4.0, not published yet",
			source: {
				path: SITES,
				quote:
					"Standalone mode needs a ryu-sites release after 0.4.0, and the published `amajorai/ryu-sites` mirror does not have it yet.",
			},
		},
		{
			label: "Visitor pages",
			value: "A separate listener, under a restrictive Content Security Policy",
			source: {
				path: SITES,
				quote:
					"It serves the deployed version of each Site on a separate visitor listener under a restrictive Content Security Policy.",
			},
		},
		{
			label: "New Sites",
			value: "Private, and deploying does not change that",
			source: {
				path: SITES,
				quote: "A new Site is private, and deploying it does not change that",
			},
		},
		{
			label: "Gateway check",
			value:
				"Optional; if the Gateway cannot be reached, the deploy is blocked",
			source: {
				path: SITES,
				quote:
					"When the Gateway cannot be reached or refuses the key, the deploy is blocked;",
			},
		},
		{
			label: "Tenancy",
			value: "One tenant per process and data directory",
			source: {
				path: SITES,
				quote: "The standalone process is one tenant per service instance:",
			},
		},
	],
	code: [
		{
			id: "sites-save",
			label: "Create and save a version",
			language: "bash",
			code: SITES_SAVE,
			source: { path: SITES_SDK, quote: SAVE_BODY },
		},
		{
			id: "sites-deploy",
			label: "Deploy the version you reviewed",
			language: "bash",
			code: SITES_DEPLOY,
			source: { path: SITES_SDK, quote: DEPLOY_BODY },
		},
	],
	interfaces: [
		{
			kind: "REST",
			name: "Sites management API",
			summary:
				"Create Sites, save immutable versions, scan and deploy one, unpublish, and manage access, domains, records, and analytics.",
			href: docsHref("/docs/standalone/sites-api"),
			source: {
				path: SITES_API,
				quote:
					"| `POST` | `/api/sites/projects/:id/deploy` | Sites bearer | Scan and deploy a saved version |",
			},
		},
		{
			kind: "Desktop",
			name: "Sites in Ryu Desktop",
			summary:
				"The Sites management screens and AI page generation run in Ryu Desktop. A standalone process takes finished HTML through its API.",
			href: docsHref("/docs/surfaces/desktop/user-guide/sites"),
			source: {
				path: SITES,
				quote:
					"| AI page generation (**Generate changes**, **Ask Ryu**) | Desktop only. Send finished HTML to the versions route. |",
			},
		},
		servicesSdkRow("Sites", "/docs/standalone/sdk/sites"),
		servicesCliRow("ryu-services sites", "/docs/standalone/sdk/sites-cli-mcp"),
	],
	openapi: {
		href: "/openapi/sites.json",
		source: {
			path: "apps/web/public/openapi/sites.json",
			quote: "There is no Ryu-hosted Sites.",
		},
	},
	limits: {
		title: "What one Sites process holds",
		rows: [
			{
				label: "Sites",
				value: "30 per process",
				source: { path: SITES_API, quote: "| Sites | 30 per service |" },
			},
			{
				label: "Saved versions",
				value: "100 per Site",
				note: "2 MB each, 50 MB in total.",
				source: {
					path: SITES_API,
					quote: "| Saved versions | 100 per Site, 50 MB in total, 2 MB each |",
				},
			},
			{
				label: "Custom domains",
				value: "5 per Site",
				note: "A verified domain serves visitors once your edge confirms it terminates HTTPS for it.",
				source: { path: SITES_API, quote: "| Custom domains | 5 per Site |" },
			},
			{
				label: "Visitor records",
				value: "1,000 per Site",
				note: "100 records and 120 KB per visitor; 64 KB per record; 1.2 MB per Site.",
				source: {
					path: SITES_API,
					quote:
						"| Durable records | 1,000 per Site; 100 records and 120 KB per visitor; 64 KB per record; 1.2 MB per Site |",
				},
			},
			{
				label: "Uploaded files",
				value: "100 per Site",
				note: "5 MB per file; 10 files and 25 MB per visitor.",
				source: {
					path: SITES_API,
					quote:
						"| Uploaded files | 100 per Site; 10 files and 25 MB per visitor; 5 MB per file |",
				},
			},
			{
				label: "Visitor requests",
				value: "120 a minute per visitor address",
				note: "6,000 a minute per Site.",
				source: {
					path: SITES_API,
					quote:
						"| Visitor requests | 120 per minute per visitor address; 6,000 per minute per Site |",
				},
			},
		],
	},
	guardrail: {
		title: "The deploy rescans the exact version you ship",
		description:
			"Saving a version never changes what is deployed. Deploying repeats a secret scan of that exact version, and a match blocks it. A passed scan is not a complete code audit.",
		lines: [
			{
				kind: "command",
				text: `curl -sS -X POST ${PROJECT_URL}/versions" ${BEARER} -d '{"html":"<!doctype html>…<script>const key = \\"<a live Stripe secret key>\\"</script>","message":"Add checkout","expectedRevision":1}'`,
			},
			{
				kind: "allowed",
				text: "Saved · a new immutable version; the deployed one is unchanged",
			},
			{
				kind: "command",
				text: `curl -sS -X POST ${PROJECT_URL}/deploy" ${BEARER} -d '{"versionId":"<new-version-id>","expectedRevision":2}'`,
			},
			{
				kind: "denied",
				text: "422 security_blocked · the deploy scan found a secret",
			},
			{
				kind: "output",
				text: "Remove the key, save a new version, and deploy that one.",
			},
		],
		source: {
			path: SITES,
			quote:
				"Deployment repeats a secret scan of the exact saved version. A match blocks the deploy with `422 security_blocked`. A passed scan is not a complete code audit.",
		},
	},
	related: [
		{
			label: "Sites in Ryu Desktop",
			href: "/docs/surfaces/desktop/user-guide/sites",
			kind: "docs",
		},
		{
			label: "Ryu Gateway for deploy scans",
			href: "/docs/standalone/gateway",
			kind: "docs",
		},
	],
	docs: [
		{
			label: "Ryu Sites",
			path: "/docs/standalone/sites",
			description:
				"Operator setup, visitor access, domains, and deploy checks.",
		},
		{
			label: "Sites SDK quickstart",
			path: "/docs/standalone/sdk/sites",
			description: "Create, save, and deploy a first Site.",
		},
		{
			label: "Sites API",
			path: "/docs/standalone/sites-api",
			description: "Management and visitor routes, errors, and limits.",
		},
	],
};
