import { ProgressiveBlur } from "../progressive-blur.tsx";

/**
 * The bottom edge of a stage hero, blurred and faded into the page background
 * the way the landing hero fades out, so the stage has no hard edge in either
 * theme. Reads `--page-background` so a stage that sets its own scheme still
 * fades into the page's colour.
 */
export function StageFade() {
	return (
		<ProgressiveBlur
			backgroundColor="var(--page-background, var(--background))"
			blurAmount="12px"
			className="z-[1]"
			height="220px"
			position="bottom"
		/>
	);
}
