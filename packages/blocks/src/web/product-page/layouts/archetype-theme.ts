import type { FactSheetColumns } from "../../page-sections/fact-sheet.tsx";
import type {
	ProductArchetypeId,
	ProductSectionKey,
} from "../profile-types.ts";
import type { AtAGlanceLayout } from "../sections/at-a-glance.tsx";
import type { ProductCodeLayout } from "../sections/code-sample.tsx";

/**
 * How each archetype looks below the hero, beyond its section order: the
 * vertical rhythm, which sections sit on a full-bleed band, and the layout of
 * the shared sections. Data only, so the layout and its tests read one table.
 */

/** `muted`: a tinted band whose cards turn to the page colour; `inverse`: a dark island. */
export type SectionBand = "muted" | "inverse";

/**
 * - `standard`: today's spacing (touching sections share one generous pause);
 * - `dense`: reference pages, tighter sections and gaps (APIs, builders);
 * - `airy`: short pages that breathe (workspaces, previews).
 */
export type ArchetypeRhythm = "standard" | "dense" | "airy";

export interface ArchetypeTheme {
	readonly atAGlance: {
		readonly columns: FactSheetColumns;
		readonly layout: AtAGlanceLayout;
	};
	readonly bands: Readonly<Partial<Record<ProductSectionKey, SectionBand>>>;
	readonly codeLayout: ProductCodeLayout;
	readonly rhythm: ArchetypeRhythm;
	/** The band behind the archetype's side-by-side pair, if it has one. */
	readonly sideBySideBand?: SectionBand;
}

export const ARCHETYPE_THEMES: Readonly<
	Record<ProductArchetypeId, ArchetypeTheme>
> = {
	// A datasheet: spec band, flow diagram, a dark terminal where a control says no.
	infrastructure: {
		rhythm: "standard",
		bands: { "at-a-glance": "muted", guardrail: "inverse" },
		atAGlance: { layout: "spec", columns: 2 },
		codeLayout: "stacked",
	},
	// A developer reference: code beside the interfaces on one band, then tables.
	"agent-api": {
		rhythm: "dense",
		bands: { limits: "muted", guardrail: "inverse" },
		atAGlance: { layout: "sheet", columns: 4 },
		codeLayout: "column",
		sideBySideBand: "muted",
	},
	// Code first: the page opens on a dark code band, then a copyable quickstart.
	builder: {
		rhythm: "dense",
		bands: { code: "inverse", "at-a-glance": "muted" },
		atAGlance: { layout: "sheet", columns: 4 },
		codeLayout: "lead",
	},
	// The product itself first: a tabbed explorer, then where it runs.
	workspace: {
		rhythm: "airy",
		bands: { availability: "muted" },
		atAGlance: { layout: "sheet", columns: 3 },
		codeLayout: "stacked",
	},
	// A directory: the listing kinds on a band, everything else quiet.
	catalog: {
		rhythm: "standard",
		bands: { catalog: "muted" },
		atAGlance: { layout: "sheet", columns: 3 },
		codeLayout: "stacked",
	},
	// Deliberately short: the status board on a band, then the essentials.
	preview: {
		rhythm: "airy",
		bands: { "status-board": "muted" },
		atAGlance: { layout: "sheet", columns: 2 },
		codeLayout: "stacked",
	},
};

/**
 * Band surfaces. Cards inside a muted band (`data-product-card`) switch to the
 * page colour so they lift off the tint, and lower-emphasis cards
 * (`data-product-card-tone="quiet"`) keep a fainter step so a column's tonal
 * hierarchy survives the band; an inverse band scopes the dark theme
 * tokens, so everything inside reads as a dark island in either theme. On a
 * dark page (`dark:` matches only inside an outer `.dark`) the island lifts one
 * step to the muted surface so it still stands apart from the page.
 */
export const BAND_CLASSES: Readonly<Record<SectionBand, string>> = {
	muted:
		"bg-muted/60 [&_[data-product-card]]:bg-background [&_[data-product-card][data-product-card-tone=quiet]]:bg-background/40",
	inverse: "dark bg-card text-foreground dark:bg-muted",
};

/*
 * Rhythm. Every body section is wrapped in a slot (`data-product-slot`, "plain"
 * or "band"), so public-pages.css's `.landing-section + .landing-section` rule
 * no longer sees touching sections; these selectors restore it per archetype.
 * Band slots keep their full padding so the tint has room on both edges.
 */
const STANDARD_RHYTHM =
	"[&>[data-product-slot=plain]+[data-product-slot=plain]>.landing-section]:pt-8 md:[&>[data-product-slot=plain]+[data-product-slot=plain]>.landing-section]:pt-12 lg:[&>[data-product-slot=plain]+[data-product-slot=plain]>.landing-section]:pt-14";

const DENSE_RHYTHM =
	"[&>[data-product-slot=plain]>.landing-section]:py-12 md:[&>[data-product-slot=plain]>.landing-section]:py-16 lg:[&>[data-product-slot=plain]>.landing-section]:py-20 [&>[data-product-slot=plain]+[data-product-slot=plain]>.landing-section]:pt-4 md:[&>[data-product-slot=plain]+[data-product-slot=plain]>.landing-section]:pt-6 lg:[&>[data-product-slot=plain]+[data-product-slot=plain]>.landing-section]:pt-8";

const AIRY_RHYTHM =
	"[&>[data-product-slot=plain]+[data-product-slot=plain]>.landing-section]:pt-12 md:[&>[data-product-slot=plain]+[data-product-slot=plain]>.landing-section]:pt-16 lg:[&>[data-product-slot=plain]+[data-product-slot=plain]>.landing-section]:pt-20";

export const RHYTHM_CLASSES: Readonly<Record<ArchetypeRhythm, string>> = {
	standard: STANDARD_RHYTHM,
	dense: DENSE_RHYTHM,
	airy: AIRY_RHYTHM,
};
