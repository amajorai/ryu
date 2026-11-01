import { expect, type Locator, type Page } from "@playwright/test";
import type { ProofJsonRecord } from "./fixture-json.ts";
import { GATEWAY_CONFIG_REQUIRED_SECTIONS } from "./harness/gateway-proof-contracts.ts";

export async function clickOverflowAction(
	editor: Locator,
	name: string
): Promise<void> {
	await editor.getByRole("button", { name: "Show extra actions" }).click();
	await editor.getByRole("button", { name }).click();
}

export async function expectImageOverlaysClosed(
	page: Page,
	expectedBody = { overflow: "", paddingRight: "" }
): Promise<void> {
	// AnimatePresence may retain the lightbox after the editor has closed.
	// Completion requires the whole modal stack to leave, not just Edit image.
	await expect(page.getByRole("dialog", { includeHidden: true })).toHaveCount(
		0
	);
	await expect(page.locator("[data-lightbox-focus]")).toHaveCount(0);
	await expect
		.poll(() =>
			page.evaluate(() => ({
				overflow: document.body.style.overflow,
				paddingRight: document.body.style.paddingRight,
				pointerEvents: document.body.style.pointerEvents,
				scrollLock: document.body.getAttribute("data-scroll-locked"),
			}))
		)
		.toEqual({ ...expectedBody, pointerEvents: "", scrollLock: null });
	await expect(page.getByTestId("open-sample-image")).toBeFocused();
}

export async function openImageEditor(
	page: Page,
	query = "",
	bodyStyle?: { overflow: string; paddingRight: string }
): Promise<Locator> {
	await page.goto(`/image-editor-proof.html${query}`, {
		waitUntil: "domcontentloaded",
	});
	if (bodyStyle) {
		await page.evaluate((style) => {
			document.body.style.overflow = style.overflow;
			document.body.style.paddingRight = style.paddingRight;
		}, bodyStyle);
	}
	await page.getByTestId("open-sample-image").click();
	const lightbox = page.getByRole("dialog");
	await expect(lightbox).toBeVisible();
	await lightbox.getByRole("button", { name: "Annotate sample.png" }).click();
	const editor = page.getByRole("dialog", { name: "Edit image" });
	await expect(editor).toBeVisible();
	await expect(editor.getByTestId("image-editor-canvas")).toBeVisible();
	await expect(
		editor.getByRole("button", { name: "Download edited PNG" })
	).toBeEnabled();
	return editor;
}

export interface ResizePrimitiveControl {
	decodeStarted: boolean;
	exportCount: number;
	exportReadyCount: number;
	holdExport: boolean;
	holdNextDecode: boolean;
	releaseDecode: () => void;
	releaseExports: () => void;
}

declare global {
	interface Window {
		__imageResizePrimitives: ResizePrimitiveControl;
	}
}

export async function installPrimitiveGates(page: Page) {
	await page.addInitScript(() => {
		const exportReleases: (() => void)[] = [];
		const controls: ResizePrimitiveControl = {
			decodeStarted: false,
			holdNextDecode: false,
			holdExport: false,
			exportCount: 0,
			exportReadyCount: 0,
			releaseDecode: () => {
				throw new Error("No paused bitmap decode");
			},
			releaseExports: () => {
				controls.holdExport = false;
				controls.exportReadyCount = 0;
				for (const release of exportReleases.splice(0)) {
					release();
				}
			},
		};
		window.__imageResizePrimitives = controls;
		const nativeBitmap = window.createImageBitmap.bind(window);
		window.createImageBitmap = async (
			source: ImageBitmapSource,
			...options:
				| [options?: ImageBitmapOptions]
				| [
						sx: number,
						sy: number,
						sw: number,
						sh: number,
						options?: ImageBitmapOptions,
				  ]
		) => {
			let bitmap: ImageBitmap;
			switch (options.length) {
				case 0:
					bitmap = await nativeBitmap(source);
					break;
				case 1:
					bitmap = await nativeBitmap(source, ...options);
					break;
				case 4:
				case 5:
					bitmap = await nativeBitmap(source, ...options);
					break;
				default:
					throw new Error(
						"The bitmap fixture requires a native options or crop argument list."
					);
			}
			if (controls.holdNextDecode) {
				controls.holdNextDecode = false;
				controls.decodeStarted = true;
				await new Promise<void>((resolve) => {
					controls.releaseDecode = resolve;
				});
			}
			return bitmap;
		};
		const nativeToBlob = HTMLCanvasElement.prototype.toBlob;
		HTMLCanvasElement.prototype.toBlob = function (
			callback: BlobCallback,
			type?: string,
			quality?: number
		) {
			if (!controls.holdExport) {
				nativeToBlob.call(this, callback, type, quality);
				return;
			}
			controls.exportCount += 1;
			nativeToBlob.call(
				this,
				(blob) => {
					if (!controls.holdExport) {
						callback(blob);
						return;
					}
					exportReleases.push(() => callback(blob));
					controls.exportReadyCount = exportReleases.length;
				},
				type,
				quality
			);
		};
	});
}

export async function installProductionResizeFixture(page: Page) {
	const calls: { path: string; body: ProofJsonRecord | null }[] = [];
	const unexpected: string[] = [];
	let failNext = false;
	let holdNext = false;
	let releaseGeneration: () => void = () => {
		throw new Error("No deferred generation");
	};
	let generationPending = false;
	await page.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (
			["fetch", "xhr"].includes(request.resourceType()) &&
			url.pathname.startsWith("/api/")
		) {
			unexpected.push(
				`${request.method()} ${url.origin}${url.pathname}: unexpected API origin`
			);
			await route.fulfill({
				status: 501,
				json: { error: "Unrecognized image API origin" },
			});
			return;
		}
		await route.fallback();
	});
	await page.route("https://image-node.example.test/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method();
		const headers = request.headers();
		const configRead =
			method === "GET" &&
			url.pathname === "/api/gateway/config" &&
			!request.postData();
		const generation =
			method === "POST" && url.pathname === "/api/images/generate";
		if (
			!(configRead || generation) ||
			url.search ||
			headers.authorization !== "Bearer image-node-fixture-token" ||
			headers["x-ryu-user-jwt"]
		) {
			unexpected.push(
				`${method} ${url.pathname}: unexpected route, method, query or identity`
			);
			await route.fulfill({
				status: 501,
				json: { error: "Image fixture contract refused" },
			});
			return;
		}
		calls.push({
			path: url.pathname,
			body: generation ? request.postDataJSON() : null,
		});
		if (configRead) {
			// The desktop validates the whole Gateway config response
			// (gatewayConfigResponseSchema), so serve the required sections too.
			await route.fulfill({
				json: {
					...GATEWAY_CONFIG_REQUIRED_SECTIONS,
					routing: {
						default_provider: "local",
						fallback_chain: [],
						model_map: {},
						modality_map: {
							image: {
								provider: "openrouter",
								model: "google/gemini-image-fixture",
							},
						},
					},
				},
			});
			return;
		}
		if (holdNext) {
			holdNext = false;
			generationPending = true;
			await new Promise<void>((resolve) => {
				releaseGeneration = resolve;
			});
			generationPending = false;
		}
		if (failNext) {
			failNext = false;
			await route.fulfill({
				status: 503,
				json: {
					error: "Configured image engine is unavailable; retry this resize.",
				},
			});
			return;
		}
		const output = await page.evaluate(() => {
			const canvas = document.createElement("canvas");
			canvas.width = 960;
			canvas.height = 540;
			const context = canvas.getContext("2d");
			if (!context) {
				throw new Error("Cannot draw API output fixture");
			}
			context.fillStyle = "#357454";
			context.fillRect(0, 0, 960, 540);
			return canvas.toDataURL("image/png").split(",")[1];
		});
		await route.fulfill({ json: { data: [{ b64_json: output }] } });
	});
	return {
		calls,
		unexpected,
		failNext: () => {
			failNext = true;
		},
		holdNext: () => {
			holdNext = true;
		},
		pending: () => generationPending,
		release: () => releaseGeneration(),
	};
}

export async function startGatewayResize(editor: Locator) {
	await editor.getByRole("button", { name: "AI Resize", exact: true }).click();
	await editor.getByRole("button", { name: "Gateway model" }).click();
	await editor.getByRole("button", { name: /Resize to Widescreen/ }).click();
	await editor
		.getByRole("textbox", { name: "AI resize guidance" })
		.fill("Continue the sunset");
	await editor.getByRole("button", { name: "Generate AI resize" }).click();
}
