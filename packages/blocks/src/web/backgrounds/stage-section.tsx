import type { ReactNode } from "react";

import { HeroBackground, type HeroBackgroundId } from "./hero-background.tsx";
import { StageFade } from "./stage-fade.tsx";

/**
 * Turns a page's own hero into a stage: the hero markup is kept as it is and
 * set, in the page's own theme, over an animated backdrop that fills the first
 * viewport under the floating site header (register the page's path in
 * `STAGE_PAGES` so the header floats). A soft scrim keeps the copy legible.
 */
export function StageSection({
	backdrop,
	children,
}: {
	backdrop: HeroBackgroundId;
	children: ReactNode;
}) {
	return (
		<div
			className="relative isolate flex min-h-svh flex-col justify-center overflow-hidden bg-background text-foreground"
			data-stage-section={backdrop}
		>
			<HeroBackground id={backdrop} />
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 z-[1] bg-[radial-gradient(ellipse_70%_55%_at_35%_50%,color-mix(in_oklab,var(--background)_60%,transparent),transparent)]"
			/>
			<StageFade />
			<div className="relative z-[2] w-full pt-20">{children}</div>
		</div>
	);
}
