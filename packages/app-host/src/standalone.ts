import { z } from "zod";

const standaloneManifestSchema = z.record(z.string(), z.unknown());
export type StandaloneAppManifest = z.infer<typeof standaloneManifestSchema>;

/** Shared contract for a Desktop host built around one Ryu app. */

export interface StandaloneAppBundle {
	appId: string;
	appName: string;
	manifest: StandaloneAppManifest;
	schemaVersion: 1;
	sidecars: readonly StandaloneSidecarResource[];
	uiCode: string | null;
	version: string;
}

/**
 * A Desktop-only standalone surface installed from an already-installed app.
 *
 * This is deliberately not a second plugin lifecycle record. The app id points
 * back to the existing manifest and Core-owned data; the record only remembers
 * that this Desktop installation should offer an app-first window for it.
 */
export interface StandaloneAppInstallation {
	appId: string;
	installedAt: string;
	version: string;
}

export interface StandaloneAppRegistry {
	apps: StandaloneAppInstallation[];
	schemaVersion: 1;
}

const MAX_STANDALONE_APP_INSTALLATIONS = 128;

const standaloneAppIdSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[a-zA-Z0-9@._/-]+$/)
	.refine(
		(value) =>
			!(value.startsWith("/") || value.endsWith("/") || value.includes("//")) &&
			value.split("/").every((segment) => segment !== "." && segment !== "..")
	);

const standaloneAppInstallationSchema = z.object({
	appId: standaloneAppIdSchema,
	installedAt: z.string().min(1).max(80),
	version: z.string().min(1).max(100),
});

function isStandaloneAppInstallation<T>(
	value: T
): value is T & StandaloneAppInstallation {
	return standaloneAppInstallationSchema.safeParse(value).success;
}

const standaloneAppRegistrySchema = z.object({
	apps: z.array(z.unknown()),
	schemaVersion: z.literal(1),
});

function dedupeStandaloneAppInstallations(
	apps: readonly StandaloneAppInstallation[]
): StandaloneAppInstallation[] {
	const byId = new Map<string, StandaloneAppInstallation>();
	for (const app of apps) {
		if (isStandaloneAppInstallation(app)) {
			byId.set(app.appId, app);
		}
	}
	return [...byId.values()].slice(-MAX_STANDALONE_APP_INSTALLATIONS);
}

/** Parse the local Desktop standalone-surface registry fail-closed. */
export function parseStandaloneAppRegistry(
	value: string | null | undefined
): StandaloneAppInstallation[] {
	if (!value) {
		return [];
	}
	try {
		const parsed = standaloneAppRegistrySchema.safeParse(JSON.parse(value));
		return parsed.success
			? dedupeStandaloneAppInstallations(
					parsed.data.apps.filter(isStandaloneAppInstallation)
				)
			: [];
	} catch {
		return [];
	}
}

/** Serialize the local Desktop standalone-surface registry. */
export function serializeStandaloneAppRegistry(
	apps: readonly StandaloneAppInstallation[]
): string {
	const registry: StandaloneAppRegistry = {
		apps: dedupeStandaloneAppInstallations(apps),
		schemaVersion: 1,
	};
	return JSON.stringify(registry);
}

/** Add or refresh one standalone surface without duplicating its app id. */
export function upsertStandaloneAppInstallation(
	apps: readonly StandaloneAppInstallation[],
	installation: StandaloneAppInstallation
): StandaloneAppInstallation[] {
	return dedupeStandaloneAppInstallations([
		...apps.filter((app) => app.appId !== installation.appId),
		installation,
	]);
}

/** Remove only the standalone surface; the app lifecycle record is untouched. */
export function removeStandaloneAppInstallation(
	apps: readonly StandaloneAppInstallation[],
	appId: string
): StandaloneAppInstallation[] {
	return apps.filter((app) => app.appId !== appId);
}

export interface StandaloneSidecarResource {
	command: string | null;
	commandEnv?: string;
	mode: "core-provisioned" | "embedded";
	name: string;
	resourcePath?: string;
	sha256?: string;
}

export type StandaloneBootstrapPhase =
	| "loading"
	| "installing"
	| "enabling"
	| "ready"
	| "no_companion"
	| "error";

const STANDALONE_PORT_OFFSET_MIN = 12_000;
const STANDALONE_PORT_OFFSET_SPAN = 16_000;

/**
 * Derive one stable port namespace for an app-specific Desktop build.
 *
 * The offset stays outside the normal release/dev/canary/beta bands while the
 * app id keeps different standalone products from fighting over Core and their
 * manifest sidecars. The native host still remains single-instance per product.
 */
export function standalonePortOffset(appId: string): number {
	let hash = 2_166_136_261;
	for (const byte of new TextEncoder().encode(appId)) {
		hash ^= byte;
		hash = Math.imul(hash, 16_777_619) >>> 0;
	}
	return STANDALONE_PORT_OFFSET_MIN + (hash % STANDALONE_PORT_OFFSET_SPAN);
}

/**
 * Resolve an app-private data root below the Ryu host data directory. The native
 * host uses `<platform data dir>/Ryu/ryu-apps/<slug>`; callers pass that
 * `<platform data dir>/Ryu` root here so browser-side diagnostics and native
 * launch agree on the same namespace.
 *
 * This is a string-only helper so the same namespace rule can be used by the
 * browser-facing builder and by native launch diagnostics without importing a
 * platform filesystem library into the Companion package.
 */
export function standaloneDataDir(
	appId: string,
	platformDataDir: string
): string {
	const slug =
		appId
			.trim()
			.replace(/[^a-zA-Z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "app";
	const root = platformDataDir.replace(/[\\/]+$/, "");
	return `${root}/ryu-apps/${slug}`;
}

/** Find the first Companion contributed by the selected app. */
export function standaloneCompanionId(
	companions: readonly { id: string; pluginId: string }[],
	appId: string
): string | null {
	return (
		companions.find((companion) => companion.pluginId === appId)?.id ?? null
	);
}

const standaloneSidecarSchema = z.looseObject({
	command: z.string().nullable(),
	commandEnv: z.string().optional(),
	mode: z.enum(["core-provisioned", "embedded"]),
	name: z.string(),
	resourcePath: z.string().optional(),
	sha256: z.string().optional(),
});

const standaloneAppBundleSchema = z.object({
	appId: z.string().trim().min(1),
	appName: z.string().trim().min(1),
	manifest: standaloneManifestSchema,
	schemaVersion: z.literal(1),
	sidecars: z.array(standaloneSidecarSchema),
	uiCode: z.string().nullable(),
	version: z.string().trim().min(1),
});

const standaloneAppBundleBoundarySchema = z
	.unknown()
	.transform((value): StandaloneAppBundle | null => {
		const parsed = standaloneAppBundleSchema.safeParse(value);
		return parsed.success ? parsed.data : null;
	});

/** Validate the native carriage before it crosses the Tauri bridge. */
export const parseStandaloneAppBundle = standaloneAppBundleBoundarySchema.parse;

export const standalonePortOffsetBounds = {
	max: STANDALONE_PORT_OFFSET_MIN + STANDALONE_PORT_OFFSET_SPAN - 1,
	min: STANDALONE_PORT_OFFSET_MIN,
} as const;
