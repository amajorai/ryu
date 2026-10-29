// Screenshot helper for iterating on interface designs against a running
// interfaces story server (bunx vite --config e2e/harness/vite.interfaces-story.config.ts).
//
//   bun e2e/harness/shoot-interfaces.ts "interface=feed&thread=thread-deploy" out.png \
//     [--dark] [--width 1440] [--height 900] [--keys ArrowUp,ArrowUp,e] [--click "Talk to Echo"] [--wait 800]
//     [--reduced-motion] [--touch] [--no-webgl]
//
// The browser always runs in en-GB / UTC, matching the fixture's pinned clock.
//
// Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium in containers
// whose preinstalled Chromium differs from the pinned Playwright revision.
import { chromium } from "@playwright/test";
import { FIXTURE_NOW_MS } from "@ryuhq/protocol/interfaces-fixture";

const [query = "interface=feed", out = "shot.png", ...rest] =
	process.argv.slice(2);
const flag = (name: string) => {
	const index = rest.indexOf(`--${name}`);
	return index === -1 ? undefined : rest[index + 1];
};
const dark = rest.includes("--dark");
const width = Number(flag("width") ?? 1440);
const height = Number(flag("height") ?? 900);
const base =
	process.env.INTERFACES_STORY_URL ??
	"http://127.0.0.1:5747/interfaces-story.html";

const touch = rest.includes("--touch");
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
	args: rest.includes("--no-webgl")
		? ["--disable-webgl", "--disable-3d-apis"]
		: [
				"--use-gl=angle",
				"--use-angle=swiftshader",
				"--enable-unsafe-swiftshader",
				"--ignore-gpu-blocklist",
			],
	executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
const page = await browser.newPage({
	hasTouch: touch,
	isMobile: touch,
	locale: "en-GB",
	reducedMotion: rest.includes("--reduced-motion") ? "reduce" : "no-preference",
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
if (dark) {
	await page.evaluate(() => document.documentElement.classList.add("dark"));
}
await page.waitForTimeout(Number(flag("wait") ?? 900));
if (rest.includes("--reduced-motion")) {
	// The reduced-motion frame is final once the page has settled, decided
	// from the page: every kit stage reads data-iso-fit "done" ("none" with
	// no WebGL); a page with its own canvas and no kit stage (town, planets,
	// the worlds) once its plates hold still; a page with no canvas after
	// NO_SCENE_MS has no scene to wait on. Up to 30 s on a slow GPU.
	const settled = await settleForShot();
	if (!settled.ok) {
		await browser.close();
		throw new Error(`the page never settled in 30 s (${settled.why})`);
	}
}
const click = flag("click");
if (click) {
	await page.getByRole("button", { name: click }).first().click();
	await page.waitForTimeout(300);
}
const keys = flag("keys");
if (keys) {
	// Worlds take keys on their canvas; other interfaces read them from the page.
	const world = page.locator('[role="application"]');
	if ((await world.count()) > 0) {
		await world.first().focus();
	}
	for (const key of keys.split(",")) {
		await page.keyboard.press(key);
		await page.waitForTimeout(160);
	}
	await page.waitForTimeout(400);
}
await page.screenshot({ path: out });
await browser.close();
if (errors.length > 0) {
	process.stderr.write(`Page errors:\n${errors.join("\n")}\n`);
	process.exit(1);
}
process.stdout.write(`Saved ${out}\n`);

/** Waits for the page to settle (see the --reduced-motion wait above). */
async function settleForShot(): Promise<{ ok: boolean; why: string }> {
	/** How long a page with no kit stage must hold still once drawing (ms). */
	const STILL_MS = 2500;
	/** A page with no stage and no canvas this long after load has no scene. */
	const NO_SCENE_MS = 12_000;
	const start = Date.now();
	let last = "";
	let stillSince = Date.now();
	let why = "";
	while (Date.now() - start < 30_000) {
		const { canvas, fits, plates } = await page.evaluate(() => ({
			canvas: document.querySelector("canvas") !== null,
			fits: [...document.querySelectorAll<HTMLElement>("[data-iso-fit]")].map(
				(stage) => stage.dataset.isoFit ?? ""
			),
			plates: [
				...document.querySelectorAll(
					"[data-iso-target], [data-iso-plate], [data-you-spot], [data-life-bubble]"
				),
			]
				.map((element) => {
					const box = element.getBoundingClientRect();
					return `${Math.round(box.left)},${Math.round(box.top)}`;
				})
				.join(" "),
		}));
		if (fits.length > 0) {
			why = `data-iso-fit: ${fits.join(", ")}`;
			if (fits.every((fit) => fit === "done" || fit === "none")) {
				return { ok: true, why };
			}
		} else if (canvas) {
			// Its own canvas (town, planets, the worlds; often lazy): settled
			// once its plates, if it has any, hold still.
			why = "no kit stage; the scene is still moving";
			const now = `canvas ${plates}`;
			if (now !== last) {
				last = now;
				stillSince = Date.now();
			} else if (Date.now() - stillSince >= STILL_MS) {
				return { ok: true, why };
			}
		} else {
			why = "no stage and no canvas yet";
			if (Date.now() - start >= NO_SCENE_MS) {
				return { ok: true, why: "no scene" };
			}
		}
		await page.waitForTimeout(200);
	}
	return { ok: false, why };
}
