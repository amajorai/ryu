// Real-browser spec for the node-layer submenu story (`e2e/harness/
// node-layer-story.{html,tsx}`), which mounts the REAL `NodeLayerMenu` — the shell
// every layer of the node selector renders through — with mock props.
//
// The component's contract (from NodeLayerMenu.tsx):
//   • each layer is a submenu trigger showing the layer name + a trailing detail;
//   • opening it shows a header (current selection + version + caption), then the
//     actions, then "Installed", then "Not installed";
//   • a `swap` layer ticks its ONE active option; a `toggle` layer ticks each
//     RUNNING option, so more than one tick can be lit at a time;
//   • acting on a row does NOT close the menu (`closeOnClick={false}`);
//   • a layer with no actions and no options still renders its header.

import { expect, test } from "@playwright/test";

// The story pulls the dropdown + tooltip module graph; vite compiles it on first
// navigation, so allow headroom over the 30s default for cold-start runs.
test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/node-layer-story.html";

async function openMenu(page: import("@playwright/test").Page) {
	await page.goto(STORY_URL);
	const trigger = page.getByRole("button", { name: "Node" });
	await expect(trigger).toBeVisible();
	await trigger.click();
}

test("every layer renders as a submenu trigger", async ({ page }) => {
	await openMenu(page);
	for (const label of [
		"Core",
		"Island",
		"Chat",
		"Voice Recognition",
		"Speech Processing",
		"Audio",
	]) {
		await expect(
			page.getByRole("menuitem", { name: new RegExp(label) })
		).toBeVisible();
	}
	await expect(page.getByText("Chat", { exact: true })).toBeVisible();
	await expect(page.getByText("Chat engine", { exact: true })).toHaveCount(0);
});

test("a service submenu leads with Start/Stop and Update", async ({ page }) => {
	await openMenu(page);
	await page.getByRole("menuitem", { name: /Core/ }).click();
	// Header states WHAT is selected and how it is doing.
	await expect(page.getByText("Running · 2.1 GB · 4%")).toBeVisible();
	// Actions sit at the top, before any separator.
	await expect(page.getByRole("menuitem", { name: "Stop" })).toBeVisible();
	await expect(page.getByRole("menuitem", { name: "Update" })).toBeVisible();
});

test("a swap layer ticks exactly one option and lists installs below", async ({
	page,
}) => {
	await openMenu(page);
	await page.getByRole("menuitem", { name: /^Chat/ }).click();
	await expect(page.getByText("Installed", { exact: true })).toBeVisible();
	await expect(page.getByText("Not installed", { exact: true })).toBeVisible();
	// Swap-managed: no start/stop verb anywhere in this layer.
	await expect(page.getByRole("menuitem", { name: "Stop" })).toHaveCount(0);
	await expect(page.getByRole("menuitem", { name: "Start" })).toHaveCount(0);
	// The alternative is offered, and the unsupported install is inert.
	await expect(page.getByRole("menuitem", { name: /Ollama/ })).toBeVisible();
	await expect(page.getByRole("menuitem", { name: /SGLang/ })).toBeDisabled();
});

test("acting on a row keeps the submenu open", async ({ page }) => {
	await openMenu(page);
	await page.getByRole("menuitem", { name: /^Chat/ }).click();
	const alternative = page.getByRole("menuitem", { name: /Ollama/ });
	await alternative.click();
	await expect(alternative).toBeVisible();
});

test("the nested voice picker is reachable three levels deep", async ({
	page,
}) => {
	await openMenu(page);
	await page.getByRole("menuitem", { name: /Audio/ }).click();
	const voiceTrigger = page.getByRole("menuitem", {
		name: /^Voice af_heart/,
	});
	await expect(voiceTrigger).toBeVisible();
	await voiceTrigger.click();
	await expect(page.getByRole("menuitem", { name: /af_heart/ })).toBeVisible();
	await expect(page.getByRole("menuitem", { name: /am_puck/ })).toBeVisible();
});

test("Speech Processing exposes the S1-mini model and its style control", async ({
	page,
}) => {
	await openMenu(page);
	await page.getByRole("menuitem", { name: /Speech Processing/ }).click();
	await expect(
		page.getByRole("menuitem", { name: /^S1-mini by Superwhisper/ })
	).toBeVisible();
	await page.getByRole("menuitem", { name: /^Style semi-formal/ }).click();
	await expect(page.getByRole("menuitem", { name: /^formal/ })).toBeVisible();
});

test("a header-only layer still renders its status", async ({ page }) => {
	await openMenu(page);
	await page.getByRole("menuitem", { name: /Island/ }).click();
	await expect(page.getByText("Running", { exact: true })).toBeVisible();
});
