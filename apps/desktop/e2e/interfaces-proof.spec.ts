// Real-browser proof for the four workspace interfaces — Channels, Feed,
// World 2D and World 3D — mounted by `e2e/harness/interfaces-story.{html,tsx}`
// from the REAL renderers in `packages/blocks/src/desktop/interfaces/`.
//
// The story is the host: it feeds one fixture snapshot (six agents, the
// "Launch Crew" team, the "Website Redesign" project, ten threads with two runs
// live) into every renderer, implements the InterfacePort in local state, and
// passes a labelled stub as the host chat surface (`threadView`). Each port
// call is echoed into a `port-log` output so these tests can prove a renderer
// acted through the port instead of a side channel.
//
// Contract asserted per interface:
//   • Channels — teams/projects are #channels, every agent has a DM, running
//     work is marked, picking a thread opens the host view in the thread pane
//     via the port, and switching channel closes it (as Slack does);
//   • Feed — every thread is a post (pinned first), the Working tab and search
//     narrow the timeline, and opening a post shows the host view as replies;
//   • World 2D — every agent stands on the map as a "Talk to" target; walking
//     up with ArrowUp and pressing E opens that agent's dialogue box, M and
//     the hotbar's map slot toggle the village map, a hotbar slot visits an
//     agent, and its reply box starts a thread through the port;
//   • World 3D — the react-three-fiber canvas renders under headless WebGL
//     (SwiftShader) with the same agents and the same walk-and-talk controls,
//     and the dialogue's "Say something…" composer starts a thread through
//     the port.
//
// Screenshots land in `docs/proof/interfaces/<name>-spec.png`. The unsuffixed
// PNGs beside them are the designers' curated shots (light/dark, sizes,
// night themes), so this spec never overwrites them.

import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

// Cold Vite compiles the blocks, ui and three.js module graphs on first load.
test.describe.configure({ timeout: 120_000 });

const PROOF_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/interfaces"
);
const AGENT_NAMES = ["Atlas", "Brook", "Cipher", "Delta", "Echo", "Forge"];
const MAX_STEPS_TO_AGENT = 8;

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => {
		errors.push(error.message);
	});
});

test.afterEach(({ page }) => {
	expect(pageErrors.get(page) ?? []).toEqual([]);
});

function storyUrl(params: Record<string, string>): string {
	return `/interfaces-story.html?${new URLSearchParams(params).toString()}`;
}

async function shot(page: Page, name: string): Promise<void> {
	await page.screenshot({ path: path.join(PROOF_DIR, `${name}-spec.png`) });
}

/**
 * Walk the player north from spawn until an agent is within reach, then
 * return the name the world offers to talk to. Spawn sits on the plaza below
 * the middle column, so the first agent reached is the one directly above.
 */
async function walkUpToNearestAgent(page: Page): Promise<string> {
	const status = page.getByRole("status").filter({ hasText: "Talk to" });
	for (let step = 0; step < MAX_STEPS_TO_AGENT; step += 1) {
		if ((await status.count()) > 0) {
			break;
		}
		await page.keyboard.press("ArrowUp");
	}
	await expect(status).toBeVisible();
	const text = (await status.textContent()) ?? "";
	return text.replace(/^.*Talk to\s+/, "").trim();
}

test("Channels: teams and projects are channels, agents are DMs", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "channels" }));
	const surface = page.getByTestId("interface-channels");
	await expect(surface).toBeVisible();

	const rail = page.getByRole("navigation", { name: "Channels" });
	await expect(
		rail.getByRole("heading", { name: "Channels", exact: true })
	).toBeVisible();
	await expect(
		rail.getByRole("heading", { name: "Direct messages" })
	).toBeVisible();
	await expect(
		rail.getByRole("button", { name: /^launch-crew/ })
	).toBeVisible();
	await expect(
		rail.getByRole("button", { name: /^website-redesign/ })
	).toBeVisible();
	await expect(rail.getByRole("button", { name: /^general/ })).toBeVisible();
	for (const name of AGENT_NAMES) {
		await expect(
			rail.getByRole("button", { name: new RegExp(`\\b${name}\\b`) })
		).toBeVisible();
	}
	// Forge's hero rebuild and Delta's rollout are live runs.
	await expect(
		rail.getByRole("button", { name: /^website-redesign Working/ })
	).toBeVisible();
	await expect(
		rail.getByRole("button", { name: /Delta.*Working/ })
	).toBeVisible();

	// The most recently active channel is selected, with a composer and no
	// thread open until the user picks one. The "#" is a decorative icon, so
	// accessible names carry the bare handle.
	await expect(surface).toContainText("Welcome to #website-redesign");
	await expect(
		surface.getByRole("heading", { name: "website-redesign" })
	).toBeVisible();
	await expect(
		surface.getByRole("textbox", { name: "Message website-redesign" })
	).toBeVisible();

	const threads = surface.getByRole("toolbar", {
		name: "Threads in this channel",
	});
	await threads
		.getByRole("button", { name: /Rebuild the landing hero/ })
		.click();
	await expect(page.getByTestId("port-log")).toContainText(
		"openThread(thread-hero)"
	);
	const view = page.getByTestId("stub-thread-view");
	await expect(view).toBeVisible();
	await expect(view).toContainText("preloading it");
	const pane = surface.getByRole("complementary", { name: "Thread" });
	await expect(pane.getByTestId("stub-thread-view")).toBeVisible();
	await shot(page, "channels");

	// Switching channel closes the open thread through the port; picking a
	// thread in the new channel opens it in the pane again.
	await rail.getByRole("button", { name: /^launch-crew/ }).click();
	await expect(page.getByTestId("port-log")).toContainText("closeThread()");
	await expect(pane).toBeHidden();
	await expect(
		surface.getByRole("heading", { name: "launch-crew" })
	).toBeVisible();
	await threads.getByRole("button", { name: /Launch week plan/ }).click();
	await expect(page.getByTestId("port-log")).toContainText(
		"openThread(thread-launch-plan)"
	);
	await expect(view).toContainText("Plan locked");

	// The pane's close button closes the thread through the port.
	await pane.getByRole("button", { name: "Close thread" }).click();
	await expect(pane).toBeHidden();

	// Collapsing a sidebar section folds away idle rows but keeps live ones.
	const dmToggle = rail.getByRole("button", { name: "Direct messages" });
	await dmToggle.click();
	await expect(dmToggle).toHaveAttribute("aria-expanded", "false");
	await expect(rail.getByRole("button", { name: /\bAtlas\b/ })).toBeHidden();
	await expect(
		rail.getByRole("button", { name: /Delta.*Working/ })
	).toBeVisible();
	await dmToggle.click();
	await expect(rail.getByRole("button", { name: /\bAtlas\b/ })).toBeVisible();
});

test("Feed: every thread is a post and its conversation is the replies", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "feed" }));
	const feed = page.getByRole("region", { name: "Feed" });
	await expect(feed).toBeVisible();

	const posts = feed.getByRole("listitem");
	await expect(posts).toHaveCount(10);
	// Pinned posts lead the timeline, then newest activity first.
	await expect(posts.first()).toContainText("Launch week plan");
	await expect(posts.first()).toContainText("Pinned");
	await expect(posts.nth(1)).toContainText("Rebuild the landing hero");
	await expect(posts.nth(1)).toContainText("Live");
	await expect(posts.nth(1)).toContainText("@forge");
	await expect(feed.getByRole("textbox", { name: "New post" })).toBeVisible();

	// The Working tab keeps only live runs: Forge's hero and Delta's rollout.
	const timelineTabs = feed.getByRole("tablist", { name: "Timeline" });
	await timelineTabs.getByRole("tab", { name: "Working" }).click();
	await expect(posts).toHaveCount(2);
	await timelineTabs.getByRole("tab", { name: "For you" }).click();
	await expect(posts).toHaveCount(10);

	// The sidebar search live-filters the timeline.
	const search = page
		.getByRole("complementary", { name: "Search and trends" })
		.getByRole("searchbox", { name: "Search posts" });
	await search.fill("gateway");
	await expect(posts).toHaveCount(1);
	await expect(posts.first()).toContainText("Roll out gateway 2.4");
	await search.fill("");
	await expect(posts).toHaveCount(10);

	const deployPost = posts.filter({ hasText: "Roll out gateway 2.4" });
	// The reply count is the thread's messages after the opening one.
	await expect(
		deployPost.getByRole("button", { name: /^Reply, \d+ repl(y|ies)$/ })
	).toBeVisible();
	await deployPost
		.getByRole("button", { name: /^Open post by Delta: Roll out gateway 2\.4/ })
		.click();
	await expect(page.getByTestId("port-log")).toContainText(
		"openThread(thread-deploy)"
	);
	const replies = page.getByRole("region", { name: "Post and replies" });
	await expect(replies).toBeVisible();
	// The focused post leads the page, as on a post's own page.
	await expect(
		replies.getByRole("article", {
			name: "Delta: Roll out gateway 2.4 to production",
		})
	).toBeVisible();
	await expect(replies.getByTestId("stub-thread-view")).toContainText(
		"Canary is at 25%"
	);
	await shot(page, "feed");

	// Back returns to the timeline through the port.
	await replies.getByRole("button", { name: "Back to feed" }).click();
	await expect(page.getByTestId("port-log")).toContainText("closeThread()");
	await expect(feed).toBeVisible();

	// Posting goes through port.startThread with the typed prompt.
	await feed
		.getByRole("textbox", { name: "New post" })
		.fill("Summarize this week's incidents");
	await feed.getByRole("button", { name: "Post", exact: true }).click();
	await expect(page.getByTestId("port-log")).toContainText(
		'"prompt":"Summarize this week\'s incidents"'
	);
	// The host opens the new thread, so its post page comes up; back on the
	// timeline the new post leads everything but the pinned one.
	await expect(
		replies.getByRole("article", {
			name: /Summarize this week's incidents/,
		})
	).toBeVisible();
	await replies.getByRole("button", { name: "Back to feed" }).click();
	await expect(posts.nth(1)).toContainText("Summarize this week's incidents");
});

test("World 2D: walk up to an agent and press E to talk", async ({ page }) => {
	await page.goto(storyUrl({ interface: "world-2d" }));
	const world = page.getByRole("application", { name: /Agent world\./ });
	await expect(world).toBeVisible();
	for (const name of AGENT_NAMES) {
		await expect(
			page.getByRole("button", { name: `Talk to ${name}` })
		).toBeVisible();
	}
	await expect(page.getByRole("img", { name: "You" })).toBeVisible();

	await world.focus();
	const nearest = await walkUpToNearestAgent(page);
	// Placement is stable by name: six agents sit in a 3x2 grid, so the one
	// straight above the spawn plaza is the fifth by name.
	expect(nearest).toBe("Echo");

	await page.keyboard.press("e");
	const panel = page.getByRole("complementary", { name: "Talking to Echo" });
	await expect(panel).toBeVisible();
	await expect(panel).toContainText("Release notes, docs and announcements");
	await expect(panel).toContainText("Past conversations");
	await expect(
		panel.getByRole("button", { name: /Draft 2\.4 release notes/ })
	).toBeVisible();
	await expect(
		panel.getByRole("textbox", { name: "Say something to Echo" })
	).toBeVisible();

	// Picking a past conversation shows the host view inside the panel.
	await panel.getByRole("button", { name: /Draft 2\.4 release notes/ }).click();
	await expect(page.getByTestId("port-log")).toContainText(
		"openThread(thread-release-notes)"
	);
	await expect(panel.getByTestId("stub-thread-view")).toContainText(
		"breaking change"
	);
	await shot(page, "world-2d");

	// Escape walks away and closes the thread through the port.
	await world.focus();
	await page.keyboard.press("Escape");
	await expect(panel).toBeHidden();
	await expect(page.getByTestId("port-log")).toContainText("closeThread()");

	// M toggles the village map card (the hotbar's map slot does the same).
	const villageMap = page.getByRole("img", {
		name: "Village map: 6 villagers, 2 working",
	});
	await expect(villageMap).toBeHidden();
	await world.focus();
	await page.keyboard.press("m");
	await expect(villageMap).toBeVisible();
	await page.getByRole("button", { name: "Village map" }).click();
	await expect(villageMap).toBeHidden();

	// A hotbar slot visits an agent directly, and the reply box starts a
	// conversation with it through port.startThread.
	await page
		.getByRole("navigation", { name: "Villagers" })
		.getByRole("button", { name: /^Visit Brook/ })
		.click();
	const brook = page.getByRole("complementary", { name: "Talking to Brook" });
	await expect(brook).toBeVisible();
	await brook
		.getByRole("textbox", { name: "Say something to Brook" })
		.fill("Draft a palette for the docs");
	await brook.getByRole("button", { name: "Say it" }).click();
	await expect(page.getByTestId("port-log")).toContainText(
		'startThread({"agentId":"agent-brook","prompt":"Draft a palette for the docs"})'
	);
	await expect(brook.getByTestId("stub-thread-view")).toBeVisible();
	await brook.getByRole("button", { name: "Walk away" }).click();
	await expect(brook).toBeHidden();
});

test("World 3D: the WebGL scene renders the same world", async ({ page }) => {
	await page.goto(storyUrl({ interface: "world-3d" }));
	await expect(page.getByTestId("interface-world-3d")).toBeVisible();

	const webgl = await page.evaluate(() => {
		const canvas = document.createElement("canvas");
		const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
		if (!gl) {
			return null;
		}
		const debug = gl.getExtension("WEBGL_debug_renderer_info");
		return {
			renderer: debug
				? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
				: String(gl.getParameter(gl.RENDERER)),
			version: String(gl.getParameter(gl.VERSION)),
		};
	});
	test.info().annotations.push({
		type: "webgl",
		description: webgl
			? `${webgl.version} via ${webgl.renderer}`
			: "unavailable in this browser",
	});

	if (!webgl) {
		await expect(page.getByText(/needs WebGL/)).toBeVisible();
		await shot(page, "world-3d-no-webgl");
	}
	expect(webgl, "WebGL is unavailable in this headless browser").not.toBeNull();

	const world = page.getByRole("application", { name: /Agent world in 3D/ });
	const canvas = world.locator("canvas");
	await expect(canvas).toBeVisible();
	// r3f sizes the canvas to its container once it has measured it; under a
	// busy software rasterizer that first measure can take a few seconds.
	await expect
		.poll(async () => (await canvas.boundingBox())?.width ?? 0, {
			timeout: 20_000,
		})
		.toBeGreaterThan(400);
	await expect
		.poll(async () => (await canvas.boundingBox())?.height ?? 0, {
			timeout: 20_000,
		})
		.toBeGreaterThan(300);
	// drei's <Html> labels only mount once the r3f scene graph is rendering.
	for (const name of AGENT_NAMES) {
		await expect(
			page.getByRole("button", { name: `Talk to ${name}` })
		).toBeVisible();
	}
	// Give the software rasterizer a few frames before capturing.
	await page.waitForTimeout(750);

	await world.focus();
	const nearest = await walkUpToNearestAgent(page);
	expect(nearest).toBe("Echo");
	await page.keyboard.press("e");
	const panel = page.getByRole("complementary", { name: "Talking to Echo" });
	await expect(panel).toBeVisible();
	await expect(panel).toContainText("Past conversations");
	await expect(
		panel.getByRole("button", { name: /Draft 2\.4 release notes/ })
	).toBeVisible();
	await page.waitForTimeout(500);
	await shot(page, "world-3d");

	// "Say something…" opens the composer in the dialogue band; submitting it
	// starts a conversation with Echo through the port.
	await panel.getByRole("button", { name: "Say something…" }).click();
	await panel
		.getByRole("textbox", { name: "Say something to Echo" })
		.fill("Announce the 2.4 release");
	await panel.getByRole("button", { name: "Say", exact: true }).click();
	await expect(page.getByTestId("port-log")).toContainText(
		'startThread({"agentId":"agent-echo","prompt":"Announce the 2.4 release"})'
	);
	await expect(panel.getByTestId("stub-thread-view")).toBeVisible();

	// Back returns to the dialogue; Walk away closes it through the port.
	await panel.getByRole("button", { name: "Back to conversations" }).click();
	await expect(page.getByTestId("port-log")).toContainText("closeThread()");
	await expect(panel.getByTestId("stub-thread-view")).toBeHidden();
	await panel.getByRole("button", { name: "Walk away" }).click();
	await expect(panel).toBeHidden();
});
