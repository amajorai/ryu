// packages/marketplace/src/catalog/types-presentation.ts
//
// Presentational listing descriptors: banner, card dither, theme preview,
// remix credit, and deprecation notice.
// Split out of `types.ts`, which re-exports everything here so existing import
// paths keep working.
//
// test-exempt: type-only declarations with no runtime behavior; `types.ts` re-exports them
// and the catalog section tests exercise them through that facade.

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

/** A listing's deprecation notice, normalised by the producer from the
 *  manifest's `deprecated` (`true`, a message string, or `{message,
 *  replacement}`). Present — even as `{}` — means deprecated; absent/null means
 *  current. The same single-word key rides the snake_case card and the
 *  camelCase detail. */
/** The listing a remix credits (manifest `remixedFrom`). Untrusted catalog
 *  JSON: render only after checking both strings. */
export interface CatalogRemixSource {
	id?: string | null;
	kind?: string | null;
	version?: string | null;
}

export interface CatalogDeprecation {
	/** Why it is deprecated, in the publisher's words. */
	message?: string | null;
	/** Id of the listing that supersedes this one. Display only. */
	replacement?: string | null;
}
