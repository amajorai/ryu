// packages/marketplace/src/catalog/host.tsx
//
// The host-services seam for the shared catalog sections (apps / models / skills).
// These sections are Core-node-scoped master-detail browsers with an
// install→enable lifecycle on desktop, and read-only "open in Ryu" browsers on
// web. Everything that differs between the two surfaces crosses this seam:
//
//   - the per-realm data hook (desktop passes its real react-query hook; web
//     passes an adapter that fabricates the same shape from federated data),
//   - the install layer (`install`) — the desktop install/progress button, or
//     `null` on web, which flips every install/enable/lifecycle touchpoint off,
//   - `renderAffordance` — what to render where the install button would be when
//     `install` is null (web: an "Open in Ryu" deep-link button).
//
// The host value MUST be a stable module const on each surface so the hooks it
// carries keep a consistent identity across renders (rules of hooks). This is a
// separate context from MarketplaceHost (the money layer): the two have different
// consumers, but a surface mounts both above its store.

import {
	type ComponentType,
	createContext,
	type ReactNode,
	useContext,
	useMemo,
} from "react";
import type { SkillPacksState } from "./pack-types.ts";
import type { Scorecard } from "./scorecard.ts";
import { describeIncompatibility } from "./surface-labels.ts";
import type {
	AppsCatalogState,
	CatalogChannel,
	CatalogEntry,
	InstalledModelEntry,
	LlmFitEstimate,
	ModelCatalogState,
	SkillsCatalogState,
	Surface,
	VersionSnapshot,
} from "./types.ts";
import { evaluateCompatibility } from "./types.ts";

/** Which realm an affordance target belongs to (drives the web deep-link page). */
export type CatalogRealm = "app" | "model" | "skill";

/** The host surface's UI-density ladder.
 *
 *  Structurally identical to `InterfaceLevel` in
 *  `apps/desktop/src/lib/interface-level.ts`, which is the source of truth —
 *  duplicated rather than imported because this package must not depend on the
 *  app. The DRIFT GUARD is the binding site: the desktop host assigns its own
 *  `useInterfaceLevel` into {@link CatalogHost}, so a fifth level added there
 *  stops `() => InterfaceLevel` being assignable here and that file fails to
 *  compile. Do not weaken this to `string` — that is the whole guard. */
export type CatalogInterfaceLevel =
	| "advanced"
	| "expert"
	| "simple"
	| "standard";

/** Minimal identity of the item an affordance is rendered for. */
export interface CatalogAffordanceTarget {
	id: string;
	name: string;
	realm: CatalogRealm;
}

/** Props for the host-provided install button. The host encapsulates the live
 *  download-progress lookup (keyed by {@link progress}) so the shared sections
 *  never import the desktop downloads store. */
export interface CatalogInstallButtonProps {
	/** Label beside the spinner while installing (a known percent replaces it). */
	busyLabel?: string;
	children: ReactNode;
	/** Disable the idle button (e.g. an incompatible / too-big model file). */
	disabled?: boolean;
	/** Variant used at rest (the busy state always renders the progress fill). */
	idleVariant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
	installing: boolean;
	onClick: () => void;
	/** Identity for the progress lookup: download kinds + display name/id, plus
	 *  the EXACT download-task id when the surface knows it.
	 *
	 *  `name` alone is a heuristic — it is matched against the task's label — and
	 *  for plugins it never hit: Core labels a plugin row with the plugin ID
	 *  (`@ryu/crm`) while the card knew only the display name ("Harbor CRM"), so
	 *  the lookup silently fell back to "the sole in-flight task of this kind" and
	 *  showed an unrelated download's percent whenever two things ran at once.
	 *  `taskId` short-circuits that guesswork. */
	progress: { kinds: string[]; name: string; taskId?: string };
}

/** Minimal node identity a model detail action needs to reach Core. */
export interface CatalogNode {
	token: string | null;
	url: string;
	/** Managed-node user JWT, when the host has one. */
	userJwt?: string | null;
}

/** The catalog realms that can be reviewed by the configured agent. */
export type CatalogScanKind = "app" | "plugin" | "skill";

export interface CatalogScanFile {
	contents?: string | null;
	path: string;
}

/** Evidence sent to Core for the bounded, read-only agent review. The
 * deterministic {@link Scorecard} is included as evidence, but the agent never
 * gets to replace its grade. */
export interface CatalogScanInput {
	description?: string | null;
	files?: CatalogScanFile[];
	id: string;
	kind: CatalogScanKind;
	metadata?: Record<string, unknown>;
	name: string;
	readme?: string | null;
	scorecard: Scorecard;
}

export interface CatalogScanResult {
	agentId: string;
	report: string;
	status: "complete" | "partial";
}

/** The install layer a surface provides, or `null` for a read-only surface. */
export interface CatalogInstall {
	InstallButton: ComponentType<CatalogInstallButtonProps>;
	/** Hook resolving "is this listing's add/enable in flight?" from the SURFACE's
	 *  shared install state, for any id.
	 *
	 *  A hook returning a predicate, called ONCE per section and threaded down to
	 *  the cards — a per-card hook would be one store subscription per row.
	 *
	 *  It exists because a section's own hook state cannot answer the question: the
	 *  desktop Store mounts `useAppsCatalog` twice (first-party + community) and
	 *  renders the same items in other sections entirely, so an add started in one
	 *  place was invisible everywhere else — the detail dialog said "Adding…" while
	 *  the item's own card sat there armed, inviting the second click that Core
	 *  answers with a 409.
	 *
	 *  Omitted ⇒ the section falls back to its hook's per-instance `installing`. */
	useInstallingLookup?: () => (id: string) => boolean;
}

/** Stable "nothing is in flight" lookup, for a host with no shared install state.
 *  Module-level so the fallback hook keeps one identity across renders. */
const NO_INSTALLING = () => false;

/** Fallback for {@link CatalogInstall.useInstallingLookup}. A hook by shape so a
 *  call site can pick one or the other and still make exactly one hook call. */
export function useNoInstallingLookup(): (id: string) => boolean {
	return NO_INSTALLING;
}

/** Fallback for a host with no interface-level notion — the web marketplace.
 *
 *  `"expert"`, i.e. the FULL surface. A surface that cannot ask the user how much
 *  they want to see must not silently decide to show them less; the failure mode
 *  of guessing "simple" is a store where four tabs of a listing simply do not
 *  exist and nobody can find out why. */
const NO_INTERFACE_LEVEL = (): CatalogInterfaceLevel => "expert";

/** Fallback for {@link CatalogHost.useInterfaceLevel}, a hook by shape so a call
 *  site can pick one or the other and still make exactly one hook call. */
export function useNoInterfaceLevel(): CatalogInterfaceLevel {
	return NO_INTERFACE_LEVEL();
}

/** Resolves a plugin id to a "reveal its settings" action, or `null` when that
 *  plugin has no settings destination on this surface. */
export type PluginSettingsOpener = (
	pluginId: string
) => (() => void) | null | undefined;

/** Stable "nothing is configurable here" resolver. Module-level so a surface
 *  without {@link CatalogHost.usePluginSettingsOpener} keeps the same identity
 *  every render and the fallback hook call stays rules-of-hooks clean. */
const NO_SETTINGS_OPENER: PluginSettingsOpener = () => null;

/** Fallback for {@link CatalogHost.usePluginSettingsOpener} on a host that omits
 *  it (web). A hook by shape so call sites can pick one or the other and still
 *  make exactly one hook call per render. */
export function useNoSettingsOpener(): PluginSettingsOpener {
	return NO_SETTINGS_OPENER;
}

/** Stable fallback for hosts that do not have an account session to resolve the
 * A Major Pass presentation marker. This value is informational only: it never
 * controls catalog visibility or any lifecycle action. */
const NO_MARKETPLACE_ACCESS = () => false;

/** Hook-shaped fallback so catalog sections make one presentation lookup. */
export function useNoMarketplaceAccess(): boolean {
	return NO_MARKETPLACE_ACCESS();
}

/** Props for the host-provided Markdown renderer. The two surfaces render skill
 *  READMEs / bundled files through their own Markdown component (desktop:
 *  Streamdown; web: react-markdown), so the shared sections never pick one. */
export interface CatalogMarkdownProps {
	className?: string;
	content: string;
}

/** Optional model inputs used to make a detail-page llmfit estimate specific. */
export interface LlmfitEstimateOptions {
	context?: number;
	quant?: string;
}

/** The full set of services the shared catalog sections need from their host. */
export interface CatalogHost {
	/** The "Use this model" control for an installed model (desktop-only; a
	 *  read-only surface renders nothing since installed cards never appear). */
	ActiveModelControl: ComponentType<{ repoId: string }>;
	/** Whether the SKILL.md authoring routes actually resolve on this surface.
	 *
	 *  {@link navigate} says the host CAN deep-link; this says the deep link LANDS
	 *  somewhere. The two came apart because the editor is a Ryu App
	 *  (`@ryu/skill-editor`) that ships default-OFF: desktop always has
	 *  `navigate`, so it rendered New/Edit on every card, and each one opened a tab
	 *  reading "App not enabled". A host that owns the editor should compute this
	 *  from whatever tells it the app is live (desktop: the contributions feed), not
	 *  from a baked plugin id.
	 *
	 *  Omitted ⇒ treated as `true`, so a host with no notion of app enablement keeps
	 *  its old behaviour and only `navigate` gates authoring. */
	canAuthorSkills?: boolean;
	/** Offer an already-installed skill to locally detected agent clients. Omitted
	 *  on read-only hosts, which hides the action rather than suggesting a local
	 *  distribution flow a browser cannot complete. */
	distributeSkill?: (skillId: string) => Promise<void>;
	/** On-demand llmfit hardware fit + tok/s estimate for one repo. */
	estimateLlmfit: (
		node: CatalogNode,
		repo: string,
		options?: LlmfitEstimateOptions
	) => Promise<LlmFitEstimate>;
	/** Read the release trains a listing publishes (`stable`, `beta`, `nightly`,
	 *  …), each with the version it resolves to right now.
	 *
	 *  Optional, and its absence is meaningful rather than cosmetic: a host that
	 *  cannot resolve channels renders no picker at all, which is the honest
	 *  outcome — offering a channel the surface cannot install from would be a
	 *  control that does nothing. A host that CAN resolve them still returns an
	 *  empty array when nothing is known (an unreachable registry, a listing with
	 *  no prereleases), and an empty array must never be read as "stable only":
	 *  it means "no trains to choose between", which renders the same as no
	 *  picker. */
	fetchListingChannels?: (
		id: string,
		repo?: string | null
	) => Promise<CatalogChannel[]>;
	/** Read a listing as it stood at one published version's tag.
	 *
	 *  Optional because it is genuinely host-specific: the desktop asks its node,
	 *  and a read-only web surface has no such endpoint. Omitting it hides the
	 *  affordance entirely rather than offering an expander that cannot resolve. */
	fetchVersionDetail?: (
		repo: string,
		tag: string
	) => Promise<VersionSnapshot | null>;
	/** Tailwind classes + dot color for a device-fit verdict. */
	fitStyle: (fit: string) => { className: string; dot: string };
	/** Versions of the host surfaces THIS client knows, keyed by surface.
	 *
	 *  Core computes a compatibility verdict for every listing, but it can only
	 *  observe its own version and the Gateway's — it reports a desktop, island,
	 *  mobile, terminal, extension or web floor as an advisory `unknown` because it
	 *  has no way to see those. This is where a surface supplies what it does know:
	 *  the desktop passes its own version (Tauri's `getVersion()`), and the
	 *  per-surface floor becomes enforceable instead of merely declared.
	 *
	 *  Omitted (or `{}`) on a surface that knows nothing extra — the web store,
	 *  which is read-only anyway. Core's verdict is then used as-is, which is the
	 *  previous behaviour. */
	hostVersions?: Partial<Record<Surface, string>>;
	/** The install layer, or `null` on read-only surfaces (web). When null the
	 *  sections hide every install/enable/lifecycle/source affordance and render
	 *  {@link renderAffordance} in the primary-action slot instead. */
	install: CatalogInstall | null;
	/** Point-of-use install of an optional Core sidecar (e.g. `llmfit`). */
	installSidecar: (
		url: string,
		token: string | null,
		name: string
	) => Promise<unknown>;
	/** The surface's Markdown renderer, used for skill READMEs + bundled files. */
	Markdown: ComponentType<CatalogMarkdownProps>;
	/** Deep-link to an in-app route (desktop: open a tab). Its presence gates the
	 *  authoring UI (New/Edit skill) — a read-only surface (web) omits it. */
	navigate?: (path: string) => void;
	/** Open an external URL (Tauri shell on desktop, navigation on web). */
	openExternal: (url: string) => Promise<void> | void;
	/** Read-only primary affordance, rendered where the install button would be
	 *  when {@link install} is null (web: an "Open in Ryu" button). */
	renderAffordance?: (target: CatalogAffordanceTarget) => ReactNode;
	/** Run the configured, read-only agent review for one catalog item. Web omits
	 *  this because it has no Core node to execute against, so the Scan button is
	 *  absent there rather than pretending a browser-only review ran. */
	runCatalogScan?: (input: CatalogScanInput) => Promise<CatalogScanResult>;
	/** Active Core node identity (url + token). Read-only surfaces return a stub;
	 *  the model detail's node-coupled extras (llmfit, fine-tunes, active-model) are
	 *  gated behind {@link install} anyway, so a stub is never actually dereferenced. */
	useActiveNode: () => CatalogNode;
	/** The surface's Apps (plugins) catalog hook (called at component top level).
	 *  `options.origin` selects which slice of the catalog to fetch: omitted =
	 *  the first-party catalog; `"community"` = the GitHub topic-discovered feed.
	 *  It is a FETCH selector, not a client-side filter — unreviewed listings are
	 *  never in the first-party pages, so they can't be filtered out of them. */
	useAppsCatalog: (
		initialQuery: string,
		options?: { origin?: "community" }
	) => AppsCatalogState;
	/** Installed models by stem (drives the "Your fine-tuned versions" list). */
	useInstalledModels: () => InstalledModelEntry[];
	/** How much of the surface this host's user has asked to see.
	 *
	 *  Optional — omitted ⇒ {@link useNoInterfaceLevel}, i.e. everything. Called
	 *  ONCE per section and threaded down as a narrow boolean (`showTechnical`),
	 *  never as the raw level: a detail panel must not learn the ladder, or every
	 *  new level becomes an edit in twenty components. */
	useInterfaceLevel?: () => CatalogInterfaceLevel;
	/** Whether the current account has a recurring plan that contributes to the
	 * Marketplace publisher pool. This only drives the optional ticket explanation;
	 * it is not an install, update, enable, or runtime gate. */
	useMarketplaceAccess?: () => boolean;
	/** The surface's Models catalog hook (called at component top level). */
	useModelCatalog: (initialQuery: string) => ModelCatalogState;
	/** A persisted boolean toggle synced across consumers (e.g. "Show tags"). */
	usePersistedToggle: (
		key: string,
		defaultValue: boolean
	) => [boolean, (v: boolean) => void];
	/** Resolve "where is this plugin configured?" into an opener.
	 *
	 *  A hook (called ONCE per section, its resolver threaded down to the cards) so
	 *  the host can read live state — which plugins declare settings, at which
	 *  scope — without every card refetching it. The resolver returns `null` for a
	 *  plugin with no settings destination, and the Settings affordance then does
	 *  not render, so an item that can't be configured never offers to be.
	 *
	 *  Omitted by read-only surfaces (web has no settings dialog to open); the
	 *  sections fall back to {@link useNoSettingsOpener}. */
	usePluginSettingsOpener?: () => PluginSettingsOpener;
	/** The surface's Skill **packs** hook (called at component top level).
	 *
	 *  Optional, and its absence is meaningful rather than cosmetic: a surface
	 *  with no pack feed (a read-only web host before packs federate) omits it and
	 *  the Packs shelf never renders — an empty shelf would be a control that
	 *  does nothing. A surface that CAN resolve packs returns one; desktop backs
	 *  it with Core's `/api/skills/packs`, web with the federated mirror. */
	useSkillPacks?: () => SkillPacksState;
	/** The surface's Skills catalog hook (called at component top level). */
	useSkillsCatalog: (initialQuery: string) => SkillsCatalogState;
}

const CatalogHostContext = createContext<CatalogHost | null>(null);

export function CatalogHostProvider({
	host,
	children,
}: {
	host: CatalogHost;
	children: ReactNode;
}) {
	return (
		<CatalogHostContext.Provider value={host}>
			{children}
		</CatalogHostContext.Provider>
	);
}

/** Read the injected catalog host services. Throws if no provider is mounted. */
export function useCatalogHost(): CatalogHost {
	const host = useContext(CatalogHostContext);
	if (!host) {
		throw new Error(
			"useCatalogHost must be used within a <CatalogHostProvider>."
		);
	}
	return host;
}

/** The user-facing reason a listing cannot be installed here, or `null`.
 *
 *  Re-evaluates the listing's declared floors with {@link CatalogHost.hostVersions}
 *  overlaid on Core's verdict. That overlay is the whole point: Core reports a
 *  desktop/island/mobile/terminal floor as advisory `unknown` because it cannot
 *  observe those surfaces, so reading `entry.compatibility` alone leaves every
 *  per-surface floor inert on the one client that DOES know its own version.
 *
 *  Falls back to Core's verdict for anything the client cannot decide, so this
 *  only ever hardens an advisory into a refusal — never the reverse. */
export function useEntryIncompatibility(
	entry: Pick<CatalogEntry, "compatibility" | "engines">
): string | null {
	const { hostVersions } = useCatalogHost();
	const { compatibility, engines } = entry;
	return useMemo(
		() =>
			describeIncompatibility(
				evaluateCompatibility(engines, hostVersions ?? {}, compatibility)
			),
		[engines, compatibility, hostVersions]
	);
}
