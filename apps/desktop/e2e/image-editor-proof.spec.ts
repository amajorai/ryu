import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
	clickOverflowAction,
	expectImageOverlaysClosed,
	installPrimitiveGates,
	installProductionResizeFixture,
	openImageEditor,
	startGatewayResize,
} from "./image-editor-proof.helpers.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

test("edits a chat image and attaches the exported PNG", async ({ page }) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			pageErrors.push(message.text());
		}
	});

	const editor = await openImageEditor(page);
	const canvas = editor.getByTestId("image-editor-canvas");
	await expect(canvas).toBeVisible();
	await clickOverflowAction(editor, "Select a detected subject");
	const subject = editor.getByRole("button", { name: "Select Sample subject" });
	await expect(subject).toBeVisible();
	const box = await canvas.boundingBox();
	expect(box).not.toBeNull();
	if (!box) {
		throw new Error("The editing canvas has no visible bounds.");
	}
	await page.mouse.move(box.x + box.width * 0.34, box.y + box.height * 0.42);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.6, {
		steps: 5,
	});
	await page.mouse.up();
	await expect(subject).toHaveAttribute("aria-pressed", "true");
	await editor.getByRole("button", { name: "Erase selected subject" }).click();
	const canvasAlpha = (x: number, y: number) =>
		canvas.evaluate(
			(element, point) =>
				element.getContext("2d")?.getImageData(point.x, point.y, 1, 1)
					.data[3] ?? -1,
			{ x, y }
		);
	expect(await canvasAlpha(320, 240)).toBe(0);

	await clickOverflowAction(editor, "Reset image");
	await editor.getByRole("button", { name: "Remove background" }).click();
	await expect(
		editor.getByRole("status").filter({ hasText: "Background removed." })
	).toBeVisible();
	expect(await canvasAlpha(20, 20)).toBe(0);
	expect(await canvasAlpha(320, 240)).toBe(255);

	await editor.getByRole("button", { name: "Erase brush" }).click();
	const brushBox = await canvas.boundingBox();
	if (!brushBox) {
		throw new Error("The eraser canvas has no visible bounds.");
	}
	await page.mouse.move(
		brushBox.x + brushBox.width * 0.5,
		brushBox.y + brushBox.height * 0.5
	);
	await page.mouse.down();
	await page.mouse.move(
		brushBox.x + brushBox.width * 0.55,
		brushBox.y + brushBox.height * 0.5,
		{
			steps: 3,
		}
	);
	await page.mouse.up();
	expect(await canvasAlpha(320, 240)).toBe(0);
	await clickOverflowAction(editor, "Reset image");

	await editor.getByRole("button", { name: "AI Resize" }).click();
	const widescreenPreset = editor.getByRole("button", {
		name: /Resize to Widescreen/,
	});
	await expect(widescreenPreset).toHaveText(/16:9 · 1,472 × 832 px/);
	const presetProofPath = proofEvidencePath(
		"image-editing/image-ai-resize-presets-proof.png"
	);
	await mkdir(path.dirname(presetProofPath), { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: false,
		path: presetProofPath,
	});
	await editor.getByRole("button", { name: "Gateway model" }).click();
	await expect(widescreenPreset).toHaveText(/16:9 · 1,536 × 864 px/);
	await editor.getByRole("button", { name: "On this device" }).click();
	await widescreenPreset.click();
	await editor
		.getByRole("textbox", { name: "AI resize guidance" })
		.fill("Continue the background evenly");
	await editor.getByRole("button", { name: "Generate AI resize" }).click();
	await expect(editor.getByText("960 × 540 px")).toBeVisible();
	await expect(
		editor.getByRole("status").filter({ hasText: "AI resized to Widescreen." })
	).toBeVisible();

	await clickOverflowAction(editor, "Add transparent padding");
	await editor
		.getByRole("spinbutton", { name: "Transparent padding per side" })
		.fill("16");
	await editor
		.getByRole("button", { name: "Apply transparent padding" })
		.click();
	await expect(editor.getByText("992 × 572 px")).toBeVisible();

	await editor.getByRole("button", { name: "Markup brush" }).click();
	await expect(
		editor.getByRole("button", { name: "Markup brush" })
	).toHaveAttribute("aria-pressed", "true");
	const markBox = await canvas.boundingBox();
	if (!markBox) {
		throw new Error("The markup canvas has no visible bounds.");
	}
	await page.mouse.move(
		markBox.x + markBox.width * 0.35,
		markBox.y + markBox.height * 0.5
	);
	await page.mouse.down();
	await page.mouse.move(
		markBox.x + markBox.width * 0.65,
		markBox.y + markBox.height * 0.5,
		{
			steps: 4,
		}
	);
	await page.mouse.up();
	await expect(
		editor.getByRole("status").filter({ hasText: "Markup added." })
	).toBeVisible();
	await editor.getByRole("button", { name: "Add comment" }).click();
	await expect(
		editor.getByRole("button", { name: "Add comment" })
	).toHaveAttribute("aria-pressed", "true");
	await editor
		.getByRole("textbox", { name: "Comment text" })
		.fill("Keep this subject");
	await canvas.click({
		position: { x: markBox.width * 0.7, y: markBox.height * 0.4 },
	});
	await expect(
		editor.getByRole("status").filter({ hasText: "Comment added." })
	).toBeVisible();

	const proofPath = proofEvidencePath(
		"image-editing/image-editor-chatgpt-toolbar-proof.png"
	);
	await mkdir(path.dirname(proofPath), { recursive: true });
	await page.screenshot({ path: proofPath, fullPage: false });

	await editor
		.getByRole("button", { name: "Add edited image to chat" })
		.click();
	await expect(editor).toHaveCount(0);
	await expect(page.getByTestId("attached-file")).toHaveText(
		"Attached to composer: sample-edited.png"
	);
	await expectImageOverlaysClosed(page);
	expect(pageErrors).toEqual([]);
});

test("downloads an edited PNG", async ({ page }) => {
	const editor = await openImageEditor(page);
	const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
	await editor.getByRole("button", { name: "Download edited PNG" }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe("sample-edited.png");
});

test("production AI Resize sends configured routing, preserves failure, and retries the same shape once", async ({
	page,
}, testInfo) => {
	const fixture = await installProductionResizeFixture(page);
	const editor = await openImageEditor(page, "?production-api");
	fixture.failNext();
	await startGatewayResize(editor);
	await expect(
		editor.getByText(
			"Configured image engine is unavailable; retry this resize."
		)
	).toBeVisible();
	await expect(editor.getByText("640 × 480 px", { exact: true })).toBeVisible();
	await expect(page.getByTestId("attachment-count")).toHaveText("0");
	await editor.getByRole("button", { name: "Generate AI resize" }).click();
	await expect(editor.getByText("960 × 540 px", { exact: true })).toBeVisible();
	const generations = fixture.calls.filter(
		(call) => call.path === "/api/images/generate"
	);
	expect(generations).toHaveLength(2);
	expect(generations[0].body).toEqual(generations[1].body);
	expect(generations[0].body).toEqual({
		n: 1,
		provider: "openrouter",
		model: "google/gemini-image-fixture",
		size: "1536x864",
		input_images: [expect.stringMatching(/^data:image\/png;base64,/)],
		prompt:
			"Generatively expand this image to widescreen (1.78:1). Preserve the original subject, composition, colors, lighting, and style. Do not crop or stretch the source. Extend the scene naturally only into the added canvas area, matching its edges. Additional guidance: Continue the sunset",
	});
	expect(
		fixture.calls.filter((call) => call.path === "/api/gateway/config")
	).toHaveLength(2);
	await editor
		.getByRole("button", { name: "Add edited image to chat" })
		.click();
	await expect(page.getByTestId("attachment-count")).toHaveText("1");
	await expectImageOverlaysClosed(page);
	await page.screenshot({
		path: testInfo.outputPath("resize-retry-attached.png"),
		animations: "disabled",
	});
	expect(fixture.unexpected).toEqual([]);
});

test("closing the old image during decode cannot replace a new image or unlock its pending resize", async ({
	page,
}, testInfo) => {
	await installPrimitiveGates(page);
	const fixture = await installProductionResizeFixture(page);
	const editor = await openImageEditor(page, "?production-api");
	await page.evaluate(() => {
		window.__imageResizePrimitives.holdNextDecode = true;
	});
	await startGatewayResize(editor);
	await expect
		.poll(() =>
			page.evaluate(() => window.__imageResizePrimitives.decodeStarted)
		)
		.toBe(true);
	// The owner replaces the image prop while decoding is outstanding, matching
	// ChatPage opening a different attachment in the same editor instance.
	await page
		.getByTestId("replace-editor-image")
		.evaluate((button) => button.click());
	await expect(editor.getByText("320 × 200 px", { exact: true })).toBeVisible();
	fixture.holdNext();
	await startGatewayResize(editor);
	await expect.poll(fixture.pending).toBe(true);
	await page.evaluate(() => window.__imageResizePrimitives.releaseDecode());
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	await page.screenshot({
		path: testInfo.outputPath("resize-after-obsolete-decode.png"),
		animations: "disabled",
	});
	await expect(editor.getByText("320 × 200 px", { exact: true })).toBeVisible();
	await expect(
		editor.getByRole("button", { name: "Generate AI resize" })
	).toBeDisabled();
	await expect(page.getByTestId("attachment-count")).toHaveText("0");
	fixture.release();
	await expect(editor.getByText("960 × 540 px", { exact: true })).toBeVisible();
	expect(fixture.unexpected).toEqual([]);
});

test("same-turn attach activations export and attach the real canvas only once", async ({
	page,
}, testInfo) => {
	await installPrimitiveGates(page);
	const fixture = await installProductionResizeFixture(page);
	const editor = await openImageEditor(page, "?production-api");
	await page.evaluate(() => {
		window.__imageResizePrimitives.holdExport = true;
	});
	await editor
		.getByRole("button", { name: "Add edited image to chat" })
		.evaluate((button) => {
			button.click();
			button.click();
		});
	await expect
		.poll(() => page.evaluate(() => window.__imageResizePrimitives.exportCount))
		.toBe(1);
	await expect(page.getByTestId("attachment-count")).toHaveText("0");
	await expect
		.poll(() =>
			page.evaluate(() => window.__imageResizePrimitives.exportReadyCount)
		)
		.toBe(1);
	await page.evaluate(() => window.__imageResizePrimitives.releaseExports());
	await expect(editor).toHaveCount(0);
	await expect(page.getByTestId("attachment-count")).toHaveText("1");
	await expect(page.getByTestId("attached-file")).toHaveText(
		"Attached to composer: sample-edited.png"
	);
	await expectImageOverlaysClosed(page);
	await page.screenshot({
		path: testInfo.outputPath("single-canvas-attachment.png"),
		animations: "disabled",
	});
	expect(fixture.calls).toEqual([]);
	expect(fixture.unexpected).toEqual([]);
});

test("production local resize sends its prepared canvas and mask without consulting Gateway routing", async ({
	page,
}, testInfo) => {
	const fixture = await installProductionResizeFixture(page);
	const editor = await openImageEditor(page, "?production-api");
	await editor.getByRole("button", { name: "AI Resize", exact: true }).click();
	await editor.getByRole("button", { name: /Resize to Widescreen/ }).click();
	await editor.getByRole("button", { name: "Generate AI resize" }).click();
	await expect(editor.getByText("960 × 540 px", { exact: true })).toBeVisible();
	expect(fixture.calls).toHaveLength(1);
	expect(fixture.calls[0].path).toBe("/api/images/generate");
	expect(fixture.calls[0].body).toEqual({
		n: 1,
		provider: "local",
		size: "1472x832",
		denoising_strength: 0.9,
		input_images: [expect.stringMatching(/^data:image\/png;base64,/)],
		input_mask: expect.stringMatching(/^data:image\/png;base64,/),
		prompt:
			"Generatively expand this image to widescreen (1.78:1). Preserve the original subject, composition, colors, lighting, and style. Do not crop or stretch the source. Extend the scene naturally only into the added canvas area, matching its edges.",
	});
	const pixels = await page.evaluate(
		async (body) => {
			const input = await createImageBitmap(
				await (await fetch(body.input_images[0])).blob()
			);
			const mask = await createImageBitmap(
				await (await fetch(body.input_mask)).blob()
			);
			const sizes = {
				image: [input.width, input.height],
				mask: [mask.width, mask.height],
			};
			input.close();
			mask.close();
			return sizes;
		},
		z
			.object({
				input_images: z.array(z.string()).min(1),
				input_mask: z.string(),
			})
			.parse(fixture.calls[0].body)
	);
	expect(pixels).toEqual({ image: [1472, 832], mask: [1472, 832] });
	await page.screenshot({
		path: testInfo.outputPath("local-resize-caller-completed.png"),
		animations: "disabled",
	});
	expect(fixture.unexpected).toEqual([]);
});

test("lightbox to editor handoff restores the owner's original nonempty body styles", async ({
	page,
}, testInfo) => {
	const fixture = await installProductionResizeFixture(page);
	const originalBody = { overflow: "scroll", paddingRight: "17px" };
	const editor = await openImageEditor(page, "?production-api", originalBody);
	await expect
		.poll(() => page.evaluate(() => document.body.style.overflow))
		.toBe("hidden");
	await editor
		.getByRole("button", { name: "Add edited image to chat" })
		.click();
	await expect(page.getByTestId("attachment-count")).toHaveText("1");
	await expectImageOverlaysClosed(page, originalBody);
	await expect(page.getByTestId("attached-file")).toHaveText(
		"Attached to composer: sample-edited.png"
	);
	expect(fixture.calls).toEqual([]);
	expect(fixture.unexpected).toEqual([]);
	await page.screenshot({
		path: testInfo.outputPath("original-body-styles-restored.png"),
		animations: "disabled",
	});
});
