import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(
	HERE,
	"../../core/src/plugin_manifest/fixtures/slides.ui.html"
);
const PROOF = path.resolve(
	HERE,
	"../../../docs/proof/slides-companion-host-proof.png"
);

test("Slides fixture mounts in the real Path-B Companion host", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});
	page.on("pageerror", (error) => errors.push(String(error)));

	await page.goto("/companion-host-story.html");
	await page.waitForSelector("body[data-harness-ready='1']");
	await page.evaluate((options) => window.__ryuCompanion.mount(options), {
		appHtml: readFileSync(FIXTURE, "utf8"),
		grants: ["storage:kv", "media:generate", "hook:side-model"],
		pluginId: "@ryu/slides",
	});

	await expect
		.poll(() => page.evaluate(() => window.__ryuCompanion.connected()), {
			timeout: 15_000,
		})
		.toBe(true);

	const companion = page.frameLocator("iframe");
	// A real fresh install has no host-backed project yet. The gallery owns that
	// first-run decision, so create the project through its empty-state CTA before
	// asserting the editor content; expecting an editor immediately made this
	// proof disagree with the shipped onboarding path.
	const makeProject = companion.getByRole("button", { name: "Make a project" });
	if (await makeProject.count()) {
		await makeProject.click();
	}
	await expect(companion.getByRole("textbox", { name: "Text" })).toHaveValue(
		"Make the frame clear.",
		{ timeout: 15_000 }
	);
	await expect(
		companion.getByRole("heading", { name: "Layers" })
	).toBeVisible();
	await expect(
		companion.getByRole("heading", { name: "Bring in the signal." })
	).toBeVisible();
	const dismiss = companion.getByRole("button", { name: "Dismiss message" });
	if (await dismiss.count()) {
		await dismiss.click();
	}
	await page.setViewportSize({ width: 960, height: 660 });
	await page.locator("#host-root iframe").evaluate((element) => {
		element.setAttribute("style", "height: 600px; width: 900px;");
	});
	await page.screenshot({ path: PROOF, fullPage: true });
	expect(errors).toEqual([]);
});
