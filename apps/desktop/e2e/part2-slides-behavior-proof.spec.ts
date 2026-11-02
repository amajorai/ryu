// Continues slides-behavior-proof.spec.ts (split under the file token limit); helpers live in slides-behavior-proof.helpers.ts.

import { readFile, stat } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
	makeProject,
	mountApp,
	persisted,
	saveEvidence,
} from "./slides-behavior-proof.helpers.ts";

// Cold Vite optimizes dependencies and compiles the whole ExtensionHost harness
// module graph on first navigation (about 14s with a fresh cache, as on CI),
// which the first test's long layer-edit flow would otherwise share with the
// 30s default.
test.describe.configure({ timeout: 90_000 });

test("export produces a decoded PNG and an editable Carousel JSON download", async ({
	page,
}) => {
	const app = await mountApp(page);
	await makeProject(app, "Export proof frame");
	await app
		.getByRole("textbox", { name: "Text", exact: true })
		.fill("A rendered export assertion");
	const seriesTitle = app.getByRole("textbox", { name: "Series title" });
	await seriesTitle.fill("Export proof frame");
	await seriesTitle.blur();
	await expect
		.poll(async () => {
			// SAFETY: This proof mounts the exact Playwright-built native Slides bundle against its private scoped storage Map. App saveState persists model.serializeState projects/trash from the actual normalized Project and Layer constructors; this observer reads those authored bytes through the scoped storage RPC. No foreign storage JSON is validated by this view.
			const state = (await persisted(page)) as {
				projects?: Array<{ name: string; seriesTitle: string }>;
			} | null;
			return state?.projects?.find(
				(project) => project.name === "Export proof frame"
			)?.seriesTitle;
		})
		.toBe("Export proof frame");
	const pngEvent = page.waitForEvent("download", { timeout: 10_000 });
	await app.getByRole("button", { name: "Export", exact: true }).click();
	await expect(app.getByRole("dialog", { name: "Export frame" })).toBeVisible();
	await app.getByRole("radio", { name: /PNG/ }).check();
	await app.getByRole("button", { name: "Export", exact: true }).last().click();
	await expect(app.getByRole("dialog", { name: "Export frame" })).toHaveCount(
		0
	);
	await expect(
		app.getByRole("button", { name: "Dismiss message" })
	).toContainText("Exported PNG from Export proof frame.");
	const pngDownload = await pngEvent;
	const pngPath = await pngDownload.path();
	expect(pngPath).toBeTruthy();
	const png = await readFile(pngPath!);
	expect(png.subarray(0, 8)).toEqual(
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
	);
	expect((await stat(pngPath!)).size).toBeGreaterThan(1000);
	await expect(app.getByRole("dialog", { name: "Export frame" })).toHaveCount(
		0
	);
	await expect(
		app.getByRole("button", { name: "Dismiss message" })
	).toContainText("Exported PNG from Export proof frame.");
	await saveEvidence(page, "slides-export-rendered-png-success.png");

	const jpegEvent = page.waitForEvent("download", { timeout: 10_000 });
	await app.getByRole("button", { name: "Export", exact: true }).click();
	await app.getByRole("radio", { name: /JPEG/ }).check();
	await app.getByRole("button", { name: "Export", exact: true }).last().click();
	const jpegDownload = await jpegEvent;
	const jpegPath = await jpegDownload.path();
	if (!jpegPath) {
		throw new Error("Playwright did not preserve the Slides JPEG export.");
	}
	const jpeg = await readFile(jpegPath);
	expect(jpegDownload.suggestedFilename()).toMatch(/\.jpg$/u);
	expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
	expect((await stat(jpegPath)).size).toBeGreaterThan(1000);
	await expect(
		app.getByRole("button", { name: "Dismiss message" })
	).toContainText("Exported JPG from Export proof frame.");

	const jsonEvent = page.waitForEvent("download", { timeout: 10_000 });
	await app.getByRole("button", { name: "Export", exact: true }).click();
	await app.getByRole("radio", { name: /Carousel JSON/ }).check();
	await app.getByRole("button", { name: "Export", exact: true }).last().click();
	const jsonDownload = await jsonEvent;
	const jsonPath = await jsonDownload.path();
	expect(jsonPath).toBeTruthy();
	// SAFETY: This actual Carousel JSON download is produced by the mounted native App exportActive -> serializeCarouselDocument -> downloadText chain from its normalized Project/Layer records. The private proof does not substitute arbitrary downloaded content.
	const document = JSON.parse(await readFile(jsonPath!, "utf8")) as {
		projects: Array<{ layers: Array<{ text?: string }>; name: string }>;
	};
	expect(document.projects[0]?.name).toBe("Export proof frame");
	expect(
		document.projects[0]?.layers.some(
			(layer) => layer.text === "A rendered export assertion"
		)
	).toBe(true);
	await expect(
		app.getByRole("button", { name: "Dismiss message" })
	).toContainText("Exported editable JSON for Export proof frame.");
});
