// packages/services-cli/src/commands/sites.ts
//
// `ryu-services sites …`: Ryu Sites commands, against a standalone Sites
// process's management listener.
//
//   status
//   list [--scope owned|shared]
//   get <id|slug>
//   create --name N --slug S [--template T] [--prompt P]
//   deploy <file.html> --project <id|slug> [--message M] [--expected-revision N]
//   settings <id|slug> [--audience A] [--viewer EMAIL ... | --no-viewers]
//            [--workspace ID | --no-workspace] [--allow-remix on|off]
//            [--optional-sign-in on|off] [--expected-revision N]
//
// Configuration comes from RYU_SITES_URL and RYU_SITES_API_KEY (the
// standalone management bearer), or --base-url / --api-key. `create` makes a
// private Site and prints it (its `id` is what `deploy --project` takes).
// `deploy` reads the Site's revision, saves the file as a new version, then
// deploys it, and prints `{ project, version, url }`. A first deploy keeps
// the Site private. `get` and `deploy --project` also take the Site's URL
// name: when the id lookup answers 404, the Sites you own and the ones shared
// with you are searched for that slug and the call is repeated with its id.
// `settings` changes only the settings it names (the SDK's
// `projects.updateSettings()` reads the rest) and prints the Site. Like the
// `sites_update_settings` MCP tool it never changes editors, who can replace
// what the Site serves; only the SDK's `updateSettings({ editors })` does.

import type {
	SitesAudience,
	SitesProject,
	SitesSettingsPatch,
	SitesTemplate,
} from "@ryuhq/services";
import { isRyuError } from "@ryuhq/services";
import {
	booleanFlag,
	CliUsageError,
	countFlag,
	requireStringFlag,
	stringFlag,
	stringsFlag,
} from "../args.ts";
import { listPage } from "../list-output.ts";
import type { CommandContext, ServiceCommand } from "../registry.ts";
import { settled } from "../settled.ts";

const SCOPES = ["owned", "shared"] as const;
type Scope = (typeof SCOPES)[number];

/** The starter templates `create --template` accepts (the Sites API's list). */
export const SITES_TEMPLATES: readonly SitesTemplate[] = [
	"website",
	"help-center",
	"dashboard",
	"game",
	"reset-calendar",
];

/** A Site URL name: 5-48 lowercase letters, digits and single hyphens, starting with a letter. */
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SLUG_MIN = 5;
const SLUG_MAX = 48;

/** The deploy steps a slug can explain (the Site lookup), not the later ones. */
const LOOKUP_STEPS = new Set([undefined, "read", "version"]);

/** A UUID, the shape Site ids take: never a slug, so never looked up as one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Whether `value` could be a slug: the Sites slug rules, and not a UUID. */
function couldBeSlug(value: string): boolean {
	return (
		SLUG.test(value) &&
		value.length >= SLUG_MIN &&
		value.length <= SLUG_MAX &&
		!UUID.test(value)
	);
}

/** Whether `error` is a 404 for the Site itself (not a later deploy step's). */
export function isSiteNotFound(error: unknown): boolean {
	if (!isRyuError(error) || error.status !== 404) {
		return false;
	}
	const step =
		typeof error.details === "object" && error.details !== null
			? (error.details as { step?: unknown }).step
			: undefined;
	return LOOKUP_STEPS.has(typeof step === "string" ? step : undefined);
}

/** The id of the Site whose slug is `value` (owned first, then shared), or null. */
async function idForSlug(
	ctx: CommandContext,
	value: string
): Promise<string | null> {
	if (!couldBeSlug(value)) {
		return null;
	}
	const find = (projects: readonly SitesProject[]) =>
		projects.find((project) => project.slug === value && project.id !== value);
	const owned = find(await ctx.ryu.sites.projects.list({ scope: "owned" }));
	if (owned !== undefined) {
		return owned.id;
	}
	return (
		find(await ctx.ryu.sites.projects.list({ scope: "shared" }))?.id ?? null
	);
}

/**
 * Runs `call` with `value` as a Site id; when that answers 404 and `value`
 * is the slug of a Site you can see, runs it again with that Site's id. The
 * original 404 is rethrown when no Site has that slug or the lookup fails,
 * and a UUID is never looked up as a slug. A dry run prints the
 * first request only, so it never looks up a slug.
 */
async function withSiteId(
	ctx: CommandContext,
	value: string,
	call: (id: string) => PromiseLike<unknown>
): Promise<unknown> {
	try {
		return await settled(call(value));
	} catch (error) {
		if (ctx.dryRun || !isSiteNotFound(error)) {
			throw error;
		}
		let id: string | null;
		try {
			id = await idForSlug(ctx, value);
		} catch {
			// The lookup is a guess; its own failure (a wrong RYU_SITES_URL path
			// 404s every route) must not hide the Site lookup's error.
			throw error;
		}
		if (id === null) {
			throw error;
		}
		return settled(call(id));
	}
}

function rejectArgs(ctx: CommandContext): void {
	if (ctx.args.length > 0 || ctx.rest.length > 0) {
		throw new CliUsageError(
			`Unexpected argument ${JSON.stringify(ctx.args[0] ?? ctx.rest[0])}.`
		);
	}
}

function requireOne(ctx: CommandContext, name: string): string {
	const [value, ...extra] = ctx.args;
	if (value === undefined || value === "") {
		throw new CliUsageError(`<${name}> is required.`);
	}
	if (extra.length > 0 || ctx.rest.length > 0) {
		throw new CliUsageError(
			`Unexpected argument ${JSON.stringify(extra[0] ?? ctx.rest[0])}.`
		);
	}
	return value;
}

function scopeFlag(ctx: CommandContext): Scope | undefined {
	const value = stringFlag(ctx.flags, "scope");
	if (value === undefined) {
		return;
	}
	if (!SCOPES.includes(value as Scope)) {
		throw new CliUsageError(`--scope must be one of ${SCOPES.join(", ")}.`);
	}
	return value as Scope;
}

async function deploy(ctx: CommandContext): Promise<unknown> {
	const file = requireOne(ctx, "file");
	const projectId = requireStringFlag(ctx.flags, "project");
	const message = stringFlag(ctx.flags, "message");
	const expectedRevision = countFlag(ctx.flags, "expected-revision");
	let html: string;
	try {
		html = await ctx.io.readFile(file);
	} catch (error) {
		throw new CliUsageError(
			`Cannot read ${JSON.stringify(file)}: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (html.trim() === "") {
		throw new CliUsageError(`${JSON.stringify(file)} is empty.`);
	}
	return withSiteId(ctx, projectId, (id) =>
		ctx.ryu.sites.deploy({
			projectId: id,
			html,
			...(message === undefined ? {} : { message }),
			...(expectedRevision === undefined ? {} : { expectedRevision }),
		})
	);
}

function create(ctx: CommandContext): unknown {
	rejectArgs(ctx);
	const name = requireStringFlag(ctx.flags, "name");
	const slug = requireStringFlag(ctx.flags, "slug");
	if (!SLUG.test(slug) || slug.length < SLUG_MIN || slug.length > SLUG_MAX) {
		throw new CliUsageError(
			"--slug must be 5-48 lowercase letters, digits and single hyphens, starting with a letter (it becomes the Site's URL name)."
		);
	}
	const template = stringFlag(ctx.flags, "template");
	if (
		template !== undefined &&
		!SITES_TEMPLATES.includes(template as SitesTemplate)
	) {
		throw new CliUsageError(
			`--template must be one of ${SITES_TEMPLATES.join(", ")}.`
		);
	}
	const prompt = stringFlag(ctx.flags, "prompt");
	return ctx.ryu.sites.projects.create({
		name,
		slug,
		...(template === undefined ? {} : { template: template as SitesTemplate }),
		...(prompt === undefined ? {} : { prompt }),
	});
}

/** The audiences `settings --audience` accepts (the Sites API's list). */
export const SITES_AUDIENCES: readonly SitesAudience[] = [
	"private",
	"invited",
	"workspace",
	"public",
];

/** An `on|off` flag, or undefined when absent. */
function switchFlag(ctx: CommandContext, name: string): boolean | undefined {
	const value = stringFlag(ctx.flags, name);
	if (value === undefined) {
		return;
	}
	if (value !== "on" && value !== "off") {
		throw new CliUsageError(`--${name} must be on or off.`);
	}
	return value === "on";
}

/** The settings the flags name; a usage error when they name none. */
export function settingsPatch(ctx: CommandContext): SitesSettingsPatch {
	const patch: SitesSettingsPatch = {};
	const audience = stringFlag(ctx.flags, "audience");
	if (audience !== undefined) {
		if (!SITES_AUDIENCES.includes(audience as SitesAudience)) {
			throw new CliUsageError(
				`--audience must be one of ${SITES_AUDIENCES.join(", ")}.`
			);
		}
		patch.audience = audience as SitesAudience;
	}
	const viewers = stringsFlag(ctx.flags, "viewer");
	if (viewers.length > 0) {
		patch.viewers = [...viewers];
	}
	if (booleanFlag(ctx.flags, "no-viewers")) {
		if (viewers.length > 0) {
			throw new CliUsageError("Pass --viewer or --no-viewers, not both.");
		}
		patch.viewers = [];
	}
	const workspace = stringFlag(ctx.flags, "workspace");
	if (workspace !== undefined && workspace.trim() === "") {
		// Sites would store "" and match no workspace at all.
		throw new CliUsageError(
			"--workspace needs a workspace id; use --no-workspace to clear it."
		);
	}
	if (workspace !== undefined) {
		patch.workspaceId = workspace;
	}
	if (booleanFlag(ctx.flags, "no-workspace")) {
		if (workspace !== undefined) {
			throw new CliUsageError("Pass --workspace or --no-workspace, not both.");
		}
		patch.workspaceId = null;
	}
	const allowRemix = switchFlag(ctx, "allow-remix");
	if (allowRemix !== undefined) {
		patch.allowRemix = allowRemix;
	}
	const optionalSignIn = switchFlag(ctx, "optional-sign-in");
	if (optionalSignIn !== undefined) {
		patch.optionalSignIn = optionalSignIn;
	}
	if (Object.keys(patch).length === 0) {
		throw new CliUsageError(
			"Name at least one setting: --audience, --viewer, --no-viewers, --workspace, --no-workspace, --allow-remix or --optional-sign-in."
		);
	}
	return patch;
}

function settings(ctx: CommandContext): Promise<unknown> {
	const value = requireOne(ctx, "id");
	const patch = settingsPatch(ctx);
	const expectedRevision = countFlag(ctx.flags, "expected-revision");
	return withSiteId(ctx, value, (id) =>
		ctx.ryu.sites.projects.updateSettings(
			id,
			patch,
			expectedRevision === undefined ? {} : { expectedRevision }
		)
	);
}

/** Every `ryu-services sites` command. */
export const sitesCommands: readonly ServiceCommand[] = [
	{
		path: ["status"],
		summary: "Show the process mode, limits, visitor domain and port.",
		readOnly: true,
		run: (ctx) => {
			rejectArgs(ctx);
			return ctx.ryu.sites.status();
		},
	},
	{
		path: ["list"],
		summary: "List Sites (default: the ones you own), one JSON line each.",
		readOnly: true,
		flags: {
			scope: {
				type: "string",
				valueName: "owned|shared",
				description: "Which Sites to list (default owned).",
			},
		},
		run: (ctx) => {
			rejectArgs(ctx);
			const scope = scopeFlag(ctx);
			return listPage(
				ctx,
				ctx.ryu.sites.projects.list(scope === undefined ? {} : { scope }),
				{ noun: "Sites", items: (sites) => sites }
			);
		},
	},
	{
		path: ["get"],
		usage: "<id|slug>",
		summary:
			"Show one Site: revision, versions, deployment and audience. Takes its id or URL name.",
		readOnly: true,
		example: "ryu-services sites get launch-notes",
		run: (ctx) => {
			const value = requireOne(ctx, "id");
			return withSiteId(ctx, value, (id) => ctx.ryu.sites.projects.get(id));
		},
	},
	{
		path: ["create"],
		summary:
			"Create a private Site and print it; its id (or slug) is what deploy --project takes.",
		example:
			'ryu-services sites create --name "Launch notes" --slug launch-notes',
		flags: {
			name: {
				type: "string",
				valueName: "text",
				description: "The Site's display name (1-100 characters).",
				required: true,
			},
			slug: {
				type: "string",
				valueName: "slug",
				description:
					"The URL name: 5-48 lowercase letters, digits and single hyphens, starting with a letter.",
				required: true,
			},
			template: {
				type: "string",
				valueName: SITES_TEMPLATES.join("|"),
				description: "The starter template (default website).",
			},
			prompt: {
				type: "string",
				valueName: "text",
				description: "What the Site is for, stored as its brief.",
			},
		},
		run: create,
	},
	{
		path: ["deploy"],
		usage: "<file.html>",
		summary:
			"Save an HTML file as a new version of a Site and deploy it (prints the Site's URL).",
		effect:
			"Replaces what the Site serves at its URL. Who can visit is unchanged: a new Site stays private.",
		example:
			"ryu-services sites deploy ./index.html --project launch-notes --message First",
		flags: {
			project: {
				type: "string",
				valueName: "id|slug",
				description:
					"The Site to deploy to: its id or slug from sites list or sites create.",
				required: true,
			},
			message: {
				type: "string",
				valueName: "text",
				description: "The version message (default: Saved version).",
			},
			"expected-revision": {
				type: "number",
				valueName: "n",
				description:
					"Refuse with 409 unless the Site is still at this revision (default: read it first).",
			},
		},
		run: deploy,
	},
	{
		path: ["settings"],
		usage: "<id|slug>",
		summary:
			"Change who can visit a Site (audience, viewers, workspace) or its remix and sign-in options; other settings are kept.",
		effect:
			"Changes who can open the Site. public needs the operator to allow public Sites (RYU_SITES_PUBLIC=1 or the runtime config's publicEnabled; `sites status` shows publicEnabled), otherwise 403 policy_denied. invited, workspace and --optional-sign-in need the process's OpenID Connect sign-in (503 unavailable otherwise). Editors are not changed here.",
		example: "ryu-services sites settings launch-notes --audience public",
		flags: {
			audience: {
				type: "string",
				valueName: SITES_AUDIENCES.join("|"),
				description:
					"Who may open the Site: only you, the invited viewers, a workspace's members, or anyone.",
			},
			viewer: {
				type: "strings",
				valueName: "email",
				description:
					"An invited viewer, for --audience invited. Repeat it; the list replaces the current one.",
			},
			"no-viewers": {
				type: "boolean",
				description: "Clear the invited viewers.",
			},
			workspace: {
				type: "string",
				valueName: "id",
				description:
					"The workspace whose members may visit, for --audience workspace. You must belong to it (403 otherwise); a standalone process without Ryu Core gives the management caller no workspaces, so it refuses every id.",
			},
			"no-workspace": {
				type: "boolean",
				description: "Clear the workspace.",
			},
			"allow-remix": {
				type: "string",
				valueName: "on|off",
				description:
					"Let anyone who may visit start a private copy of the deployed version.",
			},
			"optional-sign-in": {
				type: "string",
				valueName: "on|off",
				description: "Offer visitors an optional sign-in.",
			},
			"expected-revision": {
				type: "number",
				valueName: "n",
				description:
					"Refuse with 409 unless the Site is still at this revision (default: read it first).",
			},
		},
		run: settings,
	},
];
