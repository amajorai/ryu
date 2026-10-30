import type {
	CardDither,
	CatalogDeprecation,
	CatalogLayer,
	CatalogSurfaceSupport,
} from "@ryu/marketplace/catalog/types";
import type {
	AppLifecycleAction,
	AppRecord,
	AppRequires,
} from "@ryuhq/core-client/plugins.ts";
import { z } from "zod";
import type { PluginValue } from "./plugin-wire-values.ts";
import type { APP_LIFECYCLE_PERMISSIONS } from "./plugins-response-codecs.ts";
import type { ManifestTarget } from "./plugins-wire-types.ts";

// ── Client types (camelCase, used by React) ───────────────────────────────────

/** Server-derived plugin provenance. The id namespace is not a trust signal. */
export type AppTier = "core" | "community";

/** First-party UI is admitted only when Core explicitly derives the Core tier. */
export function isCoreAppTier(
	tier: AppTier | null | undefined
): tier is "core" {
	return tier === "core";
}

/** Parse Core's provenance field without ever treating an unknown value as Core. */
const appTierSchema = z.enum(["core", "community"]);
export function appTierFromWire(
	value: Parameters<typeof appTierSchema.parse>[0]
): AppTier | null {
	const parsed = appTierSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export interface RunnableEntry {
	config: PluginValue;
	id: string;
	kind: string;
	name: string;
}

/** The manifest's PRESENTATIONAL fields — what makes an installed app look like
 *  itself rather than like a grey glyph.
 *
 *  Core's `list_apps` serialises the whole manifest, so every one of these has
 *  always been on the wire; the client simply dropped them, which is why the
 *  sidebar and the Installed tab fell back to a placeholder tile while the Store's
 *  catalog tabs — reading the same fields off `CatalogEntry` — showed real art.
 *  Same names, same meanings, so `AppIcon`/`StoreCatalogCard` take them unchanged
 *  and one app looks identical on every surface. */
export interface AppPresentation {
	/** Primary brand accent colour used by compact app-owned tokens. */
	accentColor?: string | null;
	/** Free-text store category ("Productivity", …). */
	category: string | null;
	/** Deprecation notice; null = current. Renders the "Deprecated" badge. */
	deprecated: CatalogDeprecation | null;
	/** Long plaintext/markdown description — the detail body, not the card line. */
	description: string | null;
	external: boolean;
	/** Icon-primitive id, or an `svgl:<slug>` brand mark. */
	icon: string | null;
	/** Flat CSS background for the icon square. */
	iconBackground: string | null;
	/** Dithered-gradient background for the icon square. */
	iconDither: CardDither | null;
	/** Inset and letterbox treatment for icon art (`iconPadding`). */
	iconPadding: string | null;
	/** Raster logo URL. */
	iconUrl: string | null;
	layers: CatalogLayer[];
	/** "alpha" / "beta" / … — null or "stable" renders no badge. */
	stability: string | null;
	/** Short one-line pitch — the CARD line. Prefer this over `description`, which
	 *  is a paragraph and would be truncated to nothing useful in a one-line slot. */
	tagline: string | null;
}

export interface AppInfo extends AppPresentation {
	/** The grants currently IN FORCE — the subset of {@link permissionGrants} the
	 *  last successful enable approved. Empty for a plugin that was never enabled.
	 *  The permissions editor checks its switches against this, never against the
	 *  manifest's declaration, which is only what the app asked for. */
	approvedGrants: string[];
	/** Whether the package is embedded/owned by the Ryu distribution. This is
	 *  provenance, not an installation or enabled-state flag. */
	builtIn: boolean;
	/** The release train this install FOLLOWS — `stable`, `beta`, `nightly`, … —
	 *  which is what the next update resolves on. Not derivable from the version:
	 *  a plugin pinned to `canary` whose canary train has no build yet still sits
	 *  on a stable version. `null` when the plugin is not installed. */
	channel: string | null;
	companion: {
		label: string;
		icon: string | null;
		shortcut: string | null;
	} | null;
	enabled: boolean;
	id: string;
	installed: boolean;
	/** The version the lifecycle record actually holds — what is ON THIS MACHINE.
	 *  `null` for an uninstalled app, including an install-on-demand built-in;
	 *  pre-installed built-ins have a seeded lifecycle record. `version` is the
	 *  MANIFEST's version, which for an out-of-date install is the newer one.
	 *  Render `installedVersion ?? version`, never `version` alone. */
	installedVersion: string | null;
	localOnly: boolean;
	/** Required for Core: never render a Disable switch or an Uninstall button.
	 *  Core refuses both with a 403 and no force override, so the control could only
	 *  ever produce an error. Stamped by Core from its own `MANDATORY_PLUGINS`
	 *  constant, never from the manifest's claim of it. */
	mandatory: boolean;
	/** Remote MCP servers whose OAuth lifecycle is owned by Core. */
	mcpOAuthServers: McpOAuthServerDeclaration[];
	name: string;
	/** Off until explicitly approved; these never block ordinary app enable. */
	optionalPermissionGrants?: string[];
	permissionGrants: string[];
	/** Declared dependencies. `null` = none (the common case). */
	requires: AppRequires | null;
	runnables: RunnableEntry[];
	sidecarName: string | null;
	/** Enabled by the user, but not loaded this boot because the node is in Safe
	 *  Mode. Render it as "Disabled by Safe Mode" rather than letting the card
	 *  claim the app is running — that mismatch (enabled switch, missing panel) is
	 *  the confusing state Safe Mode has to explain, not create. */
	suppressedBySafeMode: boolean;
	/** Per-surface support levels from Core's catalog projection. */
	surfaceSupport: CatalogSurfaceSupport[];
	/** Core refuses to uninstall it, so it is labelled "System" and offers no
	 *  Remove control. Stamped by Core from the same predicate that refuses the
	 *  uninstall (`is_uninstall_protected`), so label and protection agree. */
	system: boolean;
	/** Host surfaces this plugin runs on. **Empty = every surface**, never "none". */
	targets: ManifestTarget[];
	/** Core-derived provenance. Missing/unknown values are not first-party. */
	tier: AppTier | null;
	version: string;
	windowsFirst: boolean;
}

export interface McpOAuthServerDeclaration {
	clientId: string | null;
	name: string;
	resource: string;
}

export type AppLifecyclePermission = (typeof APP_LIFECYCLE_PERMISSIONS)[number];

export interface AppLifecycleCapabilities {
	node: {
		id: string;
		orgId: string | null;
		ownerUserId: string | null;
		scope: "org" | "team" | "personal";
		teamId: string | null;
	} | null;
	permissions: Record<AppLifecyclePermission, boolean>;
	reasons?: Partial<Record<AppLifecyclePermission, string>>;
}

export interface PluginDoctorFinding {
	canAutoFix: boolean;
	category: string;
	checkId: string;
	detail: string;
	evidence?: PluginValue;
	pluginId: string;
	recommendedAction: string;
	severity: "error" | "warning" | "info" | string;
	source: string;
	summary: string;
}

export interface PluginDoctorInventoryItem {
	evals?: PluginEvalSuite;
	findingCount: number;
	id: string;
	name: string;
	status: "healthy" | "warning" | "error" | string;
}

export interface PluginDoctorReport {
	counts: {
		errors: number;
		info: number;
		plugins: number;
		warnings: number;
	};
	findings: PluginDoctorFinding[];
	generatedAt: string;
	plugins: PluginDoctorInventoryItem[];
	profile: "lint" | string;
	readOnly: boolean;
	rulesetVersion: string;
	schemaVersion: string;
	scope: string;
	score: number;
}

export interface PluginEvalIssue {
	code: string;
	message: string;
	path: string;
	severity: "error" | "warning" | "info" | string;
}

export interface PluginEvalCaseSummary {
	graderCount: number;
	id: string;
	maxTurns: number;
	name: string;
	path: string;
	runnable?: string | null;
	runs: number;
	tags: string[];
	timeoutSeconds: number;
}

export interface PluginEvalSuite {
	caseCount: number;
	cases: PluginEvalCaseSummary[];
	directory: string;
	graderCount: number;
	issues: PluginEvalIssue[];
	rulesetVersion: string;
	schemaVersion: string;
	status:
		| "not_configured"
		| "empty"
		| "ready"
		| "ready_with_warnings"
		| "invalid"
		| string;
	supportedGraders: string[];
	unsupportedGraders: string[];
}

export interface PluginEvalOverview {
	artifactKind: "plugin" | "app" | string;
	pluginId: string;
	suite: PluginEvalSuite;
}

export interface PluginEvalGraderResult {
	detail: string;
	executed: boolean;
	id: string;
	score: number | null;
	status: "pass" | "fail" | "skipped" | string;
	type: string;
}

export interface PluginEvalAttempt {
	durationMs: number;
	error: string | null;
	graders: PluginEvalGraderResult[];
	id: string;
	responsePreview: string | null;
	score: number | null;
	status: "passed" | "failed" | "unavailable" | "error" | "skipped" | string;
	toolCalls: string[];
}

export interface PluginEvalCaseResult {
	failed: number;
	id: string;
	name: string;
	passed: number;
	runs: PluginEvalAttempt[];
	score: number | null;
	skipped: number;
	status: "passed" | "failed" | "unavailable" | string;
}

export interface PluginEvalRunResult {
	artifactKind: "plugin" | "app" | string;
	baseline: { reason: string; status: string };
	cases: PluginEvalCaseResult[];
	evidenceLevel: string;
	finishedAt?: string;
	pluginId: string;
	runId: string | null;
	schemaVersion: string;
	score: number | null;
	startedAt?: string;
	status:
		| "passed"
		| "failed"
		| "partial"
		| "unavailable"
		| "invalid"
		| "not_configured"
		| string;
	suite: PluginEvalSuite;
	threshold?: number;
}

export interface PluginEvalRunInput {
	case?: string;
	id: string;
	runs?: number;
	threshold?: number;
}

/** An {@link AppRecord} plus the "the change did not reach the gateway" truth Core
 *  attaches when a gateway-policy plugin is toggled against a remote/unmanaged
 *  gateway. `externallyManaged` true means the record flipped but the running
 *  gateway was NOT reconfigured — surface `notice` rather than implying success. */
export interface AppToggleResult extends AppRecord {
	externallyManaged?: boolean;
	notice?: string;
}

export interface AppLifecyclePreview {
	action: AppLifecycleAction;
	dryRun: true;
	success: boolean;
	[key: string]: PluginValue | undefined;
}
