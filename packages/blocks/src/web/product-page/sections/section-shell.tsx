import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import { landingSectionClass } from "../../landing-typography.ts";
import { SectionTitle, type SectionTitleSize } from "../../section-title.tsx";

/** The small muted line above a section title ("Architecture", "Guardrails"). */
export const sectionKickerClass = "font-medium text-muted-foreground text-sm";

/** Body copy inside product sections: one step below the lead size. */
export const sectionBodyClass =
	"text-pretty text-muted-foreground text-sm leading-relaxed md:text-base";

/** Item titles inside product sections (cards, rows, steps). */
export const sectionItemTitleClass =
	"font-heading font-medium text-base text-foreground";

/** A mono chip for kinds, states and paths: text first, never colour alone. */
export const sectionChipClass =
	"inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 font-mono text-muted-foreground text-xs";

/**
 * A tinted card. Public pages separate flat content by spacing and tone, not
 * outlines (public-pages.css strips borders from content `div`s), so cards
 * read as a quiet muted surface.
 */
export const sectionSurfaceClass = "rounded-2xl bg-muted/50";

/**
 * A section header: optional kicker, the title, an optional lead, and an
 * optional aside (a count, a link) that sits at the right edge from md up.
 */
export function ProductSectionHeader({
	title,
	kicker,
	subtitle,
	aside,
	size = "default",
	className,
}: {
	title: string;
	kicker?: string;
	subtitle?: string;
	aside?: ReactNode;
	size?: SectionTitleSize;
	className?: string;
}) {
	return (
		<header
			className={cn(
				"mb-10 flex flex-col gap-6 md:mb-12 md:flex-row md:items-end md:justify-between",
				className
			)}
		>
			<div className="min-w-0 max-w-2xl">
				{kicker ? (
					<p className={cn(sectionKickerClass, "mb-4")}>{kicker}</p>
				) : null}
				<SectionTitle size={size} title={title} />
				{subtitle ? (
					<p className={cn(sectionBodyClass, "mt-4 max-w-xl")}>{subtitle}</p>
				) : null}
			</div>
			{aside ? <div className="shrink-0">{aside}</div> : null}
		</header>
	);
}

/** The `<section>` every product-page section renders: the shared shell plus its marker. */
export function ProductSection({
	testId,
	className,
	children,
}: {
	testId: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<section
			className={cn(landingSectionClass, className)}
			data-testid={testId}
		>
			{children}
		</section>
	);
}
