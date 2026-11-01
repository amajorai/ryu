import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OnboardingShell } from "./onboarding-shell.tsx";

function headerMarkup(layout: "stacked" | "split") {
	const html = renderToStaticMarkup(
		<OnboardingShell
			layout={layout}
			subtitle="Pick how your agent should sound"
			title="Choose a voice"
		/>
	);
	const subtitle = html.match(/<p class="([^"]*)"[^>]*>Pick how/)?.[1] ?? "";
	const heading = html.match(/<h1 class="([^"]*)"/)?.[1] ?? "";
	const frame = html.match(/<div class="([^"]*)"[^>]*><h1/)?.[1] ?? "";
	return { frame, heading, subtitle };
}

test("the onboarding subtitle is full size, matching the title", () => {
	const { heading, subtitle } = headerMarkup("stacked");
	expect(heading).toContain("text-xl");
	expect(heading).toContain("font-medium");
	expect(subtitle).toContain("text-xl");
	expect(subtitle).toContain("font-medium");
	expect(subtitle).not.toContain("--text-detail");
});

test("the onboarding header is capped to a readable width", () => {
	const { frame } = headerMarkup("stacked");
	expect(frame).toContain("max-w-md");
	expect(frame).toContain("mx-auto");
});

test("the split layout grows both header lines together", () => {
	const { heading, subtitle } = headerMarkup("split");
	expect(heading).toContain("lg:text-2xl");
	expect(subtitle).toContain("lg:text-2xl");
});

test("only the split layout centers its content without the action row", async () => {
	const { default: styles } = await import("./onboarding.module.css");
	const render = (layout: "stacked" | "split") =>
		renderToStaticMarkup(
			<OnboardingShell layout={layout} title="Set up">
				<p>Content</p>
			</OnboardingShell>
		);
	expect(styles.splitColumn).toBeTruthy();
	expect(render("split")).toContain(styles.splitColumn);
	expect(render("stacked")).not.toContain(styles.splitColumn);
});
