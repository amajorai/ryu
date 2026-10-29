import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import type { VideoPreviewApi } from "./harness/video-preview-regression.types.ts";
declare global {
	interface Window {
		__videoPreview: VideoPreviewApi;
	}
}
async function mount(page: Page): Promise<{
	frame: FrameLocator;
	imageA: string;
	imageB: string;
	ids: { A: string; B: string };
}> {
	await page.goto("/");
	await page.waitForSelector("body[data-harness-ready='1']");
	const images = await page.evaluate(() => {
		const make = (width: number, color: string) => {
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = 8;
			const context = canvas.getContext("2d");
			if (!context) {
				throw new Error("Browser image fixture creation failed.");
			}
			context.fillStyle = color;
			context.fillRect(0, 0, width, 8);
			return canvas.toDataURL("image/jpeg").split(",")[1] ?? "";
		};
		return { imageA: make(8, "red"), imageB: make(16, "blue") };
	});
	const appHtml = await readFile(
		path.join(
			tmpdir(),
			"ryu-video-preview-widget-build/video-preview-widget.html"
		),
		"utf8"
	);
	await page.evaluate((input) => window.__videoPreview.mount(input), {
		appHtml,
		...images,
	});
	await expect
		.poll(() => page.evaluate(() => window.__videoPreview.connected()))
		.toBe(true);
	const frame = page.frameLocator('iframe[title="Video preview regression"]');
	await expect(
		frame.getByRole("button", {
			name: "Retry unavailable previews",
			exact: true,
		})
	).toBeEnabled();
	return {
		frame,
		...images,
		ids: await page.evaluate(() => window.__videoPreview.ids()),
	};
}
async function calls(page: Page) {
	return await page.evaluate(() => window.__videoPreview.calls());
}

test("Video preview Retry reloads only the selected failed asset and displays a genuinely decoded JPEG without repeated equivalent-selection work", async ({
	page,
}) => {
	const { frame, imageA, ids } = await mount(page);
	expect(await calls(page)).toEqual([
		{ path: `/assets/${ids.A}/thumbnail`, method: "GET", status: "refused" },
	]);
	await page.evaluate(() => {
		window.__videoPreview.renderEquivalentSelection();
		window.__videoPreview.holdNext("A");
	});
	await frame
		.getByRole("button", { name: "Retry unavailable previews", exact: true })
		.click();
	try {
		await expect.poll(async () => (await calls(page)).length).toBe(2);
		await page.evaluate(() =>
			window.__videoPreview.renderEquivalentSelection()
		);
		await expect(frame.getByText("Loading…", { exact: true })).toBeVisible();
		await expect(
			frame.getByRole("button", {
				name: "Retry unavailable previews",
				exact: true,
			})
		).toHaveCount(0);
		expect(await calls(page)).toHaveLength(2);
	} finally {
		await page.evaluate(() => window.__videoPreview.release("A", true));
	}
	const image = frame.getByRole("img", { name: "Scene 1 take", exact: true });
	await expect(image).toHaveAttribute(
		"src",
		`data:image/jpeg;base64,${imageA}`
	);
	await expect
		.poll(() =>
			image.evaluate((element: HTMLImageElement) => [
				element.naturalWidth,
				element.naturalHeight,
			])
		)
		.toEqual([8, 8]);
	await expect(frame.getByTestId("preview-status")).toHaveText("");
	expect(await calls(page)).toEqual([
		{ path: `/assets/${ids.A}/thumbnail`, method: "GET", status: "refused" },
		{ path: `/assets/${ids.A}/thumbnail`, method: "GET", status: "accepted" },
	]);
});

for (const outcome of ["success", "refusal"] as const) {
	test(`Video old selected take ${outcome} cannot replace the current take or leak its failure while the new thumbnail is pending`, async ({
		page,
	}) => {
		const { frame, imageB, ids } = await mount(page);
		await page.evaluate(() => window.__videoPreview.holdNext("A"));
		await frame
			.getByRole("button", { name: "Retry unavailable previews", exact: true })
			.click();
		await expect
			.poll(
				async () =>
					(await calls(page)).filter(
						(call) => call.path === `/assets/${ids.A}/thumbnail`
					).length
			)
			.toBe(2);
		await page.evaluate(() => window.__videoPreview.select("B", true));
		await expect
			.poll(
				async () =>
					(await calls(page)).filter(
						(call) => call.path === `/assets/${ids.B}/thumbnail`
					).length
			)
			.toBe(1);
		await page.evaluate(
			(accept) => window.__videoPreview.release("A", accept),
			outcome === "success"
		);
		try {
			await expect
				.poll(
					async () =>
						(await calls(page)).filter(
							(call) =>
								call.path === `/assets/${ids.A}/thumbnail` &&
								call.status === "pending"
						).length
				)
				.toBe(0);
			await expect(
				frame.getByTestId("received-preview-completions")
			).toHaveText(
				JSON.stringify([
					{ path: `/assets/${ids.A}/thumbnail`, outcome: "refused" },
					{
						path: `/assets/${ids.A}/thumbnail`,
						outcome: outcome === "success" ? "accepted" : "refused",
					},
				])
			);
			await expect(
				frame.getByText("Scene 1: B selected scene", { exact: true })
			).toBeVisible();
			await expect(frame.getByText("Loading…", { exact: true })).toBeVisible();
			await expect(
				frame.getByRole("img", { name: "Scene 1 take", exact: true })
			).toHaveCount(0);
			await expect(frame.getByTestId("preview-status")).toHaveText("");
		} finally {
			await page.evaluate(() => window.__videoPreview.release("B", true));
		}
		const image = frame.getByRole("img", { name: "Scene 1 take", exact: true });
		await expect(image).toHaveAttribute(
			"src",
			`data:image/jpeg;base64,${imageB}`
		);
		await expect
			.poll(() =>
				image.evaluate((element: HTMLImageElement) => [
					element.naturalWidth,
					element.naturalHeight,
				])
			)
			.toEqual([16, 8]);
		expect(
			(await calls(page)).every(
				(call) => call.method === "GET" && call.body === undefined
			)
		).toBe(true);
		expect(await calls(page)).toHaveLength(3);
	});
}
