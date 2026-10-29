"use client";

import { cn } from "@ryu/ui/lib/utils";
import dynamic from "next/dynamic";
import { STATIC_FIGURES } from "./iso/figures/static/registry.tsx";
import { landingSectionClass } from "./landing-typography.ts";

/**
 * Interactive anatomy figures a page can feature after its hero. Each one is loaded on
 * demand, so pages without a figure ship none of their code or styles.
 */
const FIGURES = {
	"core-engines": dynamic(() =>
		import("./iso/figures/core-engines/figure.tsx").then(
			(module) => module.CoreEnginesFigure
		)
	),
	"gateway-pipeline": dynamic(() =>
		import("./iso/figures/gateway-pipeline/figure.tsx").then(
			(module) => module.GatewayPipelineFigure
		)
	),
	"passport-cabinet": dynamic(() =>
		import("./iso/figures/passport-cabinet/figure.tsx").then(
			(module) => module.PassportCabinetFigure
		)
	),
	"sandbox-glovebox": dynamic(() =>
		import("./iso/figures/sandbox-glovebox/figure.tsx").then(
			(module) => module.SandboxGloveboxFigure
		)
	),
	"workflow-run": dynamic(() =>
		import("./iso/figures/workflow-run/figure.tsx").then(
			(module) => module.WorkflowRunFigure
		)
	),
	// Static drawings: no interaction, drawn once.
	...STATIC_FIGURES,
} as const;

export type ProductFigureId = keyof typeof FIGURES;

/**
 * Every figure sits straight on the page: no card, border, shadow, or padding. The
 * drawing is capped in height so it never dominates the page; its width comes only from
 * the wrappers below, so all figures share one scale.
 *
 * A hero's visual slot draws a muted rounded frame; a slot holding a figure drops it,
 * scoped by `:has()` so every other hero visual keeps its frame. The products overview
 * links each featured tile (`a > [data-product-visual]`): there the figure keeps the
 * shared frame like its neighbours, with its occluding paper matched to the frame tone.
 *
 * These rules are plain (unlayered) CSS on purpose: the kit's and each figure's own
 * stylesheets are unlayered too, so Tailwind's layered utilities could not override them.
 */
const overviewPaper = "color-mix(in oklab,var(--muted) 40%,var(--background))";
const bareFigureCss = [
	"[data-product-figure] .iso-svg{margin-inline:auto;max-height:min(520px,70vh)}",
	"[data-product-visual]:not(a>[data-product-visual]):has(>[data-product-figure]){overflow:visible;border-radius:0;background:transparent;padding:0}",
	"a>[data-product-visual]>[data-product-figure]{max-width:22rem;padding:1rem 0}",
	// Core's drawing fills only the middle of its viewBox. On wide screens, where the
	// gutter absorbs the scaled box, the hero draws it larger to match its neighbours.
	'@media (min-width:1280px){:not(a)>[data-product-visual]>[data-product-figure="core-engines"] .iso-svg{transform:scale(1.25)}}',
	// On phones the hero column is narrow, so the wide drawings come out short. Core is
	// scaled up and its empty side bands clipped; the Gateway line and the workflow run
	// trim the empty bands above and below their drawings instead.
	'@media (max-width:639px){:not(a)>[data-product-visual]>[data-product-figure="core-engines"]{overflow-x:clip}:not(a)>[data-product-visual]>[data-product-figure="core-engines"] .iso-svg{transform:scale(1.35);transform-origin:center}:not(a)>[data-product-visual]>:is([data-product-figure="gateway-pipeline"],[data-product-figure="workflow-run"]) .iso-svg{margin-block:-1.5rem}}',
	// The Gateway rail is a long thin diagonal: on phones it is drawn larger (its empty
	// ends clipped) so it carries the same weight as Core; the tall cabinet and glovebox
	// are capped so they do not run the full screen height.
	'@media (max-width:639px){:not(a)>[data-product-visual]>[data-product-figure="gateway-pipeline"]{overflow-x:clip}:not(a)>[data-product-visual]>[data-product-figure="gateway-pipeline"] .iso-svg{transform:scale(1.25);transform-origin:center}:not(a)>[data-product-visual]>:is([data-product-figure="passport-cabinet"],[data-product-figure="sandbox-glovebox"]){max-width:18rem!important}}',
	`a>[data-product-visual] .iso.iso-quiet{--anatomy-paper:${overviewPaper};--anatomy-page:${overviewPaper};--anatomy-card:${overviewPaper}}`,
].join("");

function BareFigureStyle() {
	return (
		<style href="ryu-product-figure-bare" precedence="default">
			{bareFigureCss}
		</style>
	);
}

/**
 * The widest a hero figure may draw. Each drawing has its own aspect ratio, so one
 * shared width would leave the wide ones (Core's shelf, the Gateway line) as thin
 * sketches and the tall ones (Passport's cabinet, the glovebox) towering over the
 * headline. Capping only the tall ones gives every hero figure about the same height
 * (roughly 270-300px in a desktop hero column).
 */
const HERO_MAX_WIDTH: Partial<Record<ProductFigureId, string>> = {
	"passport-cabinet": "24rem",
	"sandbox-glovebox": "23rem",
};

/**
 * A figure on its own, for a page's hero visual slot, sized so every hero figure
 * carries about the same visual weight. Use {@link ProductFigureSection} for a
 * standalone section.
 */
export function ProductFigure({ figure }: { figure: ProductFigureId }) {
	const Figure = FIGURES[figure];
	return (
		<div
			className="mx-auto w-full"
			data-product-figure={figure}
			// Inline so the hero frame's own child sizing cannot override the cap.
			style={{ maxWidth: HERO_MAX_WIDTH[figure] ?? "100%" }}
		>
			<BareFigureStyle />
			<Figure />
		</div>
	);
}

/** Figures whose drawing is a long diagonal: shown narrower so the band stays tight. */
const COMPACT_BY_DEFAULT: ReadonlySet<ProductFigureId> = new Set([
	"workflow-run",
]);

/**
 * One full-width section holding a figure directly on the page background. It
 * follows the hero, so it drops the top padding and keeps a short bottom band:
 * the drawing reads as part of the hero, not as an empty section.
 */
export function ProductFigureSection({
	figure,
	compact,
}: {
	figure: ProductFigureId;
	/** Narrow the figure so a tall drawing stays within one screen. */
	compact?: boolean;
}) {
	const Figure = FIGURES[figure];
	const narrow = compact ?? COMPACT_BY_DEFAULT.has(figure);
	return (
		<section
			className={cn(
				landingSectionClass,
				"pt-0 md:pt-0 md:pb-16 lg:pt-0 lg:pb-16"
			)}
			data-product-figure={figure}
			data-testid="product-figure"
		>
			<BareFigureStyle />
			<div className={cn("mx-auto w-full", narrow ? "max-w-xl" : "max-w-3xl")}>
				<Figure />
			</div>
		</section>
	);
}

/** A figure section that follows a stage hero, spaced off the dark stage. */
export function StageFigure({ figure }: { figure: ProductFigureId }) {
	return (
		<div className="pt-16 md:pt-24">
			<ProductFigureSection figure={figure} />
		</div>
	);
}
