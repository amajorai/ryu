import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, test } from "@playwright/test";

// Verification runs set RYU_PROOF_OUTPUT_ROOT so the screenshot lands in
// scratch space instead of rewriting the tracked proof image.
const PROOF_PATH = process.env.RYU_PROOF_OUTPUT_ROOT
	? resolve(process.env.RYU_PROOF_OUTPUT_ROOT, "meetings-settings-nemotron.png")
	: resolve(
			import.meta.dirname,
			"../../../docs/proof/diarization-primitive/meetings-settings-nemotron.png"
		);

test("selects and persists a local speaker model", async ({
	page,
}, testInfo) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto("/meetings-diarization-proof.html");

	const speakerModel = page.getByTestId("meeting-diarization-model");
	await page
		.getByRole("heading", { name: "Speaker labels" })
		.waitFor({ timeout: 10_000 })
		.catch(() => undefined);
	if (!(await speakerModel.count())) {
		await page.screenshot({ path: testInfo.outputPath("render-debug.png") });
		throw new Error(
			`Meetings settings did not render. Body: ${await page.locator("body").innerText()} Browser errors: ${browserErrors.join(" | ")}`
		);
	}
	await expect(speakerModel).toBeVisible();
	await expect(speakerModel).toContainText("pyannote 3.1");
	await page.getByRole("combobox", { name: "Speaker model" }).click();
	await page.getByRole("option", { name: "NVIDIA Nemotron 3" }).click();
	await expect(speakerModel).toContainText("NVIDIA Nemotron 3");
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("option", { name: "NVIDIA Nemotron 3" })
	).not.toBeVisible();
	await expect(page.locator("body")).toHaveAttribute(
		"data-saved-diarization-model",
		"nemotron"
	);

	await page
		.getByRole("heading", { name: "Speaker labels" })
		.scrollIntoViewIfNeeded();
	mkdirSync(dirname(PROOF_PATH), { recursive: true });
	await page.screenshot({
		fullPage: true,
		path: PROOF_PATH,
	});
	expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual(
		[]
	);
});
