import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { slidesStateSchema } from "../../../apps-store/slides/ui/src/schemas.ts";
import type { ProofJsonRecord, ProofJsonValue } from "./fixture-json.ts";

// Cold Vite optimizes dependencies and compiles the whole ExtensionHost harness
// module graph on first navigation (about 14s with a fresh cache, as on CI),
// which the first test's long layer-edit flow would otherwise share with the
// 30s default.
test.describe.configure({ timeout: 90_000 });

const BUNDLE = "/tmp/ryu-slides-coverage-build/index.html";
const EVIDENCE = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);
const GRANTS = [
	"storage:kv",
	"media:generate",
	"hook:side-model",
	"files:download",
];

interface FixtureCall {
	args: ProofJsonRecord;
	method: string;
}
interface SlidesProofApi {
	calls: () => FixtureCall[];
	connected: () => boolean;
	mount: (options: {
		appHtml: string;
		grants: string[];
		pluginId: string;
	}) => void;
	persisted: () => ProofJsonValue;
	reset: () => void;
}

declare global {
	interface Window {
		__slidesProof: SlidesProofApi;
	}
}

async function mountApp(page: Page, reset = true): Promise<FrameLocator> {
	if (reset) {
		await page.goto("/slides-companion-proof.html");
	}
	if (reset) {
		await expect(page.locator("body")).toHaveAttribute(
			"data-harness-ready",
			"1"
		);
		await page.evaluate(() => window.__slidesProof.reset());
	}
	const appHtml = await readFile(BUNDLE, "utf8");
	await page.evaluate((options) => window.__slidesProof.mount(options), {
		appHtml,
		grants: GRANTS,
		pluginId: "@ryu/slides",
	});
	await expect
		.poll(() => page.evaluate(() => window.__slidesProof.connected()), {
			timeout: 20_000,
		})
		.toBe(true);
	return page.frameLocator('iframe[title="Slides behavior proof"]');
}

async function persisted(page: Page) {
	return slidesStateSchema
		.nullable()
		.parse(await page.evaluate(() => window.__slidesProof.persisted()));
}

async function waitForProjectCount(page: Page, count: number) {
	await expect
		.poll(async () => {
			// SAFETY: This proof mounts the exact Playwright-built native Slides bundle against its private scoped storage Map. App saveState persists model.serializeState projects/trash from the actual normalized Project and Layer constructors; this observer reads those authored bytes through the scoped storage RPC. No foreign storage JSON is validated by this view.
			const state = await persisted(page);
			return state?.projects?.length ?? 0;
		})
		.toBe(count);
}

async function saveEvidence(page: Page, name: string) {
	await mkdir(EVIDENCE, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE, name),
	});
}

async function makeProject(app: FrameLocator, name: string) {
	const emptyCreate = app.getByRole("button", { name: "Make a project" });
	if (await emptyCreate.count()) {
		await emptyCreate.click();
	} else {
		await app.getByRole("button", { name: "New project" }).click();
	}
	await app.getByRole("textbox", { name: "Project name" }).fill(name);
}

test("project and layer edits reorder, undo, redo, and persist through the host", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const app = await mountApp(page);
	await expect(app.getByRole("heading", { name: "Slides" })).toBeVisible();
	await makeProject(app, "Layered launch");
	await app.getByRole("option", { name: /Headline/ }).click();
	await app
		.getByRole("textbox", { name: "Text", exact: true })
		.fill("A clear launch signal");
	await app.getByRole("spinbutton", { name: "X", exact: true }).fill("140");
	await app.getByRole("spinbutton", { name: "Y", exact: true }).fill("220");
	await app.getByRole("spinbutton", { name: "Size", exact: true }).fill("68");
	await app
		.getByRole("combobox", { name: "Align", exact: true })
		.selectOption("center");
	await app.getByRole("button", { name: "Text color" }).click();
	await app.getByRole("textbox", { name: "Hex color value" }).fill("#224466");
	await page.keyboard.press("Escape");

	await app.getByRole("button", { name: "+ Text", exact: true }).click();
	await app.getByRole("option", { name: /Text layer/ }).click();
	await app
		.getByRole("textbox", { name: "Name", exact: true })
		.fill("Supporting copy");
	await app
		.getByRole("textbox", { name: "Text", exact: true })
		.fill("One frame at a time");
	await app
		.getByRole("spinbutton", { name: "Opacity", exact: true })
		.fill("0.65");
	await app.getByRole("button", { name: "Duplicate layer" }).click();
	await expect(
		app.getByRole("option", { name: /Supporting copy copy/ })
	).toBeVisible();
	const firstLayer = app
		.getByRole("listbox", { name: "Project layers" })
		.getByRole("option")
		.first();
	const beforeMove = await firstLayer.innerText();
	await app.getByRole("button", { name: "Move layer up" }).click();
	await expect.poll(() => firstLayer.innerText()).not.toBe(beforeMove);
	await app.getByRole("button", { name: "Move layer down" }).click();

	await app.getByRole("option", { name: /Signal shape/ }).click();
	await app
		.getByRole("combobox", { name: "Shape", exact: true })
		.selectOption("rectangle");
	await app.getByRole("button", { name: "Hide", exact: true }).click();
	await expect(
		app.getByRole("button", { name: "Show", exact: true })
	).toBeVisible();
	await app.getByRole("button", { name: "Undo" }).click();
	await expect(
		app.getByRole("button", { name: "Hide", exact: true })
	).toBeVisible();
	await app.getByRole("button", { name: "Redo" }).click();
	await expect(
		app.getByRole("button", { name: "Show", exact: true })
	).toBeVisible();
	await app.getByRole("button", { name: "Lock", exact: true }).click();
	await expect(
		app.locator('.slides-layer-state[aria-label="Locked"]')
	).toBeVisible();
	await app.getByRole("option", { name: /Supporting copy copy/ }).click();
	await app.getByRole("button", { name: "Delete layer" }).click();
	await expect(
		app.getByRole("option", { name: /Supporting copy copy/ })
	).toHaveCount(0);

	await expect
		.poll(async () => {
			// SAFETY: This proof mounts the exact Playwright-built native Slides bundle against its private scoped storage Map. App saveState persists model.serializeState projects/trash from the actual normalized Project and Layer constructors; this observer reads those authored bytes through the scoped storage RPC. No foreign storage JSON is validated by this view.
			const current = await persisted(page);
			const saved = current?.projects?.find(
				(item) => item.name === "Layered launch"
			);
			return {
				layerCount: saved?.layers.length ?? 0,
				hasDeletedDuplicate:
					saved?.layers.some(
						(layer) => layer.name === "Supporting copy copy"
					) ?? true,
				lockedShape:
					saved?.layers.some(
						(layer) =>
							layer.name === "Signal shape" &&
							layer.locked === true &&
							layer.visible === false
					) ?? false,
			};
		})
		.toEqual({ layerCount: 3, hasDeletedDuplicate: false, lockedShape: true });
	// SAFETY: This proof mounts the exact Playwright-built native Slides bundle against its private scoped storage Map. App saveState persists model.serializeState projects/trash from the actual normalized Project and Layer constructors; this observer reads those authored bytes through the scoped storage RPC. No foreign storage JSON is validated by this view.
	const stored = slidesStateSchema.parse(await persisted(page));
	const project = stored.projects[0];
	expect(project?.name).toBe("Layered launch");
	expect(project?.layers).toHaveLength(3);
	expect(project?.layers[0]).toMatchObject({
		align: "center",
		color: "#224466",
		fontSize: 68,
		text: "A clear launch signal",
		x: 140,
		y: 220,
	});
	expect(
		project?.layers.some(
			(layer) => layer.name === "Supporting copy" && layer.opacity === 0.65
		)
	).toBe(true);
	expect(project?.layers[1]).toMatchObject({
		locked: true,
		shape: "rectangle",
		visible: false,
	});
	expect(
		project?.layers.some((layer) => layer.name === "Supporting copy copy")
	).toBe(false);
	await saveEvidence(page, "slides-layer-edits-persisted.png");

	const reopened = await mountApp(page, false);
	await reopened.getByRole("button", { name: "Open Layered launch" }).click();
	await expect(
		reopened.getByRole("textbox", { name: "Text", exact: true })
	).toHaveValue("A clear launch signal");
	await expect(
		reopened.getByRole("combobox", { name: "Align", exact: true })
	).toHaveValue("center");
	await expect(
		reopened.getByRole("option", { name: /Supporting copy copy/ })
	).toHaveCount(0);
	await expect(
		reopened.getByRole("option", { name: /Signal shape/ })
	).toBeVisible();
	await expect(
		reopened.locator('.slides-layer-state[aria-label="Locked"]')
	).toBeVisible();
	await saveEvidence(page, "slides-layer-edits-reloaded.png");
	expect(pageErrors).toEqual([]);
});

test("gallery search, sort, favorites, trash, restore, and permanent removal update saved state", async ({
	page,
}) => {
	const app = await mountApp(page);
	await makeProject(app, "Beta notes");
	await app.getByRole("button", { name: "← Gallery" }).click();
	await makeProject(app, "Alpha cover");
	await app.getByRole("button", { name: "← Gallery" }).click();
	await makeProject(app, "Gamma demo");
	await app.getByRole("button", { name: "← Gallery" }).click();
	await waitForProjectCount(page, 3);

	await app.getByRole("button", { name: "Add Beta notes favorite" }).click();
	await app.getByRole("button", { name: /^Favorites/ }).click();
	await expect(
		app.getByRole("button", { name: "Open Beta notes" })
	).toBeVisible();
	await expect(
		app.getByRole("button", { name: "Open Alpha cover" })
	).toHaveCount(0);
	await app.getByRole("button", { name: /^Favorites/ }).click();
	await app.getByLabel("Search projects").fill("gamma");
	await expect(
		app.getByRole("button", { name: "Open Gamma demo" })
	).toBeVisible();
	await expect(
		app.getByRole("button", { name: "Open Alpha cover" })
	).toHaveCount(0);
	await app.getByLabel("Search projects").fill("");
	await app.getByLabel("Sort projects").selectOption("name");
	await expect(app.locator(".slides-project-copy strong")).toHaveText([
		"Alpha cover",
		"Beta notes",
		"Gamma demo",
	]);

	await app.getByRole("checkbox", { name: "Select Beta notes" }).check();
	await app.getByRole("button", { name: "Move 1 to trash" }).click();
	await expect(
		app.getByRole("button", { name: "Open Beta notes" })
	).toHaveCount(0);
	await app.getByRole("button", { name: /^Trash/ }).click();
	await expect(app.getByText("Beta notes", { exact: true })).toBeVisible();
	await app.getByRole("button", { name: "Restore", exact: true }).click();
	await expect(
		app.getByRole("button", { name: "Open Beta notes" })
	).toBeVisible();
	await app.getByRole("button", { name: /^Trash/ }).click();
	await app.getByRole("checkbox", { name: "Select Gamma demo" }).check();
	await app.getByRole("button", { name: "Move 1 to trash" }).click();
	await app.getByRole("button", { name: /^Trash/ }).click();
	await app.getByRole("button", { name: "Empty trash" }).click();
	await expect(app.getByText("Nothing is waiting here.")).toBeVisible();
	await expect
		.poll(async () => {
			// SAFETY: This proof mounts the exact Playwright-built native Slides bundle against its private scoped storage Map. App saveState persists model.serializeState projects/trash from the actual normalized Project and Layer constructors; this observer reads those authored bytes through the scoped storage RPC. No foreign storage JSON is validated by this view.
			const state = (await persisted(page)) as {
				projects?: Array<{ name: string }>;
				trash?: unknown[];
			} | null;
			return {
				projectNames: state?.projects?.map((item) => item.name).sort() ?? [],
				trashedCount: state?.trash?.length ?? -1,
			};
		})
		.toEqual({ projectNames: ["Alpha cover", "Beta notes"], trashedCount: 0 });

	// SAFETY: This proof mounts the exact Playwright-built native Slides bundle against its private scoped storage Map. App saveState persists model.serializeState projects/trash from the actual normalized Project and Layer constructors; this observer reads those authored bytes through the scoped storage RPC. No foreign storage JSON is validated by this view.

	const finalState = (await persisted(page)) as {
		projects: Array<{ favorite: boolean; name: string }>;
		trash: unknown[];
	};
	expect(finalState.projects.map((item) => item.name).sort()).toEqual([
		"Alpha cover",
		"Beta notes",
	]);
	expect(
		finalState.projects.find((item) => item.name === "Beta notes")?.favorite
	).toBe(true);
	expect(finalState.trash).toHaveLength(0);
	await saveEvidence(page, "slides-gallery-trash-and-favorites.png");

	const reopened = await mountApp(page, false);
	await expect(
		reopened.getByRole("button", { name: "Remove Beta notes favorite" })
	).toHaveAttribute("aria-pressed", "true");
});

test("carousel design, host-backed model drafting, preview navigation, and image generation work", async ({
	page,
}) => {
	const app = await mountApp(page);
	await makeProject(app, "Draft workspace");
	await app.getByLabel("Topic").fill("Clear launch communication");
	await app.getByLabel("Frames").fill("3");
	await app.getByRole("button", { name: "Draft carousel" }).click();
	await expect(
		app.getByText("3 carousel frames added to the gallery.")
	).toBeVisible();
	await waitForProjectCount(page, 4);
	const modelCall = await page.evaluate(() =>
		window.__slidesProof
			.calls()
			.find((call) => call.method === "model.complete")
	);
	expect(modelCall?.args).toMatchObject({
		effort: "medium",
		system:
			"You are a concise visual editor. Return only valid JSON. Never include markdown fences or HTML.",
	});
	expect(String(modelCall?.args.prompt)).toContain(
		"Clear launch communication"
	);
	expect(String(modelCall?.args.prompt)).toContain(
		"Create 3 concise visual slides"
	);

	await app.getByLabel("Frame role").selectOption("closing");
	await app.getByLabel("Carousel theme").selectOption("ai-engineer");
	await app.getByLabel("Series title").fill("Clear launch story");
	await app.getByLabel("Series title").blur();
	await app.getByLabel("Series mark").fill("Ryu Studio");
	await app.getByLabel("Series mark").blur();
	await app.getByLabel("Author").fill("Product team");
	await app.getByLabel("Author").blur();
	await app.getByRole("switch").nth(0).click();
	await app.getByRole("switch").nth(1).click();
	await app.getByLabel("Prompt").fill("A small paper kite over a blue sea");
	await app.getByRole("button", { name: "Generate", exact: true }).click();
	await expect(app.getByRole("option", { name: /Image layer/ })).toBeVisible();
	await app.getByRole("button", { name: "Remove light background" }).click();
	await expect(
		app.getByRole("button", { name: "Remove light background" })
	).toBeEnabled();

	const imageCall = await page.evaluate(() =>
		window.__slidesProof.calls().find((call) => call.method === "media.image")
	);
	expect(imageCall?.args).toMatchObject({
		count: 1,
		prompt: "A small paper kite over a blue sea",
		size: "1280x1080",
	});
	await app.getByRole("button", { name: "Open reader preview →" }).click();
	await expect(
		app.getByRole("heading", { name: "Clear launch story" })
	).toBeVisible();
	await expect(app.getByText("01 / 03")).toBeVisible();
	await app.getByRole("button", { name: "Next frame" }).click();
	await expect(app.getByText("02 / 03")).toBeVisible();
	await app.getByRole("button", { name: "Open frame 3" }).click();
	await expect(app.getByText("03 / 03")).toBeVisible();
	await app.getByRole("button", { name: "Previous frame" }).click();
	await expect(app.getByText("02 / 03")).toBeVisible();
	await saveEvidence(page, "slides-carousel-reader-preview.png");
	await app.getByRole("button", { name: "Close preview" }).click();
	await expect(
		app.getByRole("button", { name: "Open reader preview →" })
	).toBeVisible();

	// SAFETY: This proof mounts the exact Playwright-built native Slides bundle against its private scoped storage Map. App saveState persists model.serializeState projects/trash from the actual normalized Project and Layer constructors; this observer reads those authored bytes through the scoped storage RPC. No foreign storage JSON is validated by this view.

	const state = slidesStateSchema.parse(await persisted(page));
	const edited = state.projects.find(
		(item) => item.seriesTitle === "Clear launch story"
	);
	expect(edited).toMatchObject({
		author: "Product team",
		layout: "closing",
		mark: "Ryu Studio",
		seriesTitle: "Clear launch story",
		showFooter: false,
		showHeader: false,
		theme: "ai-engineer",
	});
	expect(edited?.layers.some((layer) => layer.type === "image")).toBe(true);
	await waitForProjectCount(page, 4);
});

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
