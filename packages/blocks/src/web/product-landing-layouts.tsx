import type { ReactNode } from "react";
import { StageFade } from "./backgrounds/stage-fade.tsx";
import { landingVisualFrameClass } from "./landing-card-tones.ts";
import {
	landingCtaRowClass,
	landingHeadlineClass,
	landingHeroSectionClass,
	landingSubheadlineClass,
} from "./landing-typography.ts";

/**
 * The stage hero: one centred column over an animated backdrop, filling the
 * first viewport under the floating site header, like the landing hero. It is
 * always in the dark scheme, because the backdrops are light drawn on black. A
 * soft scrim behind the copy keeps it legible over the busier effects.
 */
function ProductStageHero({
	actions,
	background,
	eyebrow,
	subtitle,
	title,
}: {
	actions: ReactNode;
	background: ReactNode;
	eyebrow: string;
	subtitle: string;
	title: string;
}) {
	return (
		<section
			className="relative isolate flex min-h-svh flex-col overflow-hidden bg-background text-foreground"
			data-product-hero-layout="stage"
		>
			{background}
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 z-[1] bg-[radial-gradient(ellipse_60%_45%_at_50%_50%,color-mix(in_oklab,var(--background)_55%,transparent),transparent)]"
			/>
			<StageFade />
			<div className="pointer-events-none relative z-[2] mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center px-6 pt-28 pb-20 text-center [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
				<p className="mb-4 font-medium text-muted-foreground text-sm">
					{eyebrow}
				</p>
				<h1 className={landingHeadlineClass}>{title}</h1>
				<p className={`${landingSubheadlineClass} mx-auto`}>{subtitle}</p>
				<div className={`mt-10 ${landingCtaRowClass} sm:justify-center`}>
					{actions}
				</div>
			</div>
		</section>
	);
}

export function ProductHeroFrame({
	actions,
	background,
	eyebrow,
	subtitle,
	title,
	visual,
}: {
	actions: ReactNode;
	/** An animated backdrop: the hero becomes a full-viewport stage without the visual. */
	background?: ReactNode;
	eyebrow: string;
	subtitle: string;
	title: string;
	/** Optional: without a visual the hero is a single text column. */
	visual?: ReactNode;
}) {
	if (background) {
		return (
			<ProductStageHero
				actions={actions}
				background={background}
				eyebrow={eyebrow}
				subtitle={subtitle}
				title={title}
			/>
		);
	}
	const hasVisual = Boolean(visual);
	return (
		<section
			className={landingHeroSectionClass}
			data-product-hero-layout="showcase"
		>
			<div
				className={
					hasVisual
						? "grid items-center gap-10 lg:grid-cols-2 lg:gap-16"
						: undefined
				}
			>
				{/* Without a visual the hero is one centred column, so the empty half reads as intentional. */}
				<div
					className={
						hasVisual
							? "min-w-0 max-w-2xl"
							: "mx-auto min-w-0 max-w-3xl text-center"
					}
				>
					<p className="mb-4 font-medium text-muted-foreground text-sm">
						{eyebrow}
					</p>
					<h1 className={landingHeadlineClass}>{title}</h1>
					<p
						className={
							hasVisual
								? landingSubheadlineClass
								: `${landingSubheadlineClass} mx-auto`
						}
					>
						{subtitle}
					</p>
					<div
						className={
							hasVisual
								? `mt-10 ${landingCtaRowClass}`
								: `mt-10 ${landingCtaRowClass} sm:justify-center`
						}
					>
						{actions}
					</div>
				</div>
				{/* Visuals stretch to the frame, except a fixed-width phone (PhoneFrame's w-56), which keeps its portrait size. */}
				{hasVisual ? (
					<div
						className={`${landingVisualFrameClass} flex min-w-0 items-center justify-center [&>*]:w-full [&>*]:max-w-3xl [&>.w-56]:w-56 [&>[data-minimal-card]]:bg-transparent`}
						data-product-visual
					>
						{visual}
					</div>
				) : null}
			</div>
		</section>
	);
}
