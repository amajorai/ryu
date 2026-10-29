import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, test } from "@playwright/test";

async function waitForModelResult(
	status: Locator,
	alert: Locator,
	resultPattern: RegExp,
	timeout: number
): Promise<void> {
	const result = status.filter({ hasText: resultPattern });
	const outcome = await Promise.race([
		result.waitFor({ state: "visible", timeout }).then(() => "ready" as const),
		alert.waitFor({ state: "visible", timeout }).then(() => "error" as const),
	]);
	if (outcome === "error") {
		throw new Error((await alert.innerText()).trim());
	}
}

test("runs both browser-local image models without sending image data out", async ({
	page,
}) => {
	test.setTimeout(20 * 60 * 1000);
	const outboundRequests: Array<{ method: string; url: string }> = [];
	page.on("request", (request) => {
		const requestUrl = new URL(request.url());
		if (
			requestUrl.hostname !== "127.0.0.1" &&
			requestUrl.hostname !== "localhost"
		) {
			outboundRequests.push({ method: request.method(), url: request.url() });
		}
	});

	await page.goto("/image-editor-proof.html?live-models", {
		waitUntil: "domcontentloaded",
	});
	await page.getByTestId("open-sample-image").click();
	const lightbox = page.getByRole("dialog");
	await lightbox.getByRole("button", { name: "Annotate sample.png" }).click();
	const editor = page.getByRole("dialog", { name: "Edit image" });
	await expect(editor).toBeVisible();

	await editor.getByRole("button", { name: "Show extra actions" }).click();
	await editor
		.getByRole("button", { name: "Select a detected subject" })
		.click();
	await waitForModelResult(
		editor.getByRole("status"),
		editor.getByRole("alert"),
		/subjects? found\./i,
		15 * 60 * 1000
	);
	const detectedSubjects = editor.getByRole("group", {
		name: "Detected subjects",
	});
	await expect(detectedSubjects).toBeVisible();
	expect(await detectedSubjects.getByRole("button").count()).toBeGreaterThan(0);
	await editor.getByRole("button", { name: "Remove background" }).click();
	await waitForModelResult(
		editor.getByRole("status"),
		editor.getByRole("alert"),
		/Background removed\./i,
		10 * 60 * 1000
	);
	const alphaCoverage = await editor
		.getByTestId("image-editor-canvas")
		.evaluate((element) => {
			if (!(element instanceof HTMLCanvasElement)) {
				return { opaque: 0, transparent: 0 };
			}
			const context = element.getContext("2d");
			if (!context) {
				return { opaque: 0, transparent: 0 };
			}
			const { data } = context.getImageData(
				0,
				0,
				element.width,
				element.height
			);
			let opaque = 0;
			let transparent = 0;
			for (let offset = 3; offset < data.length; offset += 4) {
				if (data[offset] === 0) {
					transparent += 1;
				} else {
					opaque += 1;
				}
			}
			return { opaque, transparent };
		});
	expect(alphaCoverage.opaque).toBeGreaterThan(100);
	expect(alphaCoverage.transparent).toBeGreaterThan(100);
	expect(
		outboundRequests.every(
			({ method }) => method === "GET" || method === "HEAD"
		)
	).toBe(true);

	const proofPath = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/image-editing/image-editor-live-models.png"
	);
	await mkdir(path.dirname(proofPath), { recursive: true });
	await page.screenshot({ path: proofPath, fullPage: false });
});
