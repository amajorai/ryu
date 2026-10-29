// packages/services/src/tools/sites.ts
//
// Ryu Sites tools (`sites_*`): list, get, create and deploy, with the same
// names as the tools `ryu-sites mcp` serves, plus update_settings, but against
// a remote standalone Sites process's management listener.
//
// `sites_create` makes a private Site with a starter template, so an agent
// with only this server can get the `siteId` the other tools take. It never
// publishes anything; a second create with the same slug is refused.
//
// `sites_deploy` publishes: with `html` it saves a new version and deploys
// it, with `versionId` it deploys a saved one. It never widens access (a new
// Site stays private), and a stale `expectedRevision` fails with
// `409 conflict` instead of overwriting someone else's change.
// `expectedRevision` is required, as in `ryu-sites mcp`, so an agent must read
// the Site with `sites_get` before replacing what it serves; only the SDK and
// CLI read the revision for you. Hosts should ask before running it.
//
// `sites_update_settings` changes who can visit (audience, invited viewers,
// workspace, optional sign-in) and the remix opt-in: the fields
// `ryu-sites mcp`'s `sites_set_access` covers, plus sign-in and remix. It
// never takes `editors`, which would hand write and deploy rights over the
// Site to other people; only the SDK's `projects.updateSettings()` changes
// those. Like the SDK it keeps every other setting as it is, and like
// `sites_deploy` it requires the `expectedRevision` read with `sites_get`, so
// it is not idempotent: a repeat with the same revision answers 409. It is a
// write but not destructive (nothing served or stored is removed, and the
// previous settings can be set again), yet making a Site public widens
// access, so hosts should ask first.
//
// The CLI resolves a slug to its Site id; these tools do not (one call per
// tool, no hidden list requests). A 404 for a `siteId` that is shaped like a
// slug and not a UUID instead carries a hint naming the field, so an agent
// that passed the slug knows to read the id from `sites_list`.

import * as z from "zod";
import { READ } from "./annotations.ts";
import { createRyuError, isRyuError, messageWithoutHint } from "./core.ts";
import { toolOutput } from "./output.ts";
import { settled } from "./run.ts";
import { type AnyRyuTool, defineRyuTool } from "./types.ts";

const siteId = z
	.string()
	.min(1)
	.describe("The Site id from sites_list or sites_get, not its slug.");

/** Site ids are UUIDs; a UUID is never mistaken for a slug. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** The Sites slug rules (`sites_create`'s `slug`). */
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SLUG_MIN = 5;
const SLUG_MAX = 48;

/** Whether `value` could be a Site slug rather than an id. */
function couldBeSlug(value: string): boolean {
	return (
		SLUG.test(value) &&
		value.length >= SLUG_MIN &&
		value.length <= SLUG_MAX &&
		!UUID.test(value)
	);
}

/** The hint a 404 gets when `siteId` looks like a slug. */
export function siteIdSlugHint(value: string): string {
	return `siteId takes the Site id from sites_list or sites_get, not its slug. If ${JSON.stringify(value)} is a slug, find the Site with that slug in sites_list and pass its id.`;
}

/** The `details.step` of a Sites error (`sites.deploy()` and `updateSettings()` name it). */
function stepOf(error: { readonly details: unknown }): unknown {
	return typeof error.details === "object" && error.details !== null
		? (error.details as { step?: unknown }).step
		: undefined;
}

/**
 * `error` with the slug hint when it is a 404 without a hint, `value` looks
 * like a slug, and the failed request named the Site (not deploy's
 * `GET /api/sites/status`, whose 404 means a wrong RYU_SITES_URL).
 */
function withSlugHint(error: unknown, value: string): unknown {
	if (
		!isRyuError(error) ||
		error.status !== 404 ||
		error.hint !== null ||
		stepOf(error) === "status" ||
		!couldBeSlug(value)
	) {
		return error;
	}
	// `withRyuErrorFields` is not a root export (the tools reach the package
	// only through its root), so the copy is built here. A 404 `not_found`
	// maps back to the same subclass, as Python's copy keeps it.
	const { name: _name, ...fields } = error.toJSON();
	return createRyuError({
		...fields,
		message: messageWithoutHint(error),
		hint: siteIdSlugHint(value),
		cause: error.cause,
	});
}

/** Settles a call for Site `value`, adding the slug hint to its 404. */
async function siteCall(
	value: string,
	call: () => PromiseLike<unknown>
): Promise<unknown> {
	try {
		return await settled(call());
	} catch (error) {
		throw withSlugHint(error, value);
	}
}

const listInput = z.object({
	scope: z
		.enum(["owned", "shared", "all"])
		.default("all")
		.describe(
			"owned: Sites you own; shared: Sites shared with you; all: both."
		),
});

const deployInput = z
	.object({
		siteId,
		html: z
			.string()
			.min(1)
			.max(2_000_000)
			.optional()
			.describe(
				"A complete, self-contained HTML document beginning with <!doctype html> (inline CSS and JS only). Saved as a new version, then deployed. Give html or versionId."
			),
		message: z
			.string()
			.max(500)
			.optional()
			.describe("The version message, with html."),
		versionId: z
			.string()
			.min(1)
			.optional()
			.describe("A saved version to deploy instead of new html."),
		expectedRevision: z
			.int()
			.min(0)
			.describe(
				"The Site revision you last read from sites_get. Required: read the Site first. A stale revision is refused with 409 conflict; read the Site again before retrying."
			),
	})
	// One rule for every surface: a cross-field rule lives in the schema, so
	// breaking it is `invalid_arguments` with details.issues, like a type error.
	.refine(
		(input) => (input.html === undefined) !== (input.versionId === undefined),
		{
			message: "Give exactly one of html or versionId.",
			path: ["html"],
		}
	);

/** The starter templates the Sites API accepts. */
const SITE_TEMPLATES = [
	"website",
	"help-center",
	"dashboard",
	"game",
	"reset-calendar",
] as const;

const createInput = z.object({
	// Blank names are refused by the pattern rather than a zod `.trim()`, which
	// JSON Schema (and so the Python port's validator) cannot express; `run`
	// trims the value it sends.
	name: z
		.string()
		.min(1)
		.max(100)
		.regex(/\S/u, "name must not be blank.")
		.describe("The Site's display name."),
	slug: z
		.string()
		.min(5)
		.max(48)
		.regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)
		.describe(
			"URL name: 5-48 lowercase letters, digits and single hyphens, starting with a letter."
		),
	template: z
		.enum(SITE_TEMPLATES)
		.optional()
		.describe("The starter template (default website)."),
	description: z
		.string()
		.max(12_000)
		.optional()
		.describe("What the Site is for. Stored as the Site brief."),
});

/** A visitor email. Sites checks the full address; this only refuses non-addresses early. */
const email = z
	.string()
	.min(3)
	.max(254)
	// Explicit characters rather than `\s`, which the Python port's ASCII
	// regexes would read differently.
	.regex(/^[^@\t\n\r ]+@[^@\t\n\r ]+$/u, "Give an email address.");

/** The settings `sites_update_settings` can change, in the order its schema lists them. */
const SETTINGS_FIELDS = [
	"audience",
	"viewers",
	"workspaceId",
	"optionalSignIn",
	"allowRemix",
] as const;

const updateSettingsInput = z
	.object({
		siteId,
		audience: z
			.enum(["private", "invited", "workspace", "public"])
			.optional()
			.describe(
				"private: only the owner; invited: the viewers list, after signing in; workspace: members of workspaceId; public: anyone with the URL. public works only when the operator allows public Sites (RYU_SITES_PUBLIC=1 or the runtime config's publicEnabled, which the SDK's ryu.sites.status() reports), otherwise 403 policy_denied. invited and workspace need the process's OpenID Connect sign-in (503 unavailable otherwise)."
			),
		viewers: z
			.array(email)
			.max(100)
			.optional()
			.describe(
				"Invited viewer emails for audience invited (at most 100). Replaces the current list."
			),
		workspaceId: z
			.string()
			.min(1)
			.max(100)
			.nullable()
			.optional()
			.describe(
				"The workspace whose members may visit, for audience workspace; null clears it. You must belong to it (403 forbidden otherwise): a standalone Sites process without Ryu Core gives its management caller no workspaces, so it refuses every workspaceId."
			),
		optionalSignIn: z
			.boolean()
			.optional()
			.describe(
				"Offer visitors an optional sign-in. Needs the process's OpenID Connect sign-in (503 unavailable otherwise)."
			),
		allowRemix: z
			.boolean()
			.optional()
			.describe(
				"Let anyone who may visit start their own private copy of the deployed version."
			),
		expectedRevision: z
			.int()
			.min(0)
			.describe(
				"The Site revision you last read from sites_get. Required: read the Site first. A stale revision, including a repeat of a change that already applied, is refused with 409 conflict; read the Site again before retrying."
			),
	})
	.refine(
		(input) => SETTINGS_FIELDS.some((field) => input[field] !== undefined),
		{
			message: `Give at least one of ${SETTINGS_FIELDS.join(", ")}.`,
			path: ["audience"],
		}
	);

// Replies, mirroring the Sites decoders (sites/client.ts
// `sitesProjectSchema` and its version records); output.test.ts keeps them
// equal.

const versionData = z.looseObject({
	bytes: z.number(),
	commit: z.string().nullable(),
	createdAt: z.string(),
	extensions: z
		.looseObject({
			connections: z.array(z.string()).optional(),
			mcp: z.boolean().optional(),
			tools: z
				.array(
					z.looseObject({
						collection: z.string().optional(),
						description: z.string(),
						name: z.string(),
						operation: z.string(),
					})
				)
				.optional(),
			ui: z.boolean().optional(),
		})
		.optional(),
	id: z.string(),
	message: z.string(),
});

/** One Site, as every `sites_*` tool returns it. */
export const SITES_PROJECT_DATA = z.looseObject({
	access: z.enum(["owner", "editor", "viewer"]).optional(),
	aliases: z.array(z.string()),
	connections: z
		.array(
			z.looseObject({
				agentId: z.string(),
				description: z.string(),
				id: z.string(),
				label: z.string(),
				readOnly: z.boolean(),
				revision: z.number(),
				toolId: z.string(),
				updatedAt: z.string(),
				updatedBy: z.string(),
			})
		)
		.optional(),
	createdAt: z.string(),
	deploymentId: z.string().nullable(),
	domains: z.array(
		z.looseObject({
			checkedAt: z.string().nullable(),
			host: z.string(),
			status: z.string(),
			verification: z.string(),
		})
	),
	hasPublished: z.boolean(),
	id: z.string(),
	name: z.string(),
	ownerId: z.string(),
	prompt: z.string(),
	remixedFrom: z
		.looseObject({
			name: z.string(),
			siteId: z.string(),
			versionId: z.string(),
		})
		.nullable()
		.optional(),
	revision: z.number(),
	schemaVersion: z.number().optional(),
	settings: z.looseObject({
		audience: z.enum(["private", "invited", "workspace", "public"]),
	}),
	slug: z.string(),
	template: z.enum(SITE_TEMPLATES),
	updatedAt: z.string(),
	versions: z.array(versionData),
});

/** `sites_deploy` data: the Site after the deploy, the deployed version, and its URL. */
const deployData = z.looseObject({
	project: SITES_PROJECT_DATA,
	version: versionData
		.nullable()
		.describe(
			"The deployed version; null only when Sites left it out (the deploy still committed)."
		),
	url: z.string(),
});

type DeployInput = z.output<typeof deployInput>;

function deployBody(input: DeployInput) {
	const {
		siteId: projectId,
		html,
		message,
		versionId,
		expectedRevision,
	} = input;
	if (html !== undefined) {
		return {
			projectId,
			html,
			...(message === undefined ? {} : { message }),
			expectedRevision,
		};
	}
	return { projectId, versionId: versionId ?? "", expectedRevision };
}

/** The Ryu Sites tools. */
export const SITES_TOOLS: readonly AnyRyuTool[] = [
	defineRyuTool({
		service: "sites",
		name: "sites_list",
		title: "List Sites",
		description:
			"Lists Sites on the configured Sites process with their id, URL name, revision, audience, saved versions and deployed version.",
		inputSchema: listInput,
		annotations: READ,
		outputSchema: toolOutput(z.array(SITES_PROJECT_DATA)),
		run: async (ryu, { scope }) => {
			if (scope !== "all") {
				return settled(ryu.sites.projects.list({ scope }));
			}
			const [owned, shared] = await Promise.all([
				ryu.sites.projects.list({ scope: "owned" }),
				ryu.sites.projects.list({ scope: "shared" }),
			]);
			return [...owned, ...shared];
		},
	}),
	defineRyuTool({
		service: "sites",
		name: "sites_get",
		title: "Read a Site",
		description:
			"Reads one Site: settings (including its audience), saved versions, the deployed version and its revision. Read this before deploying.",
		inputSchema: z.object({ siteId }),
		annotations: READ,
		outputSchema: toolOutput(SITES_PROJECT_DATA),
		run: (ryu, { siteId: id }) =>
			siteCall(id, () => ryu.sites.projects.get(id)),
	}),
	defineRyuTool({
		service: "sites",
		name: "sites_create",
		title: "Create a Site",
		description:
			"Creates a private Site with a starter template (website, help-center, dashboard, game or reset-calendar) and returns it, with the id and revision sites_deploy takes. Nothing is published until you deploy. A slug already in use is refused with 409 conflict.",
		inputSchema: createInput,
		// A write that stays inside the Sites process: nothing is served or
		// sent, and a repeat with the same slug is refused rather than duplicated.
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		outputSchema: toolOutput(SITES_PROJECT_DATA),
		run: (ryu, { name, slug, template, description }) =>
			ryu.sites.projects.create({
				name: name.trim(),
				slug,
				...(template === undefined ? {} : { template }),
				...(description === undefined ? {} : { prompt: description }),
			}),
	}),
	defineRyuTool({
		service: "sites",
		name: "sites_deploy",
		title: "Deploy a Site",
		description:
			"Publishes a Site: with html, saves it as a new version and serves it; with versionId, serves a saved version. The version must pass the secret scan (422 security_blocked otherwise). Requires the expectedRevision you read with sites_get. Returns { project, version, url }. Never changes who can visit: a new Site stays private. Ask the user before deploying.",
		inputSchema: deployInput,
		// Destructive: it replaces the content an existing Site serves.
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		outputSchema: toolOutput(deployData),
		run: (ryu, input) =>
			siteCall(input.siteId, () => ryu.sites.deploy(deployBody(input))),
	}),
	defineRyuTool({
		service: "sites",
		name: "sites_update_settings",
		title: "Change who can visit a Site",
		description:
			"Changes a Site's audience (private, invited, workspace or public), its invited viewers, workspace, optional sign-in or remix opt-in, and keeps every other setting (editors are not changed here). Requires the expectedRevision you read with sites_get; a stale one, including a repeat after a change already applied, is 409 conflict, so read the Site again before retrying. public needs the operator to allow public Sites (403 policy_denied otherwise); invited, workspace and optional sign-in need the process's OpenID Connect sign-in (503 unavailable otherwise, not retryable). Returns the Site with its new revision. Ask the user before widening access, above all before making a Site public.",
		inputSchema: updateSettingsInput,
		// A write, not destructive: nothing served or stored is removed and the
		// previous settings can be set again. Not idempotent, like sites_deploy:
		// a repeat with the same expectedRevision answers 409 conflict.
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		outputSchema: toolOutput(SITES_PROJECT_DATA),
		run: (ryu, { siteId: projectId, expectedRevision, ...settings }) =>
			siteCall(projectId, () =>
				ryu.sites.projects.updateSettings(projectId, settings, {
					expectedRevision,
				})
			),
	}),
];
