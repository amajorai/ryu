// packages/services/src/sites/namespace.ts
//
// `ryu.sites`: the Ryu Sites management thin client (design §2.4).
//
//   ryu.sites.status()
//   ryu.sites.projects.list({ scope }) / get(id) / create({ name, slug }) / delete(id, { expectedRevision, slug })
//   ryu.sites.projects.updateSettings(id, { audience, ... }, { expectedRevision? }) / makePublic(id, { expectedRevision? })
//   ryu.sites.versions.create(projectId, { html, expectedRevision })
//   ryu.sites.deploy({ projectId, html, message })   -> { project, version, url }
//   ryu.sites.deploy({ projectId, versionId })
//   ryu.sites.unpublish(projectId, { expectedRevision? })
//
// Bearer `RYU_SITES_API_KEY` (the standalone `RYU_SITES_API_TOKEN`), no
// default URL: point `RYU_SITES_URL` at the management listener. A stale
// `expectedRevision` answers `409 conflict` (RyuConflictError), never retried.

import type { RyuFetch } from "@ryuhq/client";
import type { ResolvedServiceConfig } from "../config.ts";
import { copyRyuError, type RyuError } from "../errors.ts";
import type { CallOptions } from "../transport/fetch-shim.ts";
import type { NamespaceDefinition } from "../wrap.ts";
import {
	createSitesClient,
	type SitesCreateProjectInput,
	type SitesCreateVersionInput,
	type SitesDeleteProjectInput,
	type SitesProject,
	type SitesProjectListQuery,
	type SitesSettingsPatch,
	type SitesStatus,
} from "./client.ts";
import {
	deploySite,
	isPublicDisabledError,
	SITES_PUBLIC_DISABLED_HINT,
	type SitesDeployInput,
	type SitesDeployResult,
	unpublishSite,
	updateSiteSettings,
} from "./helpers.ts";
import { SITES_ROUTES } from "./routes.ts";

export type {
	SitesAudience,
	SitesConnection,
	SitesCreateProjectInput,
	SitesCreateVersionInput,
	SitesDeleteProjectInput,
	SitesDomainBinding,
	SitesDomainStatus,
	SitesExtensions,
	SitesProject,
	SitesProjectListQuery,
	SitesRemixSource,
	SitesSettings,
	SitesSettingsPatch,
	SitesSharedData,
	SitesStatus,
	SitesTemplate,
	SitesTool,
	SitesVersion,
} from "./client.ts";
export type {
	SitesDeployHtmlInput,
	SitesDeployInput,
	SitesDeployResult,
	SitesDeployStep,
	SitesDeployVersionInput,
	SitesSettingsStep,
} from "./helpers.ts";

/** The methods of `ryu.sites`. */
export interface SitesNamespace {
	/**
	 * Publishes a Site. With `html`: reads the Site's revision, saves the HTML
	 * as a version with `expectedRevision`, then deploys that version. With
	 * `versionId`: deploys a saved version. Resolves to `{ project, version, url }`.
	 * A first deploy keeps the Site private.
	 */
	deploy(input: SitesDeployInput): Promise<SitesDeployResult>;
	readonly projects: {
		/** `POST /api/sites/projects`: a new private Site (201). */
		create(input: SitesCreateProjectInput): Promise<SitesProject>;
		/** `DELETE /api/sites/projects/{id}`: deletes the Site; `slug` confirms it. */
		delete(
			projectId: string,
			input: SitesDeleteProjectInput
		): Promise<{ deleted: boolean }>;
		/** `GET /api/sites/projects/{id}`. */
		get(projectId: string): Promise<SitesProject>;
		/** `GET /api/sites/projects`: owned Sites by default. */
		list(query?: SitesProjectListQuery): Promise<SitesProject[]>;
		/**
		 * Opens the Site to everyone: `updateSettings(projectId, { audience: "public" })`.
		 * Sites refuses it with `403 policy_denied` unless the operator allows
		 * public Sites (`RYU_SITES_PUBLIC=1` or the runtime config's
		 * `publicEnabled`); `status().publicEnabled` says whether it does.
		 */
		makePublic(
			projectId: string,
			options?: { expectedRevision?: number }
		): Promise<SitesProject>;
		/**
		 * `PUT /api/sites/projects/{id}/settings`: changes only the settings in
		 * `patch`. The route replaces every setting, so the SDK reads the Site
		 * first and sends its current settings with your changes laid over them,
		 * with `expectedRevision` (the revision it read, unless you pin one). A
		 * stale revision is `409 conflict`; the failed step is in
		 * `error.details.step` (`read` or `settings`).
		 */
		updateSettings(
			projectId: string,
			patch: SitesSettingsPatch,
			options?: { expectedRevision?: number }
		): Promise<SitesProject>;
	};
	/** `GET /api/sites/status`: mode, limits, visitor domain and port. */
	status(): Promise<SitesStatus>;
	/**
	 * `POST /api/sites/projects/{id}/unpublish`: takes the Site offline and
	 * keeps its versions. Reads the current revision first when
	 * `expectedRevision` is omitted.
	 */
	unpublish(
		projectId: string,
		options?: { expectedRevision?: number }
	): Promise<SitesProject>;
	readonly versions: {
		/** `POST /api/sites/projects/{id}/versions`: saves HTML; visitors see nothing new until a deploy. */
		create(
			projectId: string,
			input: SitesCreateVersionInput
		): Promise<SitesProject>;
	};
}

/** Builds the Sites client for one call. Does no I/O. */
export function createSitesNamespace(
	config: ResolvedServiceConfig,
	fetch: RyuFetch,
	options: CallOptions = {}
): SitesNamespace {
	const client = createSitesClient(
		{ apiKey: config.apiKey ?? "", baseUrl: config.baseUrl },
		fetch,
		options.signal
	);
	return {
		deploy: (input) => deploySite(client, input),
		projects: {
			create: (input) => client.createProject(input),
			delete: (projectId, input) => client.deleteProject(projectId, input),
			get: (projectId) => client.getProject(projectId),
			list: (query) => client.listProjects(query),
			makePublic: (projectId, settingsOptions) =>
				updateSiteSettings(
					client,
					projectId,
					{ audience: "public" },
					settingsOptions
				),
			updateSettings: (projectId, patch, settingsOptions) =>
				updateSiteSettings(client, projectId, patch, settingsOptions),
		},
		status: () => client.status(),
		unpublish: (projectId, unpublishOptions) =>
			unpublishSite(client, projectId, unpublishOptions),
		versions: {
			create: (projectId, input) => client.createVersion(projectId, input),
		},
	};
}

/**
 * What the Sites visitor listener answers for a host with no deployed Site.
 * The management listener never sends it, so a management call that gets it
 * went to the wrong port.
 */
const VISITOR_NOT_DEPLOYED = "Site is not deployed";

/** The hint a management call gets when `RYU_SITES_URL` is the visitor listener. */
export const SITES_VISITOR_LISTENER_HINT =
	"RYU_SITES_URL looks like the Sites visitor listener (RYU_SITES_VISITOR_PORT, 8022 by default), which serves deployed pages. Point it at the management listener (RYU_SITES_PORT, 8021 by default) instead.";

/**
 * Sites answers `503 unavailable` only for configuration states (platform
 * identity, Space retrieval, a Ryu model or agent execution not connected),
 * which a retry cannot change, so the transport does not replay it.
 */
export function refineSitesError(error: RyuError): RyuError {
	if (error.status === 503 && error.code === "unavailable" && error.retryable) {
		return copyRyuError(error, { retryable: false });
	}
	return error;
}

/**
 * Adds {@link SITES_VISITOR_LISTENER_HINT} to the visitor listener's 404 on a
 * management call, and {@link SITES_PUBLIC_DISABLED_HINT} to the settings
 * route's refusal of the public audience.
 */
export function decorateSitesError(error: RyuError): RyuError {
	if (
		error.service === "sites" &&
		error.hint === null &&
		isPublicDisabledError(error)
	) {
		return copyRyuError(error, { hint: SITES_PUBLIC_DISABLED_HINT });
	}
	if (
		error.service !== "sites" ||
		error.hint !== null ||
		error.status !== 404 ||
		error.message.trim() !== VISITOR_NOT_DEPLOYED
	) {
		return error;
	}
	return copyRyuError(error, { hint: SITES_VISITOR_LISTENER_HINT });
}

/** How the facade wraps Sites. */
export const SITES_NAMESPACE: NamespaceDefinition<SitesNamespace> = {
	create: createSitesNamespace,
	decorateError: decorateSitesError,
	errors: "throw",
	refineError: refineSitesError,
	routes: SITES_ROUTES,
	service: "sites",
};
