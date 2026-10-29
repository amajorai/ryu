import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import type { DrawesomeSketchAttachment } from "../src/components/chat/DrawesomeSketchDialog.tsx";
const INLINE_REFERENCE_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=";

interface DialogApi {
	mount(input: {
		appHtml: string;
		sourceImage?: { filename: string; url: string };
	}): void;
	requests(): Array<{ method: string; path: string }>;
	attachments(): DrawesomeSketchAttachment[];
	unknownRequests(): string[];
}
declare global {
	interface Window {
		__drawesomeDialog: DialogApi;
		__holdDrawesomePng(size: number): Promise<void>;
	}
}
async function mount(
	page: Page,
	sourceImage?: { filename: string; url: string }
) {
	await page.goto("/");
	await page.waitForSelector("body[data-harness-ready='1']");
	const appHtml = await readFile(
		path.join(
			tmpdir(),
			"ryu-drawesome-dialog-regression-drawesome-build/index.html"
		),
		"utf8"
	);
	await page.evaluate((input) => window.__drawesomeDialog.mount(input), {
		appHtml,
		sourceImage,
	});
	await page
		.getByRole("button", { name: "Open actual sketch dialog", exact: true })
		.click();
	await expect(page.locator('[data-plugin-state="connected"]')).toBeVisible();
	const frame = page.frameLocator('iframe[title="Plugin: Drawesome"]');
	await expect(frame.getByTestId("drawesome-sketch-dialog")).toBeVisible();
	return frame;
}
async function draw(page: Page, frame: FrameLocator) {
	const box = await frame
		.locator("svg.drawesome-drawing-surface")
		.boundingBox();
	if (!box) {
		throw new Error("Missing production sketch surface.");
	}
	await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, {
		steps: 12,
	});
	await page.mouse.up();
}
test("actual Desktop Drawesome dialog rejects wrong source/token and invalid attachment, then consumes a real drawn PNG exactly once and closes", async ({
	page,
}) => {
	const frame = await mount(page);
	// A persisted main-app sketch is seeded in the finite Core fixture. A new
	// dialog must start independently and cannot read that durable sketch.
	await expect(frame.locator("svg.drawesome-drawing-surface path")).toHaveCount(
		0
	);
	await expect(
		frame.getByText("Previously saved private sketch", { exact: true })
	).toHaveCount(0);
	const attach = frame.getByRole("button", {
		name: "Attach sketch",
		exact: true,
	});
	await expect(attach).toBeDisabled();
	await frame.locator("body").evaluate(() => {
		const context = Reflect.get(
			Reflect.get(window, "ryu") ?? {},
			"context"
		) as {
			token: string;
		};
		window.parent.postMessage(
			{
				kind: "ryu-drawesome-dialog",
				token: "incorrect-token",
				action: "close",
			},
			"*"
		);
		window.parent.postMessage(
			{
				kind: "ryu-drawesome-dialog",
				token: context.token,
				action: "attach",
				file: {
					dataUrl: "data:text/plain;base64,YQ==",
					filename: "bad.txt",
					mimeType: "image/png",
					size: 1,
				},
			},
			"*"
		);
	});
	await expect(page.getByRole("dialog")).toBeVisible();
	expect(
		await page.evaluate(() => window.__drawesomeDialog.attachments())
	).toEqual([]);
	const token = await frame.locator("body").evaluate(
		() =>
			(
				Reflect.get(Reflect.get(window, "ryu") ?? {}, "context") as {
					token: string;
				}
			).token
	);
	await page.evaluate((token) => {
		const attacker = document.createElement("iframe");
		attacker.title = "Wrong source attacker";
		attacker.srcdoc = `<script>parent.postMessage(${JSON.stringify({ kind: "ryu-drawesome-dialog", token, action: "close" })},'*')</script>`;
		document.body.append(attacker);
	}, token);
	await expect(page.getByRole("dialog")).toBeVisible();
	expect(
		await page.evaluate(() => window.__drawesomeDialog.attachments())
	).toEqual([]);
	await draw(page, frame);
	await expect(attach).toBeEnabled();
	await attach.click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	const attachments = await page.evaluate(() =>
		window.__drawesomeDialog.attachments()
	);
	expect(attachments).toHaveLength(1);
	const attachment = attachments[0];
	expect(attachment).toMatchObject({
		filename: "sketch.png",
		mimeType: "image/png",
	});
	if (!attachment) {
		throw new Error("No production consumer attachment.");
	}
	const png = Buffer.from(attachment.dataUrl.split(",")[1] ?? "", "base64");
	expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
	expect(attachment.size).toBe(png.length);
	expect(png.readUInt32BE(16)).toBeGreaterThan(0);
	expect(png.readUInt32BE(20)).toBeGreaterThan(0);
	expect(
		await page.evaluate(() => window.__drawesomeDialog.unknownRequests())
	).toEqual([]);
	expect(
		(await page.evaluate(() => window.__drawesomeDialog.requests())).filter(
			(call) => call.path.includes("/storage")
		)
	).toEqual([]);
});
test("actual Desktop Drawesome Close cancels a physically drawn draft without attachment and reopening starts an empty independent dialog", async ({
	page,
}) => {
	const frame = await mount(page);
	await draw(page, frame);
	await expect(
		frame.getByRole("button", { name: "Attach sketch", exact: true })
	).toBeEnabled();
	await frame
		.getByRole("button", { name: "Close sketch", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(
		await page.evaluate(() => window.__drawesomeDialog.attachments())
	).toEqual([]);
	await page
		.getByRole("button", { name: "Open actual sketch dialog", exact: true })
		.click();
	await expect(
		frame.getByRole("button", { name: "Attach sketch", exact: true })
	).toBeDisabled();
	await expect(frame.locator("svg.drawesome-drawing-surface path")).toHaveCount(
		0
	);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(
		await page.evaluate(() => window.__drawesomeDialog.attachments())
	).toEqual([]);
	expect(
		await page.evaluate(() => window.__drawesomeDialog.unknownRequests())
	).toEqual([]);
	expect(
		(await page.evaluate(() => window.__drawesomeDialog.requests())).filter(
			(call) => call.path.includes("/storage")
		)
	).toEqual([]);
});

test("actual Desktop Drawesome cancelling held PNG preparation destroys its frame before a reopened dialog can attach", async ({
	page,
}) => {
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let preparationStarted = false;
	let preparationSettled = false;
	let preparedBytes = 0;
	await page.exposeBinding(
		"__holdDrawesomePng",
		async (_source, size: number) => {
			preparationStarted = true;
			preparedBytes = size;
			await held;
			preparationSettled = true;
		}
	);
	const frame = await mount(page, {
		filename: "reference.png",
		url: INLINE_REFERENCE_PNG,
	});
	await draw(page, frame);
	const attach = frame.getByRole("button", {
		name: "Attach sketch",
		exact: true,
	});
	const iframeHandle = await page
		.locator('iframe[title="Plugin: Drawesome"]')
		.elementHandle();
	const originalFrame = await iframeHandle?.contentFrame();
	if (!originalFrame) throw new Error("Missing original annotation frame.");
	// Hold completion of the real browser encoder after it has produced a PNG;
	// the callback receives its original bytes, never a substitute attachment.
	await originalFrame.evaluate(() => {
		const encode = HTMLCanvasElement.prototype.toBlob;
		HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
			encode.call(
				this,
				(blob) => {
					if (!blob) throw new Error("Actual canvas encoder returned no PNG");
					void window.__holdDrawesomePng(blob.size).then(() => callback(blob));
				},
				type,
				quality
			);
		};
	});
	await attach.click();
	try {
		await expect.poll(() => preparationStarted).toBe(true);
		expect(preparedBytes).toBeGreaterThan(0);
		await expect(attach).toBeDisabled();
		await attach.click({ force: true });
		expect(
			await page.evaluate(() => window.__drawesomeDialog.attachments())
		).toEqual([]);
		await frame
			.getByRole("button", { name: "Close sketch", exact: true })
			.click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect.poll(() => originalFrame.isDetached()).toBe(true);
		await page
			.getByRole("button", { name: "Open actual sketch dialog", exact: true })
			.click();
		await expect(
			frame.getByRole("button", { name: "Attach sketch", exact: true })
		).toBeDisabled();
	} finally {
		release();
	}
	await expect.poll(() => preparationSettled).toBe(true);
	await expect(page.locator('[data-plugin-state="connected"]')).toBeVisible();
	await expect(
		frame.getByRole("button", { name: "Attach sketch", exact: true })
	).toBeDisabled();
	await expect(frame.locator("svg.drawesome-drawing-surface path")).toHaveCount(
		0
	);
	expect(
		await page.evaluate(() => window.__drawesomeDialog.attachments())
	).toEqual([]);
	expect(
		await page.evaluate(() => window.__drawesomeDialog.unknownRequests())
	).toEqual([]);
});

test("actual Desktop Drawesome annotation refusal retains drawn draft; explicit retry consumes a real composite PNG with correct reported file bytes", async ({
	page,
}) => {
	const frame = await mount(page, {
		filename: "reference.png",
		url: INLINE_REFERENCE_PNG,
	});
	// A real canvas can refuse export (for example, a tainted source). Fail the
	// first native export, then restore it so retry produces actual composite bytes.
	await frame.locator("body").evaluate(() => {
		const exportPng = HTMLCanvasElement.prototype.toDataURL;
		HTMLCanvasElement.prototype.toDataURL = function () {
			HTMLCanvasElement.prototype.toDataURL = exportPng;
			throw new DOMException("Canvas export refused", "SecurityError");
		};
	});
	await draw(page, frame);
	const attach = frame.getByRole("button", {
		name: "Attach sketch",
		exact: true,
	});
	await attach.click();
	await expect(frame.getByRole("status")).toHaveText(
		"Could not prepare the sketch attachment"
	);
	await expect(attach).toBeEnabled();
	await expect(
		frame.locator("svg.drawesome-drawing-surface path")
	).not.toHaveCount(0);
	expect(
		await page.evaluate(() => window.__drawesomeDialog.attachments())
	).toEqual([]);
	await attach.click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	const attachments = await page.evaluate(() =>
		window.__drawesomeDialog.attachments()
	);
	expect(attachments).toHaveLength(1);
	const attachment = attachments[0];
	if (!attachment) {
		throw new Error("No actual annotated attachment.");
	}
	expect(attachment).toMatchObject({
		filename: "annotated-reference-png.png",
		mimeType: "image/png",
	});
	const png = Buffer.from(attachment.dataUrl.split(",")[1] ?? "", "base64");
	expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
	expect(png.readUInt32BE(16)).toBeGreaterThan(0);
	expect(png.readUInt32BE(20)).toBeGreaterThan(0);
	// Composite encoding produces new bytes. The actual consumer must receive
	// their size, rather than the intermediate overlay PNG's size.
	expect(attachment.size).toBe(png.length);
	expect(
		await page.evaluate(() => window.__drawesomeDialog.unknownRequests())
	).toEqual([]);
	expect(
		(await page.evaluate(() => window.__drawesomeDialog.requests())).filter(
			(call) => call.path.includes("/storage")
		)
	).toEqual([]);
});
