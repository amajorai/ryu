// The `apps.installBundle` contract (grant `plugins:install`): a Companion app
// such as App Studio hands the host a self-contained Ryu App it built, and the
// host installs it through Core's generic install-bundle sink.
//
// The frame is untrusted, so this module narrows what such a bundle may be:
//
// - companion-only: one `kind:"companion"` runnable rendered from inline HTML
//   (`ui_format:"html"`); no sidecar, backend, MCP server, hook, tool, route or
//   contribution, so building an app can never start a local process;
// - namespaced: the id must be `com.local.<caller-segment>.<slug>`, so an app may
//   install or update only the apps it created and never replace another app;
//   its one runnable is `<caller-segment>-<slug>`, so its companion route cannot
//   collide with another app's;
// - low-privilege: only the reviewed companion grants below may be requested.
//   Core leaves a new install DISABLED, and the Gateway validates these grants
//   again when the user enables it.
//
// Pure (zod only) so the desktop host, the app and the tests share one rule.

import { z } from "zod";

/** The grants a generated companion may request. Each is already on the
 *  Gateway's reviewed allowlist and reaches only the app's own data or a
 *  user-visible host surface. */
export const APP_BUNDLE_GRANTS = [
	"storage:kv",
	"ui:toast",
	"hook:side-model",
	"files:download",
] as const;

export type AppBundleGrant = (typeof APP_BUNDLE_GRANTS)[number];

/** Generous for an inline single-file app, far under Core's own 32 MiB cap. */
export const MAX_APP_BUNDLE_UI_BYTES = 5_000_000;

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HTML_DOCUMENT = /^\s*<!doctype html/i;

// Core refuses companion labels that impersonate system chrome; refuse them here
// too so the builder reports it before the install round trip.
const label = z
	.string()
	.trim()
	.min(1)
	.max(60)
	.refine(
		(value) => !/ryu|system/i.test(value),
		"Labels cannot contain “Ryu” or “System”"
	);

const companionRunnableSchema = z
	.object({
		id: z.string().regex(SLUG).max(64),
		name: label,
		kind: z.literal("companion"),
		config: z
			.object({
				label,
				ui_entry: z.literal("./dist/index.html"),
				ui_format: z.literal("html"),
			})
			.strict(),
	})
	.strict();

export const appBundleSchema = z
	.object({
		id: z.string().max(120),
		name: label,
		version: z.string().regex(SEMVER, "Version must be semver, like 1.0.0"),
		description: z.string().trim().max(500).optional(),
		tagline: z.string().trim().max(120).optional(),
		category: z.string().trim().max(40).optional(),
		icon: z
			.string()
			.regex(/^[a-z0-9-]{1,48}$/)
			.optional(),
		keywords: z.array(z.string().trim().min(1).max(32)).max(12).optional(),
		engines: z
			.object({ ryu: z.string().max(32) })
			.strict()
			.optional(),
		permission_grants: z.array(z.enum(APP_BUNDLE_GRANTS)).max(8),
		runnables: z.array(companionRunnableSchema).length(1),
		companion: z
			.object({
				label,
				icon: z
					.string()
					.regex(/^[a-z0-9-]{1,48}$/)
					.optional(),
			})
			.strict(),
		ui_code: z
			.string()
			.max(MAX_APP_BUNDLE_UI_BYTES)
			.regex(HTML_DOCUMENT, "The app UI must be a complete HTML document"),
		update: z.boolean().optional(),
	})
	.strict();

export type AppBundle = z.output<typeof appBundleSchema>;

/** What the host returns after Core accepted the bundle. */
export const appBundleInstallResultSchema = z.object({
	id: z.string(),
	installed: z.literal(true),
	updated: z.boolean(),
	version: z.string(),
});

export type AppBundleInstallResult = z.output<
	typeof appBundleInstallResultSchema
>;

/** The last segment of a caller id: `@ryu/app-studio` → `app-studio`. */
export function callerSegment(callerPluginId: string): string | null {
	const segment = callerPluginId.split(/[/.]/).at(-1)?.toLowerCase() ?? "";
	return SLUG.test(segment) ? segment : null;
}

/** The id prefix every app installed by `callerPluginId` must carry. */
export function appBundleIdPrefix(callerPluginId: string): string | null {
	const segment = callerSegment(callerPluginId);
	return segment ? `com.local.${segment}.` : null;
}

export type AppBundleCheck =
	| { bundle: AppBundle; ok: true }
	| { error: string; ok: false };

/**
 * Validate a frame-supplied bundle for the caller that sent it. Returns the
 * parsed bundle (unknown keys rejected, not stripped) or the first problem.
 */
export function checkAppBundle(
	callerPluginId: string,
	value: unknown
): AppBundleCheck {
	const parsed = appBundleSchema.safeParse(value);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
		return {
			ok: false,
			error: `Invalid app bundle (${where}${issue?.message ?? "unknown"})`,
		};
	}
	const prefix = appBundleIdPrefix(callerPluginId);
	const slug = prefix ? parsed.data.id.slice(prefix.length) : "";
	if (!(prefix && parsed.data.id.startsWith(prefix) && SLUG.test(slug))) {
		return {
			ok: false,
			error: prefix
				? `App id must look like ${prefix}<name>`
				: "This app cannot install other apps",
		};
	}
	const runnableId = `${callerSegment(callerPluginId)}-${slug}`;
	if (parsed.data.runnables[0]?.id !== runnableId) {
		return { ok: false, error: `The app's runnable id must be ${runnableId}` };
	}
	return { ok: true, bundle: parsed.data };
}
