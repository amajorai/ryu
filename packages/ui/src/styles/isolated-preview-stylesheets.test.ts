import { expect, test } from "bun:test";
import { TEXT_SHIMMER_CLASS_NAME } from "../lib/text-shimmer.ts";

const PROFILE_CHART_TOKEN = /var\((--color-profile-chart-\d+)\)/g;
const SHIMMER_ANIMATION = /animate-\[([\w-]+)_/;

function read(relativePath: string): Promise<string> {
	return Bun.file(new URL(relativePath, import.meta.url)).text();
}

test("every profile chart token the component reads is defined in its shared stylesheet", async () => {
	const component = await read("../components/profile-charts.tsx");
	const tokens = new Set(
		Array.from(component.matchAll(PROFILE_CHART_TOKEN), (match) => match[1])
	);
	const palette = await read("./profile-chart-colors.css");

	expect(tokens.size).toBeGreaterThan(0);
	for (const token of tokens) {
		expect(palette).toContain(`${token}:`);
	}
});

test("the text shimmer keyframes live in the shared stylesheet", async () => {
	const animation = SHIMMER_ANIMATION.exec(TEXT_SHIMMER_CLASS_NAME)?.[1];
	const keyframes = await read("./text-shimmer.css");

	expect(animation).toBe("beui-text-shimmer");
	expect(keyframes).toContain(`@keyframes ${animation} {`);
});

test("globals and the isolated docs preview both load the shared stylesheets", async () => {
	const globals = await read("./globals.css");
	const docsPreview = await read(
		"../../../../apps/fumadocs/src/app/ui-preview.css"
	);
	const manifest = await Bun.file(
		new URL("../../package.json", import.meta.url)
	).json();

	for (const sheet of ["profile-chart-colors.css", "text-shimmer.css"]) {
		expect(globals).toContain(`@import "./${sheet}";`);
		expect(docsPreview).toContain(`@import "@ryu/ui/${sheet}";`);
		expect(manifest.exports[`./${sheet}`]).toBe(`./src/styles/${sheet}`);
	}
});

test("the web site loads the metric-matched font fallbacks it names in its tokens", async () => {
	const manifest = await Bun.file(
		new URL("../../package.json", import.meta.url)
	).json();
	const fallbacks = await read("./font-fallbacks.css");
	const web = await read("../../../../apps/web/src/index.css");

	expect(manifest.exports["./font-fallbacks.css"]).toBe(
		"./src/styles/font-fallbacks.css"
	);
	expect(web).toContain('@import "@ryu/ui/font-fallbacks.css";');
	for (const family of ["Inter Fallback", "Geist Fallback"]) {
		expect(fallbacks).toContain(`font-family: "${family}";`);
		expect(web).toContain(`"${family}", sans-serif;`);
	}
});
