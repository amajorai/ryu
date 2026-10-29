// Frame-strip helper for checking motion in the interfaces story: shoots
// `--frames` screenshots `--every` milliseconds apart after `--wait`, as
// out-1.png, out-2.png, ... next to `out`. `demo=life` alone moves through
// the act-layer demo's phases; add `&phase=N` to hold one.
//
//   bun e2e/harness/shoot-strip.ts "demo=life" strip.png \
//     [--frames 4] [--every 2000] [--wait 9000] [--width 1440] [--height 900] [--dark] [--reduced]
//
// Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium in containers
// whose preinstalled Chromium differs from the pinned Playwright revision.
import { chromium } from "@playwright/test";
import { FIXTURE_NOW_MS } from "@ryuhq/protocol/interfaces-fixture";

const [query = "demo=life", out = "strip.png", ...rest] = process.argv.slice(2);
const flag = (name: string) => {
	const index = rest.indexOf(`--${name}`);
	return index === -1 ? undefined : rest[index + 1];
};
const frames = Number(flag("frames") ?? 4);
const every = Number(flag("every") ?? 2000);
const width = Number(flag("width") ?? 1440);
const height = Number(flag("height") ?? 900);
const base =
	process.env.INTERFACES_STORY_URL ??
	"http://127.0.0.1:5747/interfaces-story.html";

/**
 * Starts the page's clock at the fixture's now: `Date` keeps ticking from
 * FIXTURE_NOW_MS, so games that read Date.now() agree with the act layer.
 * (Playwright's fixed clock would stop the canvas drawing.)
 */
function fixtureClockScript(nowMs: number): string {
	return `(() => {
		const Real = Date;
		const offset = ${nowMs} - Real.now();
		class Shifted extends Real {
			constructor(...args) {
				super(...(args.length > 0 ? args : [Real.now() + offset]));
			}
			static now() {
				return Real.now() + offset;
			}
		}
		globalThis.Date = Shifted;
	})();`;
}

const browser = await chromium.launch({
	args: [
		"--use-gl=angle",
		"--use-angle=swiftshader",
		"--enable-unsafe-swiftshader",
		"--ignore-gpu-blocklist",
	],
	executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
const page = await browser.newPage({
	locale: "en-GB",
	reducedMotion: rest.includes("--reduced") ? "reduce" : "no-preference",
	timezoneId: "UTC",
	viewport: { height, width },
});
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
// The fixture is anchored at FIXTURE_NOW_MS: in fixture and demo mode start
// the page's clock there too.
if (/(^|&)(fixture=useful|demo=life)(&|$)/.test(query)) {
	await page.addInitScript(fixtureClockScript(FIXTURE_NOW_MS));
}
await page.goto(`${base}?${query}`);
if (rest.includes("--dark")) {
	await page.evaluate(() => document.documentElement.classList.add("dark"));
}
await page.waitForTimeout(Number(flag("wait") ?? 9000));
const stem = out.replace(/\.png$/, "");
for (let frame = 1; frame <= frames; frame++) {
	const path = `${stem}-${frame}.png`;
	await page.screenshot({ path });
	process.stdout.write(`Saved ${path}\n`);
	if (frame < frames) {
		await page.waitForTimeout(every);
	}
}
await browser.close();
if (errors.length > 0) {
	process.stderr.write(`Page errors:\n${errors.join("\n")}\n`);
	process.exit(1);
}
