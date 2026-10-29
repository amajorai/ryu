// packages/services/src/sites/client.ts
//
// The Ryu Sites management thin client: the standalone process's
// `/api/sites/*` contract on its management listener (`RYU_SITES_PORT`),
// authenticated with the standalone bearer (`RYU_SITES_API_TOKEN` on the
// server, `RYU_SITES_API_KEY` in the SDK). Visitor routes (deployed pages,
// `/_ryu/*` and each Site's `/mcp`) are on the separate visitor listener and
// are not part of this client.
//
// Every change carries the revision it read as `expectedRevision`; a stale
// one answers `409 conflict`. Errors are `{ error: { code, message, fields? } }`.
// Sites deduplicates no write, so no request carries an `Idempotency-Key` and
// no POST is retried on a network error or 5xx. A PUT or DELETE is replay-safe
// by method, but each carries `expectedRevision`, which the first attempt moves
// when it commits, so SITES_ROUTES lists them as `nonReplaySafe`: they are sent
// once after a network error, timeout or 5xx (a replay would answer a spurious
// `409 conflict`), and only a `429` with a wait is retried. A 409 is never
// retried, and neither is Sites' `503 unavailable`, which reports a
// configuration state (identity, AI, Space retrieval or agent execution not
// connected) that only the operator can change.

import type { RyuFetch } from "@ryuhq/client";
import { z } from "zod";
import { pathSegment, requestJson } from "../transport/request.ts";

/** Path prefix of the management contract. */
export const SITES_API_PREFIX = "/api/sites";

// --- Wire types ---------------------------------------------------------------

/** Who may open a Site. New Sites are `private`. */
export type SitesAudience = "private" | "invited" | "workspace" | "public";

/** A starter template for a new Site. */
export type SitesTemplate =
	| "website"
	| "help-center"
	| "dashboard"
	| "game"
	| "reset-calendar";

/** One Site tool a version exposes to agents over the Site's MCP server. */
export interface SitesTool {
	/** Which records collection the tool works on. Default `data`. */
	collection?: string;
	/** What the tool does, as agents see it. */
	description: string;
	/** The tool name: lowercase letters, digits and underscores. */
	name: string;
	/**
	 * What the tool runs: `records.list`, `records.set`, `records.delete` or
	 * `knowledge.search`.
	 */
	operation:
		| "records.list"
		| "records.set"
		| "records.delete"
		| "knowledge.search"
		| string;
	[field: string]: unknown;
}

/**
 * The Site tools saved with a version (the Site's `extensions` setting when it
 * was saved). Sites stores every field; a version from before Site tools has no
 * `extensions` at all. The fields are optional only so an unexpected reply
 * still decodes.
 */
export interface SitesExtensions {
	/** Owner connector binding ids the Site may call. */
	connections?: string[];
	/** Whether the Site serves an MCP server. */
	mcp?: boolean;
	/** The Site's tools. */
	tools?: SitesTool[];
	/** Whether the Site's MCP server offers the Site as a UI view. */
	ui?: boolean;
	[field: string]: unknown;
}

/** One saved, immutable HTML version. */
export interface SitesVersion {
	/** The saved HTML's size in bytes. */
	bytes: number;
	/** The git commit SHA recorded with the version, or null. */
	commit: string | null;
	/** When the version was saved. */
	createdAt: string;
	/**
	 * The Site tools saved with the version (the Site's `extensions` setting when
	 * it was saved). Absent on versions saved before Site tools existed.
	 */
	extensions?: SitesExtensions;
	/** The version id. */
	id: string;
	/** The note saved with the version. */
	message: string;
	[field: string]: unknown;
}

/** Who may add shared records, when shared data is on. */
export interface SitesSharedData {
	enabled: boolean;
	write: "signed-in" | "editors";
}

/**
 * A Site's settings as `PUT /api/sites/projects/{id}/settings` takes them
 * (the Sites satellite's `siteSettings`). The route replaces every setting,
 * so `projects.updateSettings()` reads the current ones and changes only the
 * fields you pass.
 */
export interface SitesSettings {
	/** Owner reset checks; only for the `reset-calendar` starter. */
	agentActions: boolean;
	/** AI answers on the Site. */
	ai: boolean;
	/** General AI calls without visitor sign-in. */
	aiAnonymous: boolean;
	/**
	 * AI calls the Site may make per day.
	 *
	 * 1 to 1000.
	 */
	aiDailyLimit: number;
	/**
	 * `grounded` answers only from the bound Space; `general` also lets the page
	 * call the model.
	 */
	aiMode: "grounded" | "general";
	/**
	 * Owner instructions; returned empty to editors and viewers.
	 *
	 * Up to 4,000 characters.
	 */
	aiSystemPrompt: string;
	/** Lets anyone who may visit start a private copy of the deployed version. */
	allowRemix: boolean;
	/**
	 * Who may open the Site. `public` needs the operator to allow public Sites
	 * (`publicEnabled` in the status).
	 */
	audience: SitesAudience;
	/**
	 * Managed by the database routes; send it unchanged.
	 *
	 * `updateSettings()` never changes it.
	 */
	database: { databaseId: string; spaceId: string } | null;
	/**
	 * Editor emails.
	 *
	 * Up to 30.
	 */
	editors: string[];
	/**
	 * Managed by the extensions routes; send it unchanged.
	 *
	 * `updateSettings()` never changes it.
	 */
	extensions: Record<string, unknown>;
	/** The data runtime: `local`, or `connected` to Ryu. */
	mode: "local" | "connected";
	/** Offer visitors an optional sign-in. */
	optionalSignIn: boolean;
	/**
	 * Records every permitted visitor reads together; needs a database and the
	 * connected runtime.
	 */
	sharedData: SitesSharedData;
	/** The knowledge Space grounded AI answers from. */
	spaceId: string | null;
	/** Durable records; needs a connected database. */
	storage: boolean;
	/** Visitor file uploads. */
	uploads: boolean;
	/**
	 * Invited viewer emails, for `invited`.
	 *
	 * Up to 100.
	 */
	viewers: string[];
	/**
	 * The workspace whose members may visit, for `workspace`; one you belong to.
	 */
	workspaceId: string | null;
	[field: string]: unknown;
}

/**
 * The named settings of {@link SitesSettings}, without its index signature.
 * `Omit` over a type with a `string` index signature keeps only the index
 * signature (its `keyof` is `string | number`), so the patch type is built
 * from these keys instead.
 */
type KnownSitesSettings = {
	[K in keyof SitesSettings as string extends K
		? never
		: number extends K
			? never
			: K]: SitesSettings[K];
};

/** The settings `projects.updateSettings()` may change (all but `database` and `extensions`). */
export type SitesSettingsPatch = Partial<
	Omit<KnownSitesSettings, "database" | "extensions">
> & {
	database?: never;
	extensions?: never;
};

/** A custom domain's state: waiting for DNS, waiting for TLS, serving, or failed. */
export type SitesDomainStatus =
	| "pending_dns"
	| "pending_tls"
	| "active"
	| "failed";

/** One custom domain bound to a Site. */
export interface SitesDomainBinding {
	/** When the binding was last checked, or null before the first check. */
	checkedAt: string | null;
	/** The custom host name. */
	host: string;
	/**
	 * The binding's state: `pending_dns`, `pending_tls`, `active` or `failed`.
	 */
	status: SitesDomainStatus | string;
	/** The DNS verification value to publish for the host. */
	verification: string;
	[field: string]: unknown;
}

/** One owner-managed connector binding visitors may use. */
export interface SitesConnection {
	/** The agent the tool runs under. */
	agentId: string;
	/** What the binding is for, as visitors see it. */
	description: string;
	/** The binding id. */
	id: string;
	/** The binding's name, as visitors see it. */
	label: string;
	/** Whether the binding only reads. */
	readOnly: boolean;
	/** Increases with every material change; a new revision asks visitors to consent again. */
	revision: number;
	/** The Ryu tool the binding runs. */
	toolId: string;
	/** When the binding last changed. */
	updatedAt: string;
	/** Who last changed the binding. */
	updatedBy: string;
	[field: string]: unknown;
}

/** The Site and version a Site was remixed or duplicated from. */
export interface SitesRemixSource {
	/** The source Site's name when the copy was made. */
	name: string;
	/** The source Site's id. */
	siteId: string;
	/** The source version the copy was made from. */
	versionId: string;
	[field: string]: unknown;
}

/** A Site (project) as the management API returns it. */
export interface SitesProject {
	/** What the caller may do with the Site: `owner`, `editor` or `viewer`. */
	access?: "owner" | "editor" | "viewer";
	/** Earlier URL names that redirect here. */
	aliases: string[];
	/**
	 * Owner-managed connector bindings visitors may use.
	 *
	 * Sites fills it (empty when there are none); it is typed optional so an
	 * older reply still decodes.
	 */
	connections?: SitesConnection[];
	/** When the Site was created. */
	createdAt: string;
	/** The deployed version, or null while unpublished. */
	deploymentId: string | null;
	/**
	 * Custom domain bindings: each `host`, its `status` (`pending_dns`,
	 * `pending_tls`, `active` or `failed`), its DNS `verification` value and when
	 * it was last checked.
	 */
	domains: SitesDomainBinding[];
	/** True once any version has been deployed. */
	hasPublished: boolean;
	/** The Site id. */
	id: string;
	/** The Site's display name. */
	name: string;
	/** The user who owns the Site. */
	ownerId: string;
	/** The Site brief. */
	prompt: string;
	/**
	 * The Site and version this one was remixed or duplicated from. Sites sets it
	 * only on a remix or duplicate; on any other Site the key is absent.
	 *
	 * It is typed nullable as well so a `null` still decodes.
	 */
	remixedFrom?: SitesRemixSource | null;
	/**
	 * Increases with every change; send it as `expectedRevision` so a stale
	 * change is refused with `conflict`.
	 */
	revision: number;
	/**
	 * The stored record's format version; always 1.
	 *
	 * Typed as a number so a record from a newer server still decodes.
	 */
	schemaVersion?: number;
	/**
	 * The Site's settings. Owner-only settings, such as the AI instructions, are
	 * blank for editors and viewers.
	 */
	settings: SitesSettings;
	/**
	 * The Site's URL name.
	 *
	 * The Site answers at `<slug>.<domain>`.
	 */
	slug: string;
	/** The template the Site started from. */
	template: SitesTemplate;
	/** When the Site last changed. */
	updatedAt: string;
	/** Saved versions. */
	versions: SitesVersion[];
	[field: string]: unknown;
}

/**
 * `GET /api/sites/status`.
 *
 * The `*Available` flags say which runtime services the host wired in: check
 * `identityAvailable` before relying on signed-in visitors, `domainsAvailable`
 * before adding a custom domain (without an edge readiness check a verified
 * domain stays `pending_tls`), and so on. They are optional because a server
 * older than the flag leaves it out; treat a missing flag as `false`.
 */
export interface SitesStatus {
	agentAvailable?: boolean;
	answersAvailable?: boolean;
	/** Always `v1`. */
	apiVersion: string;
	/**
	 * The visitor domain suffix; a Site answers at `<slug>.<baseDomain>`.
	 *
	 * `localhost` by default.
	 */
	baseDomain: string;
	completionsAvailable?: boolean;
	connectionsAvailable?: boolean;
	databaseAvailable?: boolean;
	domainsAvailable?: boolean;
	identityAvailable?: boolean;
	/**
	 * This runtime's limits, by name, such as `projects`, `versions`,
	 * `totalArtifactBytes`, `records`, `files`, `fileBytes` and their per-visitor
	 * shares. Names ending in `Bytes` are sizes in bytes; names ending in
	 * `Percent` are percentages; names ending in `PerMinute` or `PerDay` are
	 * rates per minute or per UTC day, and `connectionCallsPerVisitor` is also
	 * per UTC day. Other names are counts. Read the values here rather than
	 * hard-coding them.
	 */
	limits: Record<string, number>;
	mcpAvailable?: boolean;
	mcpUiAvailable?: boolean;
	/**
	 * `standalone`: the Sites service runs on its own. `core`: it runs as a Ryu
	 * Core app sidecar.
	 */
	mode: "standalone" | "core";
	ownerConnectionsAvailable?: boolean;
	pluginInstallAvailable?: boolean;
	/**
	 * Whether the operator allows the public audience (`RYU_SITES_PUBLIC=1`, or
	 * the runtime config's `publicEnabled` when that variable is unset).
	 */
	publicEnabled: boolean;
	retrievalAvailable?: boolean;
	scannerAvailable?: boolean;
	/**
	 * Whether the Sites store's sealed content is readable: the `store`, its
	 * `state`, the `sealing` health (`ok`, `waiting for a Ryu update`,
	 * `key mismatch`, `no key` or `unmanaged`), how many rows are
	 * `unreadableRows`, and whether a `vacuumPending`.
	 */
	sealing?: {
		sealing: string;
		state: string;
		store: string;
		unreadableRows: number;
		vacuumPending: boolean;
	};
	/**
	 * The port the visitor listener serves Sites on; a `localhost` base domain
	 * serves `http://<slug>.localhost:<visitorPort>/`.
	 */
	visitorPort: number;
	[field: string]: unknown;
}

/** `projects.list()` filter. */
export interface SitesProjectListQuery {
	/** `owned` (default) or `shared`. */
	scope?: "owned" | "shared";
}

/** `projects.create()` input. */
export interface SitesCreateProjectInput {
	/** The Site's display name. */
	name: string;
	/** What the Site is for, stored as the Site brief. */
	prompt?: string;
	/** URL name: 5-48 lowercase letters, digits and single hyphens, starting with a letter. */
	slug: string;
	/**
	 * The starting template.
	 *
	 * Default `website`.
	 */
	template?: SitesTemplate;
}

/** `projects.delete()` input: the revision you read and the URL name, typed to confirm. */
export interface SitesDeleteProjectInput {
	/** The `revision` you last read. A stale value answers `409 conflict`. */
	expectedRevision: number;
	/** The Site's URL name, typed to confirm. */
	slug: string;
}

/** `versions.create()` input. */
export interface SitesCreateVersionInput {
	/**
	 * A 40-character git commit SHA to record with the version, or null.
	 *
	 * Set it when the HTML came from a commit.
	 */
	commit?: string | null;
	/** The `revision` you last read. A stale value answers `409 conflict`. */
	expectedRevision: number;
	/**
	 * A complete, self-contained document beginning with `<!doctype html>`.
	 *
	 * Up to 2 MB.
	 */
	html: string;
	/**
	 * A note about what changed.
	 *
	 * Default `Saved version`.
	 */
	message?: string;
}

/** The body of `PUT /api/sites/projects/{id}/settings`: every setting, and the revision you read. */
export interface SitesSettingsBody {
	expectedRevision: number;
	settings: SitesSettings;
}

/** Deploy one already saved version. */
export interface SitesDeployVersionBody {
	expectedRevision: number;
	versionId: string;
}

// --- Decoders -----------------------------------------------------------------

const versionSchema = z.looseObject({
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

/** Validates one Site record. */
export const sitesProjectSchema = z.looseObject({
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
	template: z.enum([
		"website",
		"help-center",
		"dashboard",
		"game",
		"reset-calendar",
	]),
	updatedAt: z.string(),
	versions: z.array(versionSchema),
});

/** Validates `GET /api/sites/projects`. */
export const sitesProjectListSchema = z.array(sitesProjectSchema);

/** Validates `GET /api/sites/status`. */
export const sitesStatusSchema = z.looseObject({
	apiVersion: z.string(),
	baseDomain: z.string(),
	limits: z.record(z.string(), z.number()),
	mode: z.enum(["standalone", "core"]),
	publicEnabled: z.boolean(),
	visitorPort: z.number(),
});

/** Validates `DELETE /api/sites/projects/{id}`. */
export const sitesDeletedSchema = z.looseObject({ deleted: z.boolean() });

// --- Client -------------------------------------------------------------------

/** The Sites connection one call uses. */
export interface SitesClientConfig {
	/** The standalone management bearer. */
	apiKey: string;
	baseUrl: string;
}

/** The Sites management calls; each makes exactly one request. */
export interface SitesClient {
	createProject(input: SitesCreateProjectInput): Promise<SitesProject>;
	createVersion(
		projectId: string,
		input: SitesCreateVersionInput
	): Promise<SitesProject>;
	deleteProject(
		projectId: string,
		input: SitesDeleteProjectInput
	): Promise<{ deleted: boolean }>;
	deployVersion(
		projectId: string,
		input: SitesDeployVersionBody
	): Promise<SitesProject>;
	getProject(projectId: string): Promise<SitesProject>;
	listProjects(query?: SitesProjectListQuery): Promise<SitesProject[]>;
	status(): Promise<SitesStatus>;
	unpublish(
		projectId: string,
		input: { expectedRevision: number }
	): Promise<SitesProject>;
	/** `PUT /api/sites/projects/{id}/settings`: replaces every setting. */
	updateSettings(
		projectId: string,
		input: SitesSettingsBody
	): Promise<SitesProject>;
}

function projectPath(projectId: string, action = ""): string {
	return `${SITES_API_PREFIX}/projects/${pathSegment("sites", projectId, "the project id")}${
		action ? `/${action}` : ""
	}`;
}

const decodeProject = (value: unknown) =>
	sitesProjectSchema.parse(value) as SitesProject;

/**
 * The URL a Site answers at, built the way the Sites service builds it: a
 * `localhost` domain serves `http://<slug>.localhost:<visitorPort>/`, any
 * other domain `https://<slug>.<domain>/` behind the operator's edge.
 */
export function siteUrl(
	slug: string,
	status: Pick<SitesStatus, "baseDomain" | "visitorPort">
): string {
	return status.baseDomain === "localhost"
		? `http://${slug}.localhost:${status.visitorPort}/`
		: `https://${slug}.${status.baseDomain}/`;
}

/** Builds the Sites client over `fetch` (the call's service-scoped fetch). Does no I/O. */
export function createSitesClient(
	config: SitesClientConfig,
	fetch: RyuFetch,
	signal?: AbortSignal
): SitesClient {
	const headers = { authorization: `Bearer ${config.apiKey}` };
	return {
		createProject: (input) =>
			requestJson(fetch, config.baseUrl, {
				body: {
					name: input.name,
					prompt: input.prompt,
					slug: input.slug,
					template: input.template,
				},
				decode: decodeProject,
				headers,
				method: "POST",
				path: `${SITES_API_PREFIX}/projects`,
				signal,
			}),
		createVersion: (projectId, input) =>
			requestJson(fetch, config.baseUrl, {
				body: {
					commit: input.commit,
					expectedRevision: input.expectedRevision,
					html: input.html,
					message: input.message,
				},
				decode: decodeProject,
				headers,
				method: "POST",
				path: projectPath(projectId, "versions"),
				signal,
			}),
		deleteProject: (projectId, input) =>
			requestJson(fetch, config.baseUrl, {
				body: { expectedRevision: input.expectedRevision, slug: input.slug },
				decode: (value) =>
					sitesDeletedSchema.parse(value) as { deleted: boolean },
				headers,
				method: "DELETE",
				path: projectPath(projectId),
				signal,
			}),
		deployVersion: (projectId, input) =>
			requestJson(fetch, config.baseUrl, {
				body: {
					expectedRevision: input.expectedRevision,
					versionId: input.versionId,
				},
				decode: decodeProject,
				headers,
				method: "POST",
				path: projectPath(projectId, "deploy"),
				signal,
			}),
		getProject: (projectId) =>
			requestJson(fetch, config.baseUrl, {
				decode: decodeProject,
				headers,
				method: "GET",
				path: projectPath(projectId),
				signal,
			}),
		listProjects: (query = {}) =>
			requestJson(fetch, config.baseUrl, {
				decode: (value) =>
					sitesProjectListSchema.parse(value) as SitesProject[],
				headers,
				method: "GET",
				path: `${SITES_API_PREFIX}/projects`,
				query: { scope: query.scope },
				signal,
			}),
		status: () =>
			requestJson(fetch, config.baseUrl, {
				decode: (value) => sitesStatusSchema.parse(value) as SitesStatus,
				headers,
				method: "GET",
				path: `${SITES_API_PREFIX}/status`,
				signal,
			}),
		unpublish: (projectId, input) =>
			requestJson(fetch, config.baseUrl, {
				body: { expectedRevision: input.expectedRevision },
				decode: decodeProject,
				headers,
				method: "POST",
				path: projectPath(projectId, "unpublish"),
				signal,
			}),
		updateSettings: (projectId, input) =>
			requestJson(fetch, config.baseUrl, {
				body: {
					expectedRevision: input.expectedRevision,
					settings: input.settings,
				},
				decode: decodeProject,
				headers,
				method: "PUT",
				path: projectPath(projectId, "settings"),
				signal,
			}),
	};
}
