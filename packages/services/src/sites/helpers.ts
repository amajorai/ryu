// packages/services/src/sites/helpers.ts
//
// `ryu.sites.deploy()`: publish HTML (or an already saved version) in one call.
//
// With `html`, it runs, in order, on the call's fetch shim:
//
//   1. GET  /api/sites/projects/{id}           -> the current `revision`
//   2. GET  /api/sites/status                  -> the visitor domain and port, for `url`
//   3. POST /api/sites/projects/{id}/versions  { html, message, expectedRevision }
//   4. POST /api/sites/projects/{id}/deploy    { versionId, expectedRevision }
//
// With `versionId`, step 3 is skipped (and step 1 too when `expectedRevision`
// is given). Status is read before any write, and nothing after the deploy
// POST can throw (a deployed version missing from the reply's `versions` comes
// back as the saved version, or `null`), so a failure after the deploy
// committed cannot turn a published Site into an apparent error.
//
// No step is retried after a `409 conflict` (someone changed the Site between
// the read and the write) or a `422 security_blocked` (the secret scan found
// something). Either error is a RyuError whose `details` names the step, the
// project and the revision sent, and, for a failed deploy, the saved
// `versionId`, so the caller can deploy that version later without saving it
// again. Deploying never widens access: a new Site is private until its
// audience is changed in the Sites settings.

import {
	copyRyuError,
	isRyuError,
	messageWithoutHint,
	type RyuError,
	RyuInvalidRequestError,
} from "../errors.ts";
import {
	type SitesClient,
	type SitesProject,
	type SitesSettings,
	type SitesSettingsPatch,
	type SitesStatus,
	type SitesVersion,
	siteUrl,
} from "./client.ts";

/** Publish new HTML: save it as a version, then deploy that version. */
export interface SitesDeployHtmlInput {
	/**
	 * Pin the revision you reviewed; the SDK reads the current one when it is
	 * omitted. A stale value fails with `409 conflict` before anything is saved.
	 */
	expectedRevision?: number;
	/** A complete, self-contained document beginning with `<!doctype html>`, up to 2 MB. */
	html: string;
	/** The version message. Default `Saved version` (the server's default). */
	message?: string;
	projectId: string;
}

/** Deploy a version that is already saved. */
export interface SitesDeployVersionInput {
	/** The revision you read; the SDK reads the current one when it is omitted. */
	expectedRevision?: number;
	projectId: string;
	versionId: string;
}

/** `sites.deploy()` input. */
export type SitesDeployInput = SitesDeployHtmlInput | SitesDeployVersionInput;

/** `sites.deploy()` result. */
export interface SitesDeployResult {
	/** The Site after the deploy (its new `revision`, `deploymentId`, audience). */
	project: SitesProject;
	/** Where the Site answers. A private Site opens only for its owner. */
	url: string;
	/**
	 * The deployed version, from the Site the deploy returned (or, with `html`,
	 * the version step's reply). `null` only when Sites left it out of both:
	 * the deploy still committed; read the Site to see it.
	 */
	version: SitesVersion | null;
}

/** Which step of `sites.deploy()` failed (in `error.details.step`). */
export type SitesDeployStep = "read" | "status" | "version" | "deploy";

/** Which step of `projects.updateSettings()` failed (in `error.details.step`). */
export type SitesSettingsStep = "read" | "settings";

function stepError(
	error: unknown,
	step: SitesDeployStep | SitesSettingsStep,
	context: Record<string, unknown>
): unknown {
	if (!isRyuError(error) || error.status === 0) {
		return error;
	}
	const existing =
		typeof error.details === "object" && error.details !== null
			? (error.details as Record<string, unknown>)
			: {};
	return copyRyuError(error, { details: { ...existing, ...context, step } });
}

async function runStep<T>(
	step: SitesDeployStep | SitesSettingsStep,
	context: Record<string, unknown>,
	run: () => Promise<T>
): Promise<T> {
	try {
		return await run();
	} catch (error) {
		throw stepError(error, step, context);
	}
}

/** The deployed version from the deploy reply, else the saved one; never throws. */
function deployedVersion(
	project: SitesProject,
	versionId: string,
	saved: SitesVersion | null
): SitesVersion | null {
	return (
		project.versions.find((item) => item.id === versionId) ??
		(saved?.id === versionId ? saved : null)
	);
}

async function currentRevision(
	client: SitesClient,
	projectId: string,
	pinned: number | undefined
): Promise<number> {
	if (pinned !== undefined) {
		return pinned;
	}
	const project = await runStep("read", { projectId }, () =>
		client.getProject(projectId)
	);
	return project.revision;
}

/** Runs `sites.deploy()` (see the module comment for the request order). */
export async function deploySite(
	client: SitesClient,
	input: SitesDeployInput
): Promise<SitesDeployResult> {
	const { projectId } = input;
	let revision = await currentRevision(
		client,
		projectId,
		input.expectedRevision
	);
	const status: SitesStatus = await runStep("status", { projectId }, () =>
		client.status()
	);
	let versionId: string;
	let savedVersion: SitesVersion | null = null;
	if ("html" in input) {
		const saved = await runStep(
			"version",
			{ expectedRevision: revision, projectId },
			() =>
				client.createVersion(projectId, {
					expectedRevision: revision,
					html: input.html,
					message: input.message,
				})
		);
		const latest = saved.versions.at(-1);
		if (latest === undefined) {
			throw new SyntaxError("Sites did not return the saved version.");
		}
		versionId = latest.id;
		savedVersion = latest;
		revision = saved.revision;
	} else {
		versionId = input.versionId;
	}
	const project = await runStep(
		"deploy",
		{ expectedRevision: revision, projectId, versionId },
		() =>
			client.deployVersion(projectId, { expectedRevision: revision, versionId })
	);
	return {
		project,
		url: siteUrl(project.slug, status),
		version: deployedVersion(project, versionId, savedVersion),
	};
}

/** `sites.unpublish()`: takes the Site offline, reading the revision first when it is not given. */
export async function unpublishSite(
	client: SitesClient,
	projectId: string,
	options: { expectedRevision?: number } = {}
): Promise<SitesProject> {
	const revision = await currentRevision(
		client,
		projectId,
		options.expectedRevision
	);
	return client.unpublish(projectId, { expectedRevision: revision });
}

/** Settings with their own routes: the settings route refuses any change to them. */
const SEPARATELY_MANAGED = ["database", "extensions"] as const;

/** The settings the route takes as `null` (to clear them); every other setting refuses `null`. */
const NULLABLE_SETTINGS: ReadonlySet<string> = new Set([
	"spaceId",
	"workspaceId",
]);

/** What the settings route answers when the operator has not allowed public Sites. */
export const SITES_PUBLIC_DISABLED_MESSAGE =
	"Public publishing is disabled by the operator";

/** The hint a `403 policy_denied` for the public audience gets. */
export const SITES_PUBLIC_DISABLED_HINT =
	"Public Sites are off on this Sites process. The operator allows them with RYU_SITES_PUBLIC=1 or the runtime config's publicEnabled (ryu.sites.status() reports publicEnabled); until then choose private, invited or workspace.";

/**
 * The hint the same refusal gets when the change did not name an audience:
 * the Site was saved as public before the operator turned public Sites off,
 * and the settings route checks the whole stored settings object.
 */
export const SITES_STORED_PUBLIC_HINT =
	"This Site is still saved with the public audience, but public Sites are now off on this Sites process, so the settings route refuses every change to it. Send an audience too (private, invited or workspace) with your change, or ask the operator to allow public Sites again.";

/** Whether `error` is the settings route's refusal of the public audience. */
export function isPublicDisabledError(error: unknown): error is RyuError {
	return (
		isRyuError(error) &&
		error.service === "sites" &&
		error.status === 403 &&
		error.code === "policy_denied" &&
		messageWithoutHint(error).trim() === SITES_PUBLIC_DISABLED_MESSAGE
	);
}

function invalidSettings(message: string, details?: unknown) {
	return new RyuInvalidRequestError({
		service: "sites",
		status: 0,
		code: "invalid_request",
		message: `Ryu Sites: ${message}`,
		...(details === undefined ? {} : { details }),
		retryable: false,
	});
}

/**
 * The patch without `undefined` values; refuses an empty patch, the
 * separately managed settings, and `null` on a setting that cannot be cleared
 * (only `workspaceId` and `spaceId` take `null`).
 */
function settingsChanges(patch: SitesSettingsPatch): Record<string, unknown> {
	if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
		throw invalidSettings("updateSettings needs an object of settings.");
	}
	const managed = SEPARATELY_MANAGED.filter((key) => Object.hasOwn(patch, key));
	if (managed.length > 0) {
		throw invalidSettings(
			`${managed.join(" and ")} cannot be changed with updateSettings: Sites manages ${managed.length === 1 ? "it" : "them"} with ${managed.length === 1 ? "its" : "their"} own routes.`,
			{ fields: managed }
		);
	}
	const changes = Object.fromEntries(
		Object.entries(patch).filter(([, value]) => value !== undefined)
	);
	const nulls = Object.keys(changes).filter(
		(key) => changes[key] === null && !NULLABLE_SETTINGS.has(key)
	);
	if (nulls.length > 0) {
		throw invalidSettings(
			`${nulls.join(" and ")} cannot be null: only workspaceId and spaceId can be cleared with null.`,
			{ fields: nulls }
		);
	}
	if (Object.keys(changes).length === 0) {
		throw invalidSettings(
			"updateSettings needs at least one setting to change."
		);
	}
	return changes;
}

/**
 * `projects.updateSettings()`: the settings route replaces every setting, so
 * this reads the Site (step `read`), lays `patch` over its current settings
 * and sends them with `expectedRevision` (step `settings`). A pinned
 * `expectedRevision` is sent as given, so a Site that changed since you read
 * it fails with `409 conflict` instead of being overwritten.
 */
export async function updateSiteSettings(
	client: SitesClient,
	projectId: string,
	patch: SitesSettingsPatch,
	options: { expectedRevision?: number } = {}
): Promise<SitesProject> {
	const changes = settingsChanges(patch);
	const current = await runStep("read", { projectId }, () =>
		client.getProject(projectId)
	);
	const expectedRevision = options.expectedRevision ?? current.revision;
	const settings = { ...current.settings, ...changes } as SitesSettings;
	const storedPublic =
		!Object.hasOwn(changes, "audience") &&
		current.settings.audience === "public";
	try {
		return await runStep("settings", { expectedRevision, projectId }, () =>
			client.updateSettings(projectId, { expectedRevision, settings })
		);
	} catch (error) {
		// The caller did not ask for public: say why the route still refuses it.
		if (storedPublic && isPublicDisabledError(error)) {
			throw copyRyuError(error, { hint: SITES_STORED_PUBLIC_HINT });
		}
		throw error;
	}
}
