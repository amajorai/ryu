/** H1: hero headlines only. */
export const landingHeadlineClass =
	"text-balance font-heading font-medium text-[2.5rem] text-foreground leading-[1.05] tracking-[-0.035em] md:text-5xl lg:text-[4rem] lg:leading-[1.02]";

/** Lead text: hero subhead, section subtitle, feature-row body. */
export const landingSubheadlineClass =
	"mt-6 max-w-2xl text-pretty text-base text-muted-foreground leading-relaxed md:text-lg";

/** Subheadline without top margin when the parent controls spacing. */
export const landingSubheadlineBodyClass =
	"max-w-2xl text-pretty text-base text-muted-foreground leading-relaxed md:text-lg";

/** Horizontal shell shared by every public section and the footer: one left edge. */
export const landingContainerClass = "mx-auto w-full max-w-6xl px-6";

/**
 * Shell for every non-hero marketing section. Sections are separated by whitespace
 * only; `landing-section` lets public-pages.css shorten the top padding where two
 * sections touch, so the gap between them is not two full paddings.
 */
export const landingSectionClass =
	"landing-section mx-auto w-full max-w-6xl px-6 py-16 md:py-24 lg:py-28";

/** Shell for marketing heroes. */
export const landingHeroSectionClass =
	"landing-section mx-auto w-full max-w-6xl px-6 pt-12 pb-10 md:pt-28 md:pb-24";

/**
 * Row of paired CTA pills. Below sm the pills stack full width, so a long label never
 * leaves its partner wrapped alone on a second line.
 */
export const landingCtaRowClass =
	"flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4 max-sm:[&>*]:w-full max-sm:[&>[data-slot=button-group]>a]:flex-1";
