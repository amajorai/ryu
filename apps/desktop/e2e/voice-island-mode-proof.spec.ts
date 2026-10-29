import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

/** Read one of the per-instance custom properties voice-glow writes each frame. */
function beamVar(beam: import("@playwright/test").Locator, name: string) {
	return beam.evaluate((element, prop) => {
		const id = element.getAttribute("data-voice-beam");
		return getComputedStyle(element)
			.getPropertyValue(`--vb-${prop}-${id}`)
			.trim();
	}, name);
}

test("renders both Island voice states and captures the finished UI", async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await page.goto("/voice-island-mode-proof.html");

	// Push-to-talk: the libraries.dev voice glow's pill preset, following the mic.
	const pushToTalk = page.getByTestId("push-to-talk-preview");
	await expect(pushToTalk).toContainText("Island voice input");
	await expect(pushToTalk).toContainText("Ryu Assistant");
	const pill = pushToTalk.locator("[data-voice-beam]");
	await expect(pill).toHaveAttribute("data-voice-type", "pill");
	await expect
		.poll(async () => Number(await beamVar(pill, "level")))
		.toBeGreaterThan(0.1);

	// Voice mode while thinking: the glow gathers into a beam that sweeps.
	const voiceMode = page.getByTestId("voice-mode-preview");
	await expect(voiceMode).toContainText("Continuous voice mode");
	await expect(voiceMode).toContainText("Thinking…");
	const panel = voiceMode.locator("[data-voice-beam]");
	await expect(panel).toHaveAttribute("data-processing", "true");
	await expect.poll(async () => await beamVar(panel, "cx")).not.toBe("0.0px");
	const firstOffset = await beamVar(panel, "cx");
	await page.waitForTimeout(250);
	expect(await beamVar(panel, "cx")).not.toBe(firstOffset);

	const screenshotPath = path.resolve(
		process.cwd(),
		"../../docs/proof/voice-glow/island-voice-mode.png"
	);
	await mkdir(path.dirname(screenshotPath), { recursive: true });
	await page.screenshot({ fullPage: true, path: screenshotPath });

	// Reduced motion: voice-glow holds the gathered beam at the centre.
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.reload();
	const reducedPanel = page
		.getByTestId("voice-mode-preview")
		.locator("[data-voice-beam]");
	await expect(reducedPanel).toHaveAttribute("data-processing", "true");
	await page.waitForTimeout(250);
	expect(await beamVar(reducedPanel, "cx")).toBe("0.0px");
});
