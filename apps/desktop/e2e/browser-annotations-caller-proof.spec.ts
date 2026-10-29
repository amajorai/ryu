import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import type { BrowserAnnotationSpeechRecognition } from "../src/components/panels/BrowserAnnotationSurface.tsx";

interface AnnotationSpeechFixtureState {
	current: BrowserAnnotationSpeechRecognition | null;
	starts: number;
	stops: number;
}

declare global {
	interface Window {
		__annotationSpeech: AnnotationSpeechFixtureState;
	}
}

const proofDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-capture-annotations/annotations"
);
const api = "/api/ext/@ryu/browser/tabs/browser-proof-start";
interface Note {
	comment: string;
	id: string;
	kind: string;
	rect: { x: number; y: number; width: number; height: number };
	style?: Record<string, string>;
}
interface Snapshot {
	annotations: Record<string, Note[]>;
	assistant: { mode: string; pendingPrompt: string | null };
	requests: { method: string; path: string; status: number; body: unknown }[];
	unexpectedRoutes: string[];
}
interface Fixture {
	armNextFailure: (method: string, path: string) => void;
	delayNextContext: () => void;
	snapshot: () => Snapshot;
}
const read = (page: Page) =>
	page.evaluate(() =>
		/* SAFETY: browser-annotations-caller-proof.tsx installs __browserAnnotationsCallerProof before this proof page is evaluated. */ (
			window as Window & { __browserAnnotationsCallerProof: Fixture }
		).__browserAnnotationsCallerProof.snapshot()
	);
const fail = (page: Page, method: string, path: string) =>
	page.evaluate(
		({ method, path }) =>
			/* SAFETY: browser-annotations-caller-proof.tsx installs __browserAnnotationsCallerProof before this proof page is evaluated. */ (
				window as Window & { __browserAnnotationsCallerProof: Fixture }
			).__browserAnnotationsCallerProof.armNextFailure(method, path),
		{ method, path }
	);
async function select(page: Page, area = false, shift = false) {
	await expect(
		page.getByRole("button", { name: "Annotation mode on" })
	).toBeVisible();
	const frame = await page
		.getByTestId("browser-annotation-frame")
		.boundingBox();
	if (!frame) {
		throw new Error("frame absent");
	}
	if (shift) {
		await page.keyboard.down("Shift");
	}
	await page.mouse.move(
		frame.x + frame.width * 0.2,
		frame.y + frame.height * 0.3
	);
	await page.mouse.down();
	if (area) {
		await page.mouse.move(
			frame.x + frame.width * 0.4,
			frame.y + frame.height * 0.5
		);
	}
	await page.mouse.up();
	if (shift) {
		await page.keyboard.up("Shift");
	}
	await expect(
		page.getByRole("textbox", { name: "Annotation comment" })
	).toBeVisible();
}
async function open(page: Page, reset = true) {
	await page.goto(
		`/browser-annotations-caller-proof.html${reset ? "?reset=true" : ""}`,
		{ waitUntil: "domcontentloaded" }
	);
	await page
		.getByTestId("workspace-panel-toggles")
		.getByRole("button")
		.nth(1)
		.click();
	await expect(page.getByTestId("browser-annotation-frame")).toBeVisible();
}
async function screenshot(page: Page, name: string) {
	await page.evaluate(() => window.scrollTo(0, 0));
	await expect
		.poll(() => page.locator("main").evaluate((node) => node.scrollLeft))
		.toBe(0);
	const geometry = await page.locator("main").evaluate((node) => {
		const panel = node.getBoundingClientRect();
		const heading = node.querySelector("h1")?.getBoundingClientRect();
		return {
			left: panel.left,
			right: panel.right,
			headingLeft: heading?.left,
			headingRight: heading?.right,
		};
	});
	expect(geometry.headingLeft).toBeGreaterThanOrEqual(geometry.left);
	expect(geometry.headingRight).toBeLessThanOrEqual(geometry.right);
	await page.screenshot({ path: path.join(proofDir, name) });
}

test("registered Browser caller: scaled element area multiple notes style save retry exact reload cancel and Ask Ryu pending dedup", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await open(page);
	await expect(
		page.getByRole("button", { name: "Ask Ryu to address notes" })
	).toBeDisabled();
	await page.keyboard.press("Control+Shift+D");
	await expect(
		page.getByRole("button", { name: "Annotation mode on" })
	).toHaveAttribute("aria-pressed", "true");
	await select(page);
	await page
		.getByRole("textbox", { name: "Annotation comment" })
		.fill("Clarify the primary action");
	await page
		.getByRole("button", { name: "Adjust styling", exact: true })
		.click();
	const style = {
		font_size: "18px",
		font_weight: "600",
		line_height: "1.4",
		letter_spacing: "0.2px",
		padding: "12px",
		margin: "4px",
		color: "#102030",
		background_color: "#ddeeff",
	};
	for (const [label, value] of [
		["Font size", "18px"],
		["Weight", "600"],
		["Line height", "1.4"],
		["Tracking", "0.2px"],
		["Padding", "12px"],
		["Margin", "4px"],
		["Text color", "#102030"],
		["Fill color", "#ddeeff"],
	]) {
		await page.getByRole("textbox", { name: label, exact: true }).fill(value);
	}
	await fail(page, "POST", `${api}/annotations`);
	await page.getByRole("button", { name: "Add note", exact: true }).click();
	await expect(page.getByText("503", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("textbox", { name: "Annotation comment" })
	).toHaveValue("Clarify the primary action");
	await screenshot(page, "save-failure-draft-retained.png");
	await page.getByRole("button", { name: "Add note", exact: true }).click();
	await expect(page.getByTestId("browser-annotation-marker-1")).toBeVisible();
	const first = (await read(page)).annotations["browser-proof-start"][0];
	expect(first).toMatchObject({
		kind: "element",
		rect: { x: 132, y: 352, width: 176, height: 48 },
		style,
	});
	const posts = (await read(page)).requests.filter(
		(r) => r.method === "POST" && r.path === `${api}/annotations`
	);
	expect(posts.map((r) => r.status)).toEqual([503, 201]);
	expect(posts[0].body).toEqual(posts[1].body);
	const captured = z
		.object({ selections: z.array(z.object({ x: z.number(), y: z.number() })) })
		.parse(posts[1].body);
	expect(captured.selections[0].x).toBeCloseTo(288, 0);
	expect(captured.selections[0].y).toBeCloseTo(270, 0);
	await select(page, true);
	await page
		.getByRole("textbox", { name: "Annotation comment" })
		.fill("Give this region more space");
	await page.getByRole("button", { name: "Add note", exact: true }).click();
	await expect(page.getByTestId("browser-annotation-marker-2")).toBeVisible();
	expect((await read(page)).annotations["browser-proof-start"][1].kind).toBe(
		"area"
	);
	await select(page);
	await select(page, false, true);
	await page
		.getByRole("textbox", { name: "Annotation comment" })
		.fill("Align both targets");
	await page.getByRole("button", { name: "Add note", exact: true }).click();
	await expect(page.getByTestId("browser-annotation-marker-3")).toBeVisible();
	expect((await read(page)).annotations["browser-proof-start"][2].kind).toBe(
		"elements"
	);
	await select(page);
	await page
		.getByRole("textbox", { name: "Annotation comment" })
		.fill("Unsaved draft");
	await page.getByRole("button", { name: "Cancel draft", exact: true }).click();
	await expect(
		page.getByRole("textbox", { name: "Annotation comment" })
	).toHaveCount(0);
	expect((await read(page)).annotations["browser-proof-start"]).toHaveLength(3);
	const saved = (await read(page)).annotations;
	await page.reload({ waitUntil: "domcontentloaded" });
	await page
		.getByTestId("workspace-panel-toggles")
		.getByRole("button")
		.nth(1)
		.click();
	await page.getByRole("button", { name: "Annotate", exact: true }).click();
	await expect(page.getByTestId("browser-annotation-marker-3")).toBeVisible();
	expect((await read(page)).annotations).toEqual(saved);
	await page.keyboard.press("Control+Shift+D");
	await expect(
		page.getByText("Align both targets", { exact: true })
	).toBeVisible();
	await page.evaluate(() =>
		/* SAFETY: browser-annotations-caller-proof.tsx installs __browserAnnotationsCallerProof before this proof page is evaluated. */ (
			window as Window & { __browserAnnotationsCallerProof: Fixture }
		).__browserAnnotationsCallerProof.delayNextContext()
	);
	const before = (await read(page)).requests.filter(
		(r) => r.path === `${api}/context`
	).length;
	await page.getByRole("button", { name: "Ask Ryu to address notes" }).click();
	await expect(
		page.getByRole("button", { name: "Preparing notes…" })
	).toBeDisabled();
	await page
		.getByRole("button", { name: "Preparing notes…" })
		.dispatchEvent("click");
	await expect
		.poll(async () => (await read(page)).assistant.pendingPrompt)
		.toContain("Align both targets");
	const after = await read(page);
	expect(after.assistant.mode).toBe("sidebar");
	expect(
		after.requests.filter((r) => r.path === `${api}/context`)
	).toHaveLength(before + 1);
	expect(after.assistant.pendingPrompt).toContain("Clarify the primary action");
	expect(after.assistant.pendingPrompt).toContain('"font_size":"18px"');
	await screenshot(page, "completed-saved-notes.png");
	expect(errors).toEqual([]);
	expect(after.unexpectedRoutes).toEqual([]);
});
test("registered Browser caller: per-note delete and clear failures preserve notes and retry clears stale errors", async ({
	page,
}) => {
	await open(page);
	await page.getByRole("button", { name: "Annotate", exact: true }).click();
	for (const comment of ["Keep the first note", "Keep the second note"]) {
		await select(page);
		await page
			.getByRole("textbox", { name: "Annotation comment" })
			.fill(comment);
		await page.getByRole("button", { name: "Add note", exact: true }).click();
		await expect(
			page.getByRole("textbox", { name: "Annotation comment" })
		).toHaveCount(0);
	}
	await page.getByRole("button", { name: "Annotation mode on" }).click();
	await fail(page, "DELETE", `${api}/annotations/browser-proof-annotation-1`);
	await page.getByRole("button", { name: "Remove annotation 1" }).click();
	await expect(page.getByText("503", { exact: true })).toBeVisible();
	expect((await read(page)).annotations["browser-proof-start"]).toHaveLength(2);
	await page.getByRole("button", { name: "Remove annotation 1" }).click();
	await expect(
		page.getByText("Keep the first note", { exact: true })
	).toHaveCount(0);
	await expect(page.getByText("503", { exact: true })).toHaveCount(0);
	await fail(page, "DELETE", `${api}/annotations`);
	await page.getByRole("button", { name: "Clear notes" }).click();
	await expect(page.getByText("503", { exact: true })).toBeVisible();
	expect((await read(page)).annotations["browser-proof-start"]).toHaveLength(1);
	await screenshot(page, "clear-error-retains-note.png");
	await page.getByRole("button", { name: "Clear notes" }).click();
	await expect(
		page.getByText("Keep the second note", { exact: true })
	).toHaveCount(0);
	await expect(page.getByText("503", { exact: true })).toHaveCount(0);
	expect((await read(page)).annotations["browser-proof-start"]).toEqual([]);
	await screenshot(page, "completed-cleared-notes.png");
});

test("registered Browser caller: context failure and Ask Ryu failure preserve saved notes and retry", async ({
	page,
}) => {
	await open(page);
	await fail(page, "POST", `${api}/context`);
	await page.getByRole("button", { name: "Annotate", exact: true }).click();
	await expect(page.getByText("503", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Annotate", exact: true })
	).toHaveAttribute("aria-pressed", "false");
	await page.getByRole("button", { name: "Annotate", exact: true }).click();
	await select(page);
	await page
		.getByRole("textbox", { name: "Annotation comment" })
		.fill("Preserve this request");
	await page.getByRole("button", { name: "Add note", exact: true }).click();
	await expect(page.getByTestId("browser-annotation-marker-1")).toBeVisible();
	await fail(page, "POST", `${api}/context`);
	await page.getByRole("button", { name: "Ask Ryu to address notes" }).click();
	await expect(page.getByText("503", { exact: true })).toBeVisible();
	expect((await read(page)).assistant.pendingPrompt).toBeNull();
	expect((await read(page)).annotations["browser-proof-start"]).toHaveLength(1);
	await page.getByRole("button", { name: "Ask Ryu to address notes" }).click();
	await expect
		.poll(async () => (await read(page)).assistant.pendingPrompt)
		.toContain("Preserve this request");
	await expect(page.getByText("503", { exact: true })).toHaveCount(0);
	const contexts = (await read(page)).requests.filter(
		(r) => r.path === `${api}/context`
	);
	expect(contexts.map((r) => r.status)).toEqual([503, 200, 200, 503, 200]);
	expect(contexts.at(-1)?.body).toEqual({
		include_screenshot: false,
		selections: [],
	});
	await page.getByRole("button", { name: "Annotation mode on" }).click();
	await screenshot(page, "completed-context-retry.png");
});

test("registered Browser caller: speech fixture transcript stop error unsupported and cancel", async ({
	page,
}) => {
	await page.addInitScript(() => {
		const speech: AnnotationSpeechFixtureState = {
			current: null,
			starts: 0,
			stops: 0,
		};
		class FixtureSpeechRecognition {
			continuous = false;
			interimResults = false;
			lang = "";
			onresult: BrowserAnnotationSpeechRecognition["onresult"] = null;
			onerror: (() => void) | null = null;
			onend: (() => void) | null = null;
			start() {
				speech.current = this;
				speech.starts += 1;
			}
			stop() {
				speech.stops += 1;
				this.onend?.();
			}
		}
		Object.assign(window, {
			SpeechRecognition: FixtureSpeechRecognition,
			__annotationSpeech: speech,
		});
	});
	await open(page);
	await page.getByRole("button", { name: "Annotate", exact: true }).click();
	await select(page);
	await page
		.getByRole("textbox", { name: "Annotation comment" })
		.fill("Typed feedback");
	await page.getByRole("button", { name: "Dictate annotation" }).click();
	await expect(
		page.getByRole("button", { name: "Stop voice annotation" })
	).toBeVisible();
	await page.evaluate(() => {
		const current = window.__annotationSpeech.current;
		if (!current) {
			throw new Error("Expected active annotation speech fixture");
		}
		const onresult = current.onresult;
		if (!onresult) {
			throw new Error("Expected annotation speech result callback");
		}
		onresult.call(current, {
			results: [
				{ 0: { transcript: "  align the button  " } },
				{ 0: { transcript: "and increase spacing" } },
			],
		});
	});
	await expect(
		page.getByRole("textbox", { name: "Annotation comment" })
	).toHaveValue("Typed feedback align the button and increase spacing");
	await page.getByRole("button", { name: "Stop voice annotation" }).click();
	await expect(
		page.getByRole("button", { name: "Dictate annotation" })
	).toBeVisible();
	await page.getByRole("button", { name: "Dictate annotation" }).click();
	await page.evaluate(() => {
		const current = window.__annotationSpeech.current;
		if (!current) {
			throw new Error("Expected active annotation speech fixture");
		}
		const onerror = current.onerror;
		if (!onerror) {
			throw new Error("Expected annotation speech error callback");
		}
		onerror.call(current);
	});
	await expect(
		page.getByRole("button", { name: "Dictate annotation" })
	).toBeVisible();
	await page.evaluate(() =>
		Object.assign(window, {
			SpeechRecognition: undefined,
			webkitSpeechRecognition: undefined,
		})
	);
	await page.getByRole("button", { name: "Dictate annotation" }).click();
	await expect(
		page.getByRole("button", { name: "Stop voice annotation" })
	).toHaveCount(0);
	await expect(
		page.getByRole("textbox", { name: "Annotation comment" })
	).toHaveValue("Typed feedback align the button and increase spacing");
	await page.getByRole("button", { name: "Add note", exact: true }).click();
	await expect(page.getByTestId("browser-annotation-marker-1")).toBeVisible();
	expect((await read(page)).annotations["browser-proof-start"][0].comment).toBe(
		"Typed feedback align the button and increase spacing"
	);
	await select(page);
	await page
		.getByRole("button", { name: "Adjust styling", exact: true })
		.click();
	await page
		.getByRole("textbox", { name: "Padding", exact: true })
		.fill("24px");
	await page.evaluate(() => {
		const Constructor = class {
			continuous = false;
			interimResults = false;
			lang = "";
			onend: (() => void) | null = null;
			onresult: BrowserAnnotationSpeechRecognition["onresult"] = null;
			start() {}
			stop() {
				window.__annotationSpeech.stops += 1;
				this.onend?.();
			}
		};
		Object.assign(window, { SpeechRecognition: Constructor });
	});
	await page.getByRole("button", { name: "Dictate annotation" }).click();
	await expect(
		page.getByRole("button", { name: "Stop voice annotation" })
	).toBeVisible();
	const stops = await page.evaluate(() => window.__annotationSpeech.stops);
	await page.getByRole("button", { name: "Cancel draft", exact: true }).click();
	expect(await page.evaluate(() => window.__annotationSpeech.stops)).toBe(
		stops + 1
	);
	await select(page);
	await page
		.getByRole("button", { name: "Adjust styling", exact: true })
		.click();
	await expect(
		page.getByRole("textbox", { name: "Padding", exact: true })
	).toHaveValue("");
	await page.getByRole("button", { name: "Cancel draft", exact: true }).click();
	await page.getByRole("button", { name: "Annotation mode on" }).click();
	await screenshot(page, "completed-speech-fixture-note.png");
});
