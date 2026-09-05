// packages/marketplace/src/catalog/types.ts
//
// Structural item + hook-state types for the shared catalog sections. These
// declare ONLY the fields the moved components actually read — pass-through /
// unread fields on the desktop hooks (e.g. AppCatalogItem.info) are intentionally
// omitted so a surface's real hook result stays structurally assignable without
// this package importing anything from apps/desktop. Desktop passes its concrete
// hook results (which carry a superset of these fields); web passes an adapter
// that fabricates exactly these fields from its federated catalog data.

// ---------------------------------------------------------------------------
// Apps (plugins) realm
// ---------------------------------------------------------------------------

import type { VerificationDetails } from "@ryu/ui/components/verification-popover.tsx";
import type {
	PublisherTrustLevel,
	PublisherTrustSource,
} from "@ryuhq/protocol/publisher-trust";

/**
 * The `?source=` value that browses every marketplace at once — the store's
 * default view. Mirrors Core's `PLUGIN_ALL_SOURCES_ID`.
 *
 * It is a VIEW, not a registered source: it never appears in the `sources` list
 * the server returns, it cannot be the node's active-source preference, and Core
 * resolves it to a list of real sources at both the browse and detail seams. It
 * lives in this module — the wire contract both hosts already import — rather than
 * beside the component that renders it, so the desktop and web hooks can default to
 * it without pulling the section's component tree into their bundle.
 */
export const ALL_PLUGIN_SOURCES_ID = "all";

/** The live federated view across every registered Skill marketplace. */
export const ALL_SKILL_SOURCES_ID = "all";

/** The host surfaces a plugin can declare support for.
 *
 *  Mirrors the `Surface` enum in `crates/core/kernel-contracts/src/manifest.rs`
 *  (and its SDK mirror, `@ryuhq/sdk`'s generated `plugin-manifest.ts`). Duplicated
 *  here rather than imported so this package keeps no dependency on the SDK; the
 *  `satisfies Record<Surface, string>` on `SURFACE_LABELS` is what stops the two
 *  drifting silently, which is exactly how that map ended up defining `browser`
 *  and `tui` — two tokens that were never real surfaces.
 *
 *  `unknown` is not a surface anyone declares: it is the landing pad Core
 *  deserializes an unrecognised token onto so a manifest from a newer Ryu loads
 *  instead of failing outright. */
export type Surface =
	| "gateway"
	| "core"
	| "desktop"
	| "island"
	| "mobile"
	| "extension"
	| "web"
	| "cli"
	| "unknown";

/** One safe catalog row for a listing's per-surface support declaration.
 *
 * `support` stays a string so a newer Core can add a level without breaking an
 * older catalog client. `inheritedFrom` describes the host-shell relationship,
 * not package code inheritance: Web, Mobile, and the Browser extension reuse the
 * shared Desktop shell contract. */
export interface CatalogSurfaceSupport {
	inheritedFrom?: string | null;
	support?: string | null;
	surface: string;
}

/** A display-only summary of an existing host capability or shell slot this
 * listing extends. The signed manifest's `provides`/`contributes` declarations
 * remain the authority; this shape contains no executable binding. */
export interface CatalogExtensionSummary {
	features: string[];
	label: string;
	target: string;
}

/** A display-only ownership boundary for the listing's implementation. */
export interface CatalogImplementationSummary {
	features: string[];
	label: string;
	layer: string;
}

// ── Host version floors (`engines`) ──────────────────────────────────────────

/** The `engines` block: a semver requirement per host surface. Mirrors Core's
 *  `EnginesReq`.
 *
 *  `ryu` is the CORE floor under its legacy name — every manifest in the wild
 *  spells it that way, and Core's `Surface::engines_key()` maps `core` onto it.
 *  When naming the offending key in UI copy, use `engines_key`-equivalent wording
 *  (`ryu` for core), never the bare surface token, or the message points at a key
 *  that does not exist in any manifest. */
export interface HostFloors {
	cli?: string | null;
	desktop?: string | null;
	extension?: string | null;
	gateway?: string | null;
	island?: string | null;
	mobile?: string | null;
	/** The CORE floor. */
	ryu?: string | null;
	web?: string | null;
}

/** One unsatisfied floor. Tagged on `code`, mirroring Core's `UnmetRequirement`.
 *
 *  `unknown` is ADVISORY and must never block a verb: it means the evaluator did
 *  not know that surface's version, not that the surface is too old. */
export type UnmetRequirement =
	| { code: "too_old"; surface: Surface; required: string; present: string }
	| { code: "unknown"; surface: Surface; required: string }
	| {
			code: "invalid_requirement";
			surface: Surface;
			required: string;
			reason: string;
	  };

/** The result of checking {@link HostFloors} against the running hosts. */
export interface CompatibilityVerdict {
	/** True when nothing BLOCKING is unmet. Advisory `unknown` entries do not
	 *  clear this — a plugin whose only problem is an unobservable surface stays
	 *  installable. */
	compatible: boolean;
	/** Every unsatisfied floor, blocking and advisory alike. */
	unmet?: UnmetRequirement[];
}

/** The surface a floor key names, for display. `ryu` is Core. */
const FLOOR_KEY_TO_SURFACE: Record<keyof HostFloors, Surface> = {
	cli: "cli",
	desktop: "desktop",
	extension: "extension",
	gateway: "gateway",
	island: "island",
	mobile: "mobile",
	ryu: "core",
	web: "web",
};

/** Strip a leading `v` and any prerelease/build suffix, returning `[major, minor,
 *  patch]`, or `null` if it does not look like semver.
 *
 *  The suffix is DROPPED on purpose, matching Core: semver says a prerelease does
 *  not satisfy a plain `>=` range, so comparing `0.1.12-nightly.3` verbatim
 *  against `>=0.1.0` would mark every plugin incompatible on every nightly. */
function releaseTriple(version: string): [number, number, number] | null {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	if (!match) {
		return null;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compare two release triples: negative if `a < b`, 0 if equal, positive if `a > b`. */
function compareTriples(
	a: [number, number, number],
	b: [number, number, number]
): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Does `present` satisfy the semver requirement `required`?
 *
 *  Deliberately a SUBSET of semver's range grammar — the comparator forms Core's
 *  `VersionReq` actually sees in practice (`>=x`, `>x`, `<x`, `<=x`, `=x`, a bare
 *  version meaning `>=`, and comma-separated conjunctions). Returns `null` for
 *  anything it cannot parse, and every caller treats `null` as "cannot decide,
 *  do not claim incompatible" — the client is a DISPLAY refinement, and Core
 *  remains the authority that actually refuses the install. */
function satisfies(present: string, required: string): boolean | null {
	const have = releaseTriple(present);
	if (!have) {
		return null;
	}
	for (const rawPart of required.split(",")) {
		const part = rawPart.trim();
		if (part === "" || part === "*") {
			continue;
		}
		// Minor and patch are BOTH optional: a bound is routinely written `<2`, and
		// requiring `x.y` made that unparseable, so `">=1.2, <2"` silently degraded
		// to "cannot decide" and let a 2.0.0 host look compatible. An omitted
		// component is zero, matching semver's own reading of a partial version.
		const m = /^(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(
			part
		);
		if (!m) {
			return null;
		}
		const op = m[1] ?? ">=";
		const want: [number, number, number] = [
			Number(m[2]),
			Number(m[3] ?? 0),
			Number(m[4] ?? 0),
		];
		const cmp = compareTriples(have, want);
		const ok =
			(op === ">=" && cmp >= 0) ||
			(op === ">" && cmp > 0) ||
			(op === "<=" && cmp <= 0) ||
			(op === "<" && cmp < 0) ||
			(op === "=" && cmp === 0);
		if (!ok) {
			return false;
		}
	}
	return true;
}

/** Re-evaluate {@link HostFloors} with the versions THIS client knows.
 *
 *  Why a client-side pass exists at all: Core observes only its own version and
 *  the Gateway's, so it reports a desktop/island/mobile floor as advisory
 *  `unknown`. The desktop DOES know its own version (Tauri's `getVersion()`), so
 *  overlaying it turns that advisory into a real refusal — the whole point of
 *  declaring a per-surface floor.
 *
 *  Strictly a refinement: a floor this function cannot parse, or a surface it has
 *  no version for, is left exactly as Core reported it. It never marks something
 *  compatible that Core called incompatible.
 *
 *  @param floors    the listing's declared `engines`
 *  @param known     surface → running version, for surfaces this client knows
 *  @param serverVerdict Core's verdict, used as the base so server-only knowledge
 *                       (the observed Gateway version) is not lost. */
export function evaluateCompatibility(
	floors: HostFloors | null | undefined,
	known: Partial<Record<Surface, string>>,
	serverVerdict?: CompatibilityVerdict | null
): CompatibilityVerdict {
	if (!floors) {
		return serverVerdict ?? { compatible: true, unmet: [] };
	}

	const unmet: UnmetRequirement[] = [];
	for (const [key, surface] of Object.entries(FLOOR_KEY_TO_SURFACE) as [
		keyof HostFloors,
		Surface,
	][]) {
		const required = floors[key];
		if (!required) {
			continue;
		}
		// Prefer what this client knows; fall back to what the server already said
		// about the same surface so an observed Gateway version survives.
		const present = known[surface];
		if (present === undefined) {
			const fromServer = serverVerdict?.unmet?.find(
				(u) => u.surface === surface
			);
			unmet.push(fromServer ?? { code: "unknown", required, surface });
			continue;
		}
		const ok = satisfies(present, required);
		if (ok === false) {
			unmet.push({ code: "too_old", present, required, surface });
		} else if (ok === null) {
			// Undecidable locally — defer to the server rather than invent a verdict.
			const fromServer = serverVerdict?.unmet?.find(
				(u) => u.surface === surface
			);
			if (fromServer) {
				unmet.push(fromServer);
			}
		}
	}

	return {
		compatible: !unmet.some(
			(u) => u.code === "too_old" || u.code === "invalid_requirement"
		),
		unmet,
	};
}

/** The entries that actually prevent an install (advisory `unknown` excluded).
 *
 *  Shared so no caller has to re-derive which codes block — getting that wrong in
 *  one place is how an advisory turns into a spurious refusal. The user-facing
 *  sentence lives in `surface-labels.ts` (`describeIncompatibility`), which owns
 *  the surface display names. */
export function blockingUnmet(
	verdict: CompatibilityVerdict | null | undefined
): UnmetRequirement[] {
	return (verdict?.unmet ?? []).filter(
		(u) => u.code === "too_old" || u.code === "invalid_requirement"
	);
}

/** Presentational banner descriptor for an app's hero region — the listing's OWN
 *  background, as opposed to the wash the hero derives from its `icon_dither` when
 *  no banner is declared.
 *
 *  Every field is optional and every field is PUBLISHER-supplied: Core keeps the
 *  whole value as an opaque `serde_json::Value` and copies it onto the catalog entry
 *  verbatim (`crates/core/kernel-contracts/src/manifest.rs`, pinned by
 *  `manifest_banner_reaches_the_card_verbatim_including_unknown_keys`), so nothing
 *  between the manifest and this type validates it. `DitherBanner` picks the first
 *  key that paints and falls back down the list, so a malformed one degrades to the
 *  derived wash instead of failing. */
export interface CatalogBanner {
	/** A flat CSS background — a colour, or a `linear-gradient(…)`. Wins over
	 *  `colors`. Guarded before paint: see `safeCssBackground`. */
	background?: string;
	/** Two or more stops, ramped 135°. */
	colors?: string[];
	/** The animated-gradient spec, read only when `style` is
	 *  `"animated-gradient"`. Its own preset/config live in `@ryu/ui`'s
	 *  `animated-gradient`; this is the untrusted wire shape, so every field is
	 *  loose and the render layer resolves + clamps it. */
	gradient?: CatalogBannerGradient;
	/** A raster banner, painted `object-cover` over the background. http(s) only —
	 *  it goes through `safeHttpUrl`. */
	imageUrl?: string;
	/** The grain overlay. Declared by `style: "dither"` (which turns it on with
	 *  defaults) or by an `animated-gradient` that wants grain over the shader.
	 *  ONE overlay serves both — there is no second noise system. */
	noise?: { opacity?: number; scale?: number };
	/** Noise seed for the grain overlay, so two apps sharing a palette do not share
	 *  a texture. */
	seed?: number;
	/** How to treat the above.
	 *
	 *  `animated-gradient` is the ONE value that selects a renderer rather than
	 *  describing one: it is the only way to ask for the WebGL field, because
	 *  mounting a GL context off the mere presence of a `gradient` key would let a
	 *  manifest opt a surface into one it never asked for. The token is spelled out
	 *  rather than reusing `gradient` precisely because `gradient` already exists
	 *  here and means a plain CSS ramp — an author reading "gradient" would
	 *  reasonably expect motion, and would silently not get it.
	 *
	 *  `dither` adds the grain overlay; `flat`/`image`/`gradient` are the author
	 *  naming which key they meant, and are descriptive only — what paints is
	 *  whichever value is actually present. */
	style?: "gradient" | "animated-gradient" | "dither" | "flat" | "image";
}

/** The animated gradient a listing declares, in the AUTHORED form — a preset
 *  name plus 0-100 slider overrides, exactly as the component's own docs write
 *  them. Untrusted: `preset`/`shape` are matched against closed sets, the colours
 *  go through `safeCssBackground` (they reach a CSS sink as well as the shader),
 *  and every number is clamped in `resolveAnimatedGradient` before it can become
 *  a GPU uniform. */
export interface CatalogBannerGradient {
	color1?: string;
	color2?: string;
	color3?: string;
	distortion?: number;
	offset?: number;
	/** One of `lava` | `prism` | `plasma` | `pulse` | `vortex` | `mist`; anything
	 *  else falls back to `prism`. */
	preset?: string;
	proportion?: number;
	rotation?: number;
	scale?: number;
	/** `checks` | `stripes` | `edge`, case-insensitive. */
	shape?: string;
	shapeSize?: number;
	softness?: number;
	speed?: number;
	swirl?: number;
	swirlIterations?: number;
}

/** A dithered-gradient background spec for a card's icon square, mirroring
 *  dither-kit's `DitherGradient` props. Carried verbatim from an untrusted catalog
 *  card, so every field is loose (`from`/`to` are a palette-colour NAME or a hue
 *  number, `direction` a loose string) — the render layer validates + falls back. */
export interface CardDither {
	direction?: string | null;
	from?: string | number | null;
	to?: string | number | null;
}

/** A theme listing's own palette, projected from its manifest's first
 *  `contributes.themes[].preview` — the same four swatch colours the Appearance
 *  tab's preset picker paints. The card renders it as the icon square instead of
 *  a dither avatar or a generic glyph: for a theme, the palette IS the identity.
 *  Loose strings on purpose (an untrusted card may declare any CSS colour); the
 *  render layer falls back when a swatch cannot be painted. */
export interface CardThemePreview {
	bg: string;
	/** The mode slot this theme fills (`"light"` | `"dark"`). */
	mode?: string | null;
	primary: string;
	surface: string;
	text: string;
}

/** Public, non-executable summary of one swappable capability a listing serves. */
export interface CatalogLayer {
	capability: string;
	selectable?: boolean;
	target?: string | null;
	title?: string | null;
	toolkit?: boolean;
	verbs?: string[];
}

/** Human-facing label shared by cards, detail heroes, and the provider picker. */
export function catalogLayerLabel(layer: CatalogLayer): string {
	const title = layer.title?.trim() || layer.capability;
	return `${title} ${layer.toolkit ? "toolkit" : "layer"}`;
}

/** Compact badges for a catalog card or detail hero. */
export function catalogLayerBadges(
	layers: CatalogLayer[] | null | undefined,
	external = false
): string[] {
	const labels = (layers ?? []).map(catalogLayerLabel);
	if (external) {
		labels.unshift("External");
	}
	return labels;
}

/** One row of the Versions tab. Sourced from published releases, falling back to
 *  git tags for a repo that tags without cutting releases (`tagOnly`). */
export interface CatalogVersion {
	/** Summed download count across the release's assets; 0 when unpublished. */
	downloads?: number | null;
	/** Manifest-declared maturity at this exact release ref. */
	installable?: boolean;
	name?: string | null;
	/** Release notes, already truncated upstream. */
	notes?: string | null;
	prerelease?: boolean;
	publishedAt?: string | null;
	/** Lowercase manifest stability value; `stable` is retained for history rows. */
	stability?: string | null;
	/** Whether the historical manifest was readable at this ref. */
	stabilityKnown?: boolean;
	/** True when this row came from a git tag with no matching release. */
	tagOnly?: boolean;
	url?: string | null;
	version: string;
}

/** A listing as it stood at ONE published version, read from its repository at
 *  that version's tag (`GET /api/plugins/catalog/version-detail`).
 *
 *  Carries ONLY signals that live in the repo and are therefore genuinely
 *  historical. Repository health — stars, open issues, archived, last-updated — is
 *  current-state, reported as of now, and is deliberately absent: showing it beside
 *  these fields would read as "the state at that version" while half of it
 *  described today. `atRef` names the tag it was read at so this can never be
 *  presented as anything but a snapshot. */
export interface VersionSnapshot {
	/** The git ref this was read at. */
	atRef?: string | null;
	description?: string | null;
	engines?: { ryu?: string | null } | null;
	license?: string | null;
	permissions?: unknown;
	readme?: string | null;
	readmeUrl?: string | null;
	/** Lowercase manifest stability value; absent means the manifest defaulted stable. */
	stability?: string | null;
	/** False when the ref could not be read as a manifest-backed snapshot. */
	stabilityKnown?: boolean;
	surfaceSupport?: CatalogSurfaceSupport[] | null;
	surfaces?: string[] | null;
	targets?: string[] | null;
	/** The version the manifest declared at that tag. */
	version?: string | null;
}

/** A named, described thing a plugin contributes (command, tool, agent, …).
 *  `name`/`description` are null when the manifest references an id it does not
 *  actually ship — surfaced, not hidden, so the health scan can flag it. */
export interface CatalogContribution {
	description?: string | null;
	id: string;
	name?: string | null;
}

/** One HTTP route a plugin's background service exposes. */
export interface CatalogRoute {
	auth?: string | null;
	methods?: string[];
	path: string;
}

/** A managed background process the plugin ships, and the HTTP surface it adds. */
export interface CatalogSidecar {
	lazy?: boolean;
	mount?: string | null;
	name: string;
	port?: number | null;
	publicMount?: string | null;
	routes?: CatalogRoute[];
}

/** A sidecar-declared model provider. This is display-only metadata for the
 * enable confirmation: the process spec and executable backend never cross the
 * catalog projection boundary. */
export interface CatalogModelProvider {
	api?: string | null;
	id: string;
	label?: string | null;
	models?: string[];
}

/** A stdio MCP server the plugin registers on enable. `envKeys` deliberately
 *  carries only the env variable NAMES — values are secrets by convention. */
export interface CatalogMcpServer {
	args?: string[];
	command?: string | null;
	description?: string | null;
	enabled?: boolean;
	envKeys?: string[];
	name: string;
}

/**
 * The **API surface** projected from a plugin's manifest — everything installing
 * it adds to the machine, structured for the detail page's reference tab.
 *
 * Projected by Core through an allowlist (`catalog_source::manifest_surface`), so
 * no field here can carry executable payload: tool backends, sidecar process
 * specs, and turn-hook code are dropped at the source.
 */
export interface CatalogApiSurface {
	agents?: CatalogContribution[];
	commands?: CatalogContribution[];
	composerControls?: {
		id: string;
		label?: string | null;
		type?: string | null;
	}[];
	mcpServers?: CatalogMcpServer[];
	modelProviders?: CatalogModelProvider[];
	policies?: CatalogContribution[];
	/** Capabilities this plugin serves to OTHER plugins via the broker. */
	provides?: {
		capability: string;
		route?: string | null;
		sidecar?: string | null;
	}[];
	runnables?: {
		description?: string | null;
		id: string;
		kind?: string | null;
		name?: string | null;
	}[];
	settingsTabs?: { icon?: string | null; id: string; title?: string | null }[];
	sidecars?: CatalogSidecar[];
	tools?: CatalogContribution[];
	/** What wakes this plugin up. */
	triggers?: {
		activationEvents?: string[];
		turnHooks?: {
			description?: string | null;
			event: string;
			id?: string | null;
		}[];
	};
	views?: {
		icon?: string | null;
		id: string;
		surface?: string | null;
		title?: string | null;
	}[];
	workflows?: CatalogContribution[];
}

/** The typed runtime permission set, summarized for display. `declared: false`
 *  means the manifest declared none — which is deny-all, the good case, and is
 *  distinct from "we don't know". */
export interface CatalogPermissions {
	childProcess?: unknown;
	declared: boolean;
	fs?: unknown;
	network?: unknown;
	tool?: unknown;
}

/** One catalog entry as the Apps section reads it. */
export interface CatalogEntry {
	accent_color?: string | null;
	author?: string | null;
	banner?: CatalogBanner | null;
	built_in?: boolean;
	capabilities?: string[];
	/** Which MARKETPLACE this row was browsed from, and how to name it in a
	 *  heading. Stamped by Core only in the all-marketplaces view (`?source=all`),
	 *  where the page is a concatenation of every source and the rows would
	 *  otherwise be indistinguishable.
	 *
	 *  Distinct from {@link source}, which is per-entry provenance (`"built-in"`, a
	 *  repo host, …) and does not name a browsable catalog. Absent whenever a single
	 *  source is selected — there is nothing to disambiguate then. */
	catalog_source_id?: string;
	catalog_source_name?: string;
	category?: string | null;
	/** The serving node's verdict on {@link engines}. Absent when the source is a
	 *  static feed that does not know what is running.
	 *
	 *  A client that knows its own surface version should NOT trust this blindly —
	 *  Core cannot observe desktop/island/mobile/extension/web, so it reports those
	 *  floors as advisory `unknown`. Re-evaluate with `evaluateCompatibility` and
	 *  the local version overlaid; that turns an advisory into a real refusal. */
	compatibility?: CompatibilityVerdict | null;
	description: string;
	descriptor_only?: boolean;
	developer?: string | null;
	/** Relative Ryu proxy route for the signed release asset. */
	download_url?: string | null;
	/** Public GitHub release-asset downloads, summed across every published
	 * release. The producer excludes signatures, manifests and text metadata so
	 * this is a count of distributable payloads rather than release bookkeeping. */
	downloads?: number | null;
	/** Host version floors this listing declares (the manifest's `engines`), one
	 *  semver requirement per surface. `ryu` is the CORE floor — the legacy
	 *  spelling, kept because every manifest in the wild uses it.
	 *
	 *  Absent = declares no floors. Present on the CARD, not just the detail, so a
	 *  grid can grey a tile without a detail fetch per tile. */
	engines?: HostFloors | null;
	example_prompts?: string[];
	/** True when the listing calls a hosted/external provider rather than a local runtime. */
	external?: boolean;
	/** Redacted GitHub repository/release provenance. */
	github_source?: Record<string, unknown> | null;
	homepage?: string | null;
	/** Icon-primitive glyph id (Iconify `prefix:name`, bare Hugeicons name, or URL),
	 *  masked with the current text colour. Distinct from `icon_url` (a raster logo);
	 *  wins over it on the card when both are present. */
	icon?: string | null;
	icon_background?: string | null;
	/** Dithered-gradient background for the icon square, in place of a flat
	 *  `icon_background`. Validated at render; an invalid spec falls back. */
	icon_dither?: CardDither | null;
	/** Inset + letterbox for the icon square (manifest `iconPadding`): one of
	 *  `none` | `sm` | `md` | `lg`. A raw string on the wire so an unknown value
	 *  cannot fail a parse; validated at render (`normalizeIconPadding`). */
	icon_padding?: string | null;
	icon_url?: string | null;
	id: string;
	/** True when this listing is INSTALLED but held back by an unmet floor.
	 *
	 *  Distinct from `compatibility.compatible === false` on a listing that is not
	 *  installed, which only means "you could not install this". This one means the
	 *  plugin is on disk and deliberately not running. */
	installed_but_incompatible?: boolean;
	integration_kind?: string | null;
	integration_url?: string | null;
	/** Search-oriented manifest keywords, kept separate from curated tags. */
	keywords?: string[];
	kinds: string[];
	/** Public layer summaries, never executable provider bindings. */
	layers?: CatalogLayer[];
	/** SPDX licence id, when the source reports one. */
	license?: string | null;
	/** This listing is REQUIRED FOR CORE: never render a Disable or Uninstall
	 *  control for it. Both are refused server-side with a 403 `"mandatory"` and no
	 *  force override, so showing the control only produces a dead button.
	 *
	 *  Core stamps this from its own `MANDATORY_PLUGINS` constant, NOT from the
	 *  manifest's claim of it — "cannot be disabled" is exactly the property a
	 *  hostile listing would assert about itself, so a remote catalog card that
	 *  carries this key is asserting something Core never agreed to. Only trust it
	 *  on a built-in (`source: "built-in"`) entry. */
	mandatory?: boolean;
	/** Server-derived A Major Pass inclusion marker for catalog presentation. */
	membership_included?: boolean;
	name: string;
	/** The PUBLISHING ORGANIZATION's identity has been verified by Ryu — the
	 *  X/Meta-style blue check.
	 *
	 *  THREE DISTINCT TRUST AXES ride on a listing and merging any two of them
	 *  mislabels honest software. Keep them apart:
	 *    1. `reviewed`     — did Ryu vet this LISTING's code? (drives the amber
	 *                        "Not reviewed by Ryu" notice)
	 *    2. `verification` — did this listing's manifest SIGNATURE verify? That is
	 *                        INSTALL TRUST, it lives on the web marketplace card
	 *                        (`apps/web/src/lib/marketplace-api.ts`, which owns the
	 *                        wire word `verified` on that payload) and a false there
	 *                        renders a destructive "Signature invalid" chip.
	 *    3. `org_verified` — is the PUBLISHING ORGANIZATION identity-verified? THIS
	 *                        field, and only this one.
	 *  The `org_` prefix is not decoration: it is what keeps axis 3 off axis 2's
	 *  wire word, where an org-identity `false` would have branded every listing
	 *  from an unverified publisher as cryptographically tampered.
	 *
	 *  All three combine freely. A verified org can publish an unreviewed community
	 *  listing, and an unverified individual can publish a reviewed one — both are
	 *  normal and both are rendered.
	 *
	 *  Derived SERVER-side from the org record (or the first-party/built-in signal
	 *  for Ryu's own listings). Never read a manifest's or a client's claim of it,
	 *  for the same reason `mandatory` is stamped from Core's own constant: "I am
	 *  who I say I am" is exactly the property a hostile listing asserts about
	 *  itself. The UI renders what it is handed and infers nothing. */
	org_verified?: boolean;
	/** Which verification tier the publishing org holds ("official", "partner",
	 *  "community"). Only meaningful when `org_verified` is true — a tier without
	 *  the flag renders nothing.
	 *
	 *  Typed as a plain string, not a union, for the same reason `stability` is: a
	 *  newer control plane may mint a tier this build has never heard of, and the
	 *  badge must still render (unqualified) rather than vanish.
	 *
	 *  CAUTION: the tier vocabulary includes "community", which is NOT the same
	 *  thing as `origin === "community"` — that is a listing-discovery fact, this
	 *  is an org-identity fact. Never render the bare tier word. */
	org_verified_tier?: string | null;
	/** Who listed this and how much vetting it had. `"community"` = discovered
	 *  automatically from a public GitHub topic and NOT reviewed by Ryu; absent or
	 *  null = first-party. Deliberately snake_case (it rides on the card, not the
	 *  detail) and deliberately fail-safe: an older wire never gains a scary label,
	 *  so a discovery source must opt in explicitly. Drives both the Community
	 *  store section and its trust notice — see `isCommunityEntry`. */
	origin?: "community" | "first_party" | null;
	/** SHA-256 of the immutable package release asset. */
	package_checksum?: string | null;
	/** Canonical portable package kind for GitHub-backed marketplace entries. */
	package_kind?: string | null;
	/** Commerce disclosure for a PAID listing, as the hosted marketplace reports it.
	 *  Absent/null = free. Present on cards in the unified first-party view, where
	 *  free (git catalog) and paid (hosted) listings sit side by side — without it a
	 *  paid item would be indistinguishable from a free one until checkout. Display
	 *  only: price is commerce metadata and is not an install/runtime decision. */
	pricing?: {
		amountMinor?: number;
		currency?: string;
		kind?: string;
	} | null;
	privacy_policy_url?: string | null;
	/** Which discovery source produced the listing (e.g. `"github-topic"`). */
	provenance?: string | null;
	/** Public publisher identity, when this card came from the hosted Marketplace. */
	publisher_org_id?: string | null;
	publisher_org_logo?: string | null;
	publisher_org_name?: string | null;
	publisher_org_slug?: string | null;
	/** Complete publisher identity mark when the serving catalog knows it.
	 *  `dotted` is explicit disclosure; absence preserves compatibility with
	 *  older Core catalog payloads that only carry `org_verified`. */
	publisher_trust?: PublisherTrustLevel | null;
	publisher_trust_source?: PublisherTrustSource | null;
	/** Public evidence behind the publisher mark, when the source provides it. */
	publisher_verification?: VerificationDetails | null;
	/** Denormalized rating aggregate (0–5 mean + count) so a card and the detail
	 *  header can show stars without loading the review list. Absent = unrated. */
	rating_average?: number | null;
	rating_count?: number | null;
	/** The repository this listing was discovered from (community listings). */
	repo_url?: string | null;
	/** Public source/repository URL declared by the listing. */
	repository_url?: string | null;
	/** Plugin-to-plugin dependencies this app needs enabled first (the manifest's
	 *  `requires`). Emitted by Core's catalog source when non-empty; absent = none.
	 *  Powers the "Requires these apps" section so the dependency chain is clear
	 *  before install (enabling this app auto-enables `apps`; uninstalling a
	 *  depended-on app prompts the cascade). */
	requires?: {
		apps?: { id: string; min_version?: string | null }[];
		grants?: string[];
	} | null;
	/** False when nobody at Ryu has vetted this listing. Absent = not applicable
	 *  (first-party). Never treat absent as "reviewed". */
	reviewed?: boolean;
	/** The bundled sub-items this item ships (agents/workflows/tools/skills/
	 *  companions/mcp) — the manifest runnables. Powers "What's included". */
	runnables?: { id: string; kind: string; name?: string }[];
	/** Host surfaces this listing runs on, flattened from the manifest's `surfaces`
	 *  map (or its older flat `targets` list) with any explicitly-unsupported
	 *  surface already removed.
	 *
	 *  snake_case-free single word, so it reads the same on the card payload (which
	 *  is snake_case) and the detail payload (camelCase) — see `origin` above and
	 *  `discoveredFrom` below for the casing contract this sits between.
	 *
	 *  Absent means NOT DECLARED, which the store shows as "runs everywhere". It
	 *  must never be rendered as "runs nowhere" — that is why Core omits the key
	 *  rather than emitting `[]`. Typed loosely for the same reason `surfaces` is on
	 *  the detail: a newer manifest may name a surface this build has not heard of,
	 *  and the card must carry it through rather than drop it. */
	/** Screenshot gallery declared by the listing manifest. */
	screenshots?: string[];
	source?: string;
	/** How finished this listing is: `"alpha"`, `"beta"`, `"rc"`, … Absent (or
	 *  `"stable"`, which the producer strips) means finished and renders no badge.
	 *
	 *  Typed as a plain string, not a union: a newer index may publish a tier this
	 *  build has never heard of, and it must render verbatim rather than be
	 *  dropped — the same tolerance `surfaces` settled on. */
	stability?: string | null;
	/** Upstream popularity signal (GitHub stars) for ranking unmoderated listings. */
	stars?: number | null;
	/** Per-surface support levels on the browse card. */
	surface_support?: CatalogSurfaceSupport[];
	surfaces?: string[];
	tagline?: string | null;
	tags: string[];
	terms_of_service_url?: string | null;
	/** A theme listing's own palette (manifest `contributes.themes[0].preview`).
	 *  The card paints this as its icon square instead of a dither avatar or a
	 *  generic glyph. Absent on everything that is not a theme. */
	theme_preview?: CardThemePreview | null;
	/** Explicit app-vs-plugin discriminator from the catalog. Preferred over the
	 *  legacy `kinds.includes("companion")` derivation when present. */
	type?: "app" | "plugin";
	version?: string;
	website?: string | null;
}

/** A catalog entry joined with its live lifecycle state (installed/enabled). */
export interface AppCatalogItem {
	/** The release train this INSTALLED listing follows (`stable`, `beta`,
	 *  `nightly`, …). Absent for a listing that is not installed, and for a host
	 *  whose lifecycle read predates channels. */
	channel?: string | null;
	enabled: boolean;
	entry: CatalogEntry;
	grants: string[];
	installed: boolean;
	/** The version actually ON THIS MACHINE, from the lifecycle record — not the
	 *  catalog entry's `version`, which is the newest PUBLISHED one and is exactly
	 *  what an out-of-date install differs from. Absent when not installed. */
	installedVersion?: string | null;
}

/** One release train a listing publishes, and the version it currently resolves
 *  to.
 *
 *  `installable` is the load-bearing field: a train read from a repository's git
 *  tags describes what an author TAGGED and can be browsed, while only a train the
 *  marketplace serves can actually be installed. Rendering both as selectable
 *  would produce a picker whose choice silently does nothing. */
export interface CatalogChannel {
	channel: string;
	installable?: boolean;
	version?: string | null;
}

/** Registry detail for a browse-only integration descriptor. */
export interface PluginCatalogDetail {
	accentColor?: string | null;
	/** The manifest's API surface — what installing this adds. Absent when the
	 *  source could not read a manifest. */
	apiSurface?: CatalogApiSurface | null;
	/** True when the source repository is archived (it will not receive fixes). */
	archived?: boolean;
	author?: string | null;
	banner?: CatalogBanner | null;
	/** True for a Core-shipped system plugin. */
	builtIn?: boolean;
	capabilities?: string[];
	category?: string | null;
	/** First publication timestamp, when the source reports one. */
	createdAt?: string | null;
	description?: string | null;
	descriptor?: { url?: string | null } | null;
	/** True when the listing is discovery-only: no verified in-store install path,
	 *  so the CTA links out to the repository instead. */
	descriptorOnly?: boolean;
	developer?: string | null;
	/** True when the source repository is disabled upstream. */
	disabled?: boolean;
	/** Provenance of a community listing: which GitHub topic surfaced it, and the
	 *  repository it came from. camelCase because it rides on the DETAIL payload
	 *  (the card is snake_case — see the casing note on `CatalogEntry`). */
	discoveredFrom?: { repositoryUrl?: string | null; topic: string } | null;
	domain?: string | null;
	/** Total downloads across all published release assets. */
	downloads?: number | null;
	/** Minimum Ryu version this plugin declares. */
	engines?: { ryu?: string | null } | null;
	/** Why enrichment fell short (e.g. no manifest at the repository root). Drives
	 *  the health scan's "reads cleanly" check — surfaced, never swallowed. */
	enrichmentError?: string | null;
	examplePrompts?: string[];
	/** Existing host capabilities and shell slots this listing extends. */
	extensions?: CatalogExtensionSummary[];
	external?: boolean;
	feeds?: string[] | null;
	forks?: number | null;
	iconBackground?: string | null;
	iconUrl?: string | null;
	/** Where the feature is implemented: Core runtime, shared shell, or package
	 *  process. Display-only; it is not an execution route. */
	implementation?: CatalogImplementationSummary[];
	/** False when the upstream issue tracker is turned off. */
	issuesEnabled?: boolean;
	keywords?: string[];
	layers?: CatalogLayer[];
	license?: string | null;
	/** The plugin id the discovered repo's own manifest CLAIMS. Surfaced separately
	 *  from the entry id on purpose, so an id-squatting repo can never masquerade
	 *  as a plugin you already have installed. */
	manifestId?: string | null;
	/** Where the manifest was read from (a raw repository URL). */
	manifestUrl?: string | null;
	/** Server-derived A Major Pass inclusion marker for catalog presentation. */
	membershipIncluded?: boolean;
	/** Count of open issues upstream. */
	openIssues?: number | null;
	/** The PUBLISHING ORGANIZATION's identity is verified. camelCase because it
	 *  rides on the DETAIL payload (the card spells it
	 *  `org_verified`/`org_verified_tier` — see the casing note on
	 *  `discoveredFrom`).
	 *
	 *  Same three-axis warning as on the card: this is neither `reviewed` (did Ryu
	 *  vet this listing's CODE) nor the web marketplace's `verification` (did the
	 *  manifest SIGNATURE verify — install trust, and the field that already owns
	 *  the bare word `verified` on that wire). This one is only "do we know who the
	 *  publisher is". Server-derived, never self-asserted. */
	orgVerified?: boolean;
	/** The publishing org's verification tier ("official" | "partner" |
	 *  "community"). Plain string on purpose — an unknown tier renders the badge
	 *  unqualified rather than dropping it. */
	orgVerifiedTier?: string | null;
	/** Who listed this. `"community"` = automatic discovery, nobody vetted it. */
	origin?: string | null;
	/** Opaque permission-grant ids the plugin asks the Gateway to approve. */
	permissionGrants?: string[];
	/** The typed runtime permission set Core lowers into the sandbox. */
	permissions?: CatalogPermissions | null;
	privacyPolicyUrl?: string | null;
	/** Complete publisher identity mark when the detail source knows it. */
	publisherTrust?: PublisherTrustLevel | null;
	publisherTrustSource?: PublisherTrustSource | null;
	/** Public evidence behind the publisher mark, when the detail source provides it. */
	publisherVerification?: VerificationDetails | null;
	/** Long-form documentation (markdown) read from the plugin's README. */
	readme?: string | null;
	readmeUrl?: string | null;
	repositoryUrl?: string | null;
	/** Plugin-to-plugin dependencies, mirroring the manifest's `requires`. */
	requires?: {
		apps?: { id: string; min_version?: string | null }[];
		grants?: string[];
	} | null;
	/** False when nobody at Ryu vetted this listing. */
	reviewed?: boolean;
	runnables?: { id: string; kind: string; name?: string }[];
	screenshots?: string[];
	stars?: number | null;
	/** Host surfaces this plugin declares support for (desktop, island, mobile, …).
	 *  Empty/absent means it is offered everywhere — never read it as "nowhere".
	 *
	 *  Typed as plain `string[]`, deliberately: a manifest written against a newer
	 *  Ryu may name a surface this build has never heard of, and the catalog must
	 *  carry it through rather than drop it. Use {@link Surface} when you need the
	 *  known set (e.g. to exhaustively label them). */
	surfaceSupport?: CatalogSurfaceSupport[];
	surfaces?: string[];
	tagline?: string | null;
	tags?: string[];
	termsOfServiceUrl?: string | null;
	/** Last upstream activity (a push or a release). */
	updatedAt?: string | null;
	url?: string | null;
	version?: string | null;
	/** Published version history, newest first. */
	versions?: CatalogVersion[] | null;
	watchers?: number | null;
	website?: string | null;
}

/** A selectable catalog source (Ryu Marketplace, integrations.sh, custom). */
export interface PluginCatalogSource {
	displayName: string;
	id: string;
}

/** Params to add a custom Claude plugin marketplace as a source. */
export interface AddMarketplaceParams {
	baseUrl: string;
	displayName: string;
	id: string;
}

/** One-step movement within the custom marketplace order. */
export type MarketplaceMoveDirection = "up" | "down";

// ---------------------------------------------------------------------------
// Skills realm
// ---------------------------------------------------------------------------

/** A Skill row in the left-hand selector, as the Skills section reads it. */
export interface SkillCard {
	/** Marketplace stamp added by Core in the all-marketplaces view. */
	catalogSourceId?: string | null;
	catalogSourceName?: string | null;
	/** One-line "what this does". Present for INSTALLED cards (read from the
	 *  on-disk SKILL.md front matter) and on the detail card; absent for a browse
	 *  result, because skills.sh's search payload carries no description. Cards
	 *  fall back to the source + install count when it is missing. */
	description?: string | null;
	downloads?: number;
	id: string;
	installed: boolean;
	installs: number;
	name: string;
	slug: string;
	source: string;
	/** Registry-level trust claim: builtin, trusted, or community. */
	trustLevel?: string | null;
}

/** A file inside a Skill package. */
export interface SkillFile {
	contents?: string;
	path: string;
}

/** One security audit row shown in the skill detail metadata grid. */
export interface SkillAudit {
	audited_at?: string | null;
	name: string;
	risk_level?: string | null;
	status: string;
	summary?: string | null;
	url: string | null;
}

/** The metadata block for a selected skill. Always an object (never null) — the
 *  detail panel dereferences its fields unconditionally, so a read-only surface
 *  fabricates this with null fields + an empty `securityAudits` array. */
export interface SkillDetailMetadata {
	firstSeen: string | null;
	githubCreatedAt: string | null;
	githubPushedAt: string | null;
	githubStars: string | null;
	githubUpdatedAt: string | null;
	installs: string | null;
	repositoryUrl: string | null;
	securityAudits: SkillAudit[];
}

/** Full right-hand detail payload for a selected Skill. */
export interface SkillDetail {
	card: SkillCard;
	description: string | null;
	files: SkillFile[];
	metadata: SkillDetailMetadata;
	readme: string | null;
	url: string;
}

/** One selectable skills catalog source (registries + custom marketplaces). */
export interface SkillCatalogSource {
	baseUrl?: string | null;
	builtin?: boolean;
	displayName: string;
	id: string;
}

/** Sort order for the skills list. */
export type SkillSort = "popular" | "name";

/** What the Skills section consumes from its injected data hook. The unread
 *  `installedSkills` field on the desktop hook is intentionally omitted — the
 *  section reads only the derived `enabledByKey`. */
export interface SkillsCatalogState {
	activeSource: string;
	addingMarketplace: boolean;
	addMarketplace: (params: AddMarketplaceParams) => Promise<void>;
	detail: SkillDetail | null;
	detailError: string | null;
	detailLoading: boolean;
	/** Enabled (active) state keyed by installed skill id/slug. */
	enabledByKey: Record<string, boolean>;
	error: string | null;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	install: () => Promise<void>;
	installedOnly: boolean;
	/** Id of the skill whose install is in flight, or `null`. */
	installing: string | null;
	loading: boolean;
	org: string;
	query: string;
	removeMarketplace: (id: string) => Promise<void>;
	reorderMarketplace: (
		id: string,
		direction: MarketplaceMoveDirection
	) => Promise<void>;
	select: (id: string) => void;
	selectedId: string | null;
	selectingSource: boolean;
	selectSource: (id: string) => void;
	setInstalledOnly: (v: boolean) => void;
	setOrg: (o: string) => void;
	setQuery: (q: string) => void;
	setSkillEnabled: (id: string, active: boolean) => Promise<void>;
	setSort: (s: SkillSort) => void;
	skills: SkillCard[];
	sort: SkillSort;
	sources: SkillCatalogSource[];
	/** Id of the skill whose enable/disable toggle is in flight, or `null`. */
	togglingSkill: string | null;
}

/** What the Apps section consumes from its injected data hook. */
export interface AppsCatalogState {
	activeSource: string;
	addingMarketplace: boolean;
	addMarketplace: (params: AddMarketplaceParams) => Promise<void>;
	detail: PluginCatalogDetail | null;
	detailError: string | null;
	detailLoading: boolean;
	error: string | null;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	/** Add a listing. A card passes its own id; the detail panel may omit it and
	 *  act on the current selection.
	 *
	 *  `options.channel` installs from a prerelease train instead of the stable
	 *  release, and the node PERSISTS that choice — the listing keeps following the
	 *  train on later updates rather than being pulled back to stable. */
	install: (
		id?: string,
		options?: { channel?: string | null }
	) => Promise<void>;
	installFromUrl: (url: string) => Promise<void>;
	/** The id whose add is in flight, or null. Carries identity on purpose: as a
	 *  bare boolean it followed the SELECTION, so the spinner moved to whatever
	 *  listing the user opened next. Matches `SkillsCatalogState.installing`. */
	installing: string | null;
	/** Install or update one exact historical version from the Versions tab. */
	installVersion?: (id: string, version: CatalogVersion) => Promise<void>;
	items: AppCatalogItem[];
	lifecyclePending: boolean;
	loading: boolean;
	loadingMore: boolean;
	query: string;
	select: (id: string) => void;
	selectedId: string | null;
	selectedItem: AppCatalogItem | null;
	selectingSource: boolean;
	selectSource: (id: string) => void;
	setEnabled: (enabled: boolean) => Promise<void>;
	setQuery: (q: string) => void;
	sources: PluginCatalogSource[];
	/** Move an INSTALLED listing onto another release train, and to that train's
	 *  current build. `null` returns it to stable.
	 *
	 *  A distinct verb from `install` on purpose: switching is an update of
	 *  something already present, and it can move the install BACKWARDS (every
	 *  prerelease sorts below its stable release), which an install path has no
	 *  business doing silently. Optional — a host with no update seam omits it and
	 *  the switch control never renders. */
	switchChannel?: (id: string, channel: string | null) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Models realm
//
// Structural subsets of the desktop model-catalog types (apps/desktop/src/lib/
// api/models.ts + useModelCatalog). They declare ONLY the fields the Models
// section reads, so the desktop concrete hook result (a superset) stays
// structurally assignable when injected through the host, and web fabricates
// exactly these fields from its federated catalog.
// ---------------------------------------------------------------------------

/** How the catalog list is ordered. */
export type ModelSort = "trending" | "downloads" | "likes" | "recent";

/** Model weight format (which engine family can serve it). */
export type ModelFormat = "gguf" | "safetensors" | "mlx";

/** Friendly model category shown in the task filter. */
export type ModelCategory =
	| "all"
	| "chat"
	| "vision"
	| "embedding"
	| "reranker"
	| "stt"
	| "tts";

/** Plain-language device-fit verdict, worst → best. */
export type FitVerdict =
	| "too_big"
	| "cpu"
	| "partial"
	| "ok"
	| "great"
	| "unknown";

/** One selectable model catalog source (Hugging Face + mirrors). */
export interface ModelCatalogSource {
	displayName: string;
	id: string;
}

/** A model row in the left-hand selector / detail header. */
export interface ModelCard {
	architecture: string | null;
	author: string;
	compatible: boolean;
	contextLength: number | null;
	createdAt: string | null;
	downloads: number;
	format: ModelFormat;
	gated: boolean;
	id: string;
	installed: boolean;
	lastModified: string | null;
	likes: number;
	name: string;
	needsEngine: string | null;
	params: number | null;
	pipelineTag: string | null;
	tags: string[];
}

/** One downloadable file of a model (a GGUF quantization). */
export interface ModelFile {
	filename: string;
	fit: FitVerdict;
	fitLabel: string;
	installed: boolean;
	quant: string | null;
	sizeBytes: number | null;
	sizeHuman: string;
}

/** Independent benchmark stats from Artificial Analysis (when available). */
export interface AaStats {
	intelligenceIndex: number | null;
	matchedName: string;
	outputTokensPerSecond: number | null;
	priceUsdPer1m: number | null;
	timeToFirstTokenS: number | null;
}

/** Detected hardware the fit verdicts were computed against. */
export interface DeviceInfo {
	gpuName: string | null;
	os: string;
	ramHuman: string;
	unifiedMemory: boolean;
	vramBytes: number | null;
	vramHuman: string;
}

/** Full right-hand detail payload for a selected model. */
export interface ModelDetail {
	card: ModelCard;
	device: DeviceInfo;
	files: ModelFile[];
	format: ModelFormat;
	readme: string | null;
	repoFitLabel: string;
	repoSizeBytes: number | null;
	stats: AaStats | null;
	statsApiKeyPresent: boolean;
	vision: boolean;
}

/** One installed model by local stem; `finetuneBase` set only for merged fine-tunes. */
export interface InstalledModelEntry {
	finetuneBase: string | null;
	stem: string;
}

/** On-demand llmfit hardware fit + tok/s estimate for one model. */
export interface LlmFitEstimate {
	fit_level: string | null;
	installed: boolean;
	matched: boolean;
	min_vram_gb: number | null;
	path: string | null;
	tps: number | null;
}

/** What the Models section consumes from its injected data hook. */
export interface ModelCatalogState {
	activeSource: string;
	browseOrg: (o: string) => void;
	category: ModelCategory;
	detail: ModelDetail | null;
	detailError: string | null;
	detailLoading: boolean;
	error: string | null;
	fetchNextPage: () => void;
	format: ModelFormat;
	hasNextPage: boolean;
	install: (file: string) => Promise<void>;
	installedOnly: boolean;
	installing: string | null;
	installingSnapshot: boolean;
	installSnapshot: () => Promise<void>;
	loading: boolean;
	loadingMore: boolean;
	models: ModelCard[];
	org: string;
	query: string;
	select: (id: string) => void;
	selectedId: string | null;
	selectingSource: boolean;
	selectSource: (id: string) => void;
	setCategory: (c: ModelCategory) => void;
	setFormat: (f: ModelFormat) => void;
	setInstalledOnly: (v: boolean) => void;
	setOrg: (o: string) => void;
	setQuery: (q: string) => void;
	setSort: (s: ModelSort) => void;
	sort: ModelSort;
	sources: ModelCatalogSource[];
	uninstall: (file: string) => Promise<void>;
	uninstalling: string | null;
}
