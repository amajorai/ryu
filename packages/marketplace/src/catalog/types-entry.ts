// packages/marketplace/src/catalog/types-entry.ts
//
// The Apps catalog entry and its lifecycle-joined item.
// Split out of `types.ts`, which re-exports everything here so existing import
// paths keep working.
//
// test-exempt: type-only declarations with no runtime behavior; `types.ts` re-exports them
// and the catalog section tests exercise them through that facade.

import type { VerificationDetails } from "@ryu/ui/components/verification-popover.tsx";
import type {
	PublisherTrustLevel,
	PublisherTrustSource,
} from "@ryuhq/protocol/publisher-trust";
import type { z } from "zod";
import type {
	CatalogSurfaceSupport,
	CompatibilityVerdict,
	HostFloors,
} from "./types-compatibility.ts";
import type { CatalogLayer } from "./types-layers.ts";
import type {
	CardDither,
	CardThemePreview,
	CatalogBanner,
	CatalogDeprecation,
	CatalogRemixSource,
} from "./types-presentation.ts";

/** One catalog entry as the Apps section reads it. */
export interface CatalogEntry {
	accent_color?: string | null;
	/** Whether the author allows remixes (manifest `allowRemix`). Absent or null
	 *  means allowed; only `false` opts out. See `remixPlan`. */
	allow_remix?: boolean | null;
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
	/** Deprecation notice; see {@link CatalogDeprecation}. Absent = current. */
	deprecated?: CatalogDeprecation | null;
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
	github_source?: Record<string, z.output<ReturnType<typeof z.json>>> | null;
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
	/** The listing this one remixes, credited by its manifest `remixedFrom`. */
	remixed_from?: CatalogRemixSource | null;
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
