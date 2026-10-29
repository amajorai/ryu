"use client";

import { useMounted } from "@ryu/ui/hooks/use-mounted.ts";
import { cn } from "@ryu/ui/lib/utils";
import { useTheme } from "next-themes";
import {
	type ComponentProps,
	type ComponentType,
	lazy,
	Suspense,
	useEffect,
	useState,
} from "react";
import { DownloadMenu } from "./download-menu.tsx";
import { HeroSky } from "./hero-sky.tsx";
import { LandingDownloadBeam } from "./landing-download-beam.tsx";
import { ProgressiveBlur } from "./progressive-blur.tsx";
import styles from "./realms-hero.module.css";
import { SeasonalParticles } from "./seasonal-particles.tsx";
import { heroBeamFor, heroSkyFor } from "./seasonal-sky.ts";
import { SetupRyuButton } from "./setup-ryu-button.tsx";
import { useLandingSeason } from "./use-landing-season.ts";
import { whenBrowserIdle } from "./when-browser-idle.ts";

// The season picker (with its motion animations) is a small floating control,
// so it loads once the browser is idle instead of during hydration. A failed
// chunk leaves the hero without it rather than breaking the page.
type SeasonalPickerProps = ComponentProps<
	typeof import("./seasonal-picker.tsx").SeasonalPicker
>;
const NoSeasonalPicker = (_props: SeasonalPickerProps) => null;
const SeasonalPicker = lazy(
	(): Promise<{ default: ComponentType<SeasonalPickerProps> }> =>
		import("./seasonal-picker.tsx").then(
			(module) => ({ default: module.SeasonalPicker }),
			() => ({ default: NoSeasonalPicker })
		)
);

function useBrowserIdle(): boolean {
	const [idle, setIdle] = useState(false);
	useEffect(() => whenBrowserIdle(() => setIdle(true)), []);
	return idle;
}

/**
 * The homepage hero's sky, headline and download actions: the client part of
 * RealmsHero (the seasonal sky follows the visitor's calendar and pick, and
 * turns from morning to night with the theme).
 */
export function RealmsHeroSurface() {
	// Seasonal themes (see seasons.ts) tint the sky and add a particle layer.
	const season = useLandingSeason();
	const { resolvedTheme } = useTheme();
	const idle = useBrowserIdle();
	// The server cannot know the visitor's theme, so the first client render
	// draws the same (day) sky as the server HTML and the theme applies once
	// mounted; reading it earlier made the sky's attributes differ on hydration.
	const mounted = useMounted();
	const { colors: sky, night } = heroSkyFor(
		season,
		mounted ? resolvedTheme : undefined
	);
	return (
		<>
			{season ? <SeasonalParticles season={season} /> : null}
			<section
				className="relative isolate overflow-hidden text-foreground"
				data-season={season ?? undefined}
				data-sky={night ? "night" : "day"}
				data-testid="hero-surface"
			>
				<HeroSky className="z-0" colors={sky} night={night} />
				{season === "halloween" && night ? (
					<div
						aria-hidden="true"
						className={cn(styles.horizon, "pointer-events-none absolute z-[1]")}
					/>
				) : null}
				<ProgressiveBlur
					blurAmount="12px"
					className="z-[1]"
					height="220px"
					position="bottom"
				/>
				{idle ? (
					<Suspense fallback={null}>
						<SeasonalPicker
							className="absolute right-4 bottom-4 z-[3]"
							season={season}
						/>
					</Suspense>
				) : null}
				<div
					className="relative z-[2] mx-auto flex min-h-[min(740px,calc(100svh-4rem))] max-w-[96rem] flex-col items-center justify-center gap-9 overflow-hidden px-6 py-20 text-center"
					data-testid="hero-viewport"
				>
					<h1
						className={cn(
							styles.heading,
							"!font-medium !leading-none !tracking-tighter mx-auto w-full max-w-[88rem] text-balance text-center"
						)}
					>
						Open-source agentic infrastructure
					</h1>
					<div className="flex flex-col items-center gap-4">
						<div className="flex flex-wrap items-center justify-center gap-3">
							<LandingDownloadBeam
								borderRadius={28}
								colorVariant={heroBeamFor(season, night)}
								testId="landing-download-beam"
								theme={night ? "dark" : "light"}
							>
								<DownloadMenu
									label="Download"
									showSeparator={false}
									size="lg"
									transparentBackground
									variant="outline"
								/>
							</LandingDownloadBeam>
							<SetupRyuButton />
						</div>
					</div>
				</div>
			</section>
		</>
	);
}
