import { createHash } from "node:crypto";
import { expect, type FileChooser, type Page, test } from "@playwright/test";
import {
	type LanguagePack,
	languagePackArchive,
	parseLanguagePackArchive,
} from "@ryu/i18n";

const errors = new WeakMap<Page, string[]>();
function audit(page: Page) {
	const messages: string[] = [];
	errors.set(page, messages);
	page.on("pageerror", (error) => messages.push(error.message));
}
async function ready(page: Page) {
	audit(page);
	await page.goto("/language-settings-proof.html");
	await expect(
		page.getByRole("button", {
			name: "Export Window proof Spanish",
			exact: true,
		})
	).toBeVisible();
}
async function choose(page: Page, name: string, keyboard = false) {
	const trigger = page.getByRole("combobox");
	if (keyboard) {
		await trigger.focus();
		await trigger.press("ArrowDown");
		await page.getByRole("option", { name, exact: true }).press("Enter");
	} else {
		await trigger.click();
		await page.getByRole("option", { name, exact: true }).click();
	}
}
test.beforeEach(async ({ request }) => {
	const response = await request.post("/__language-proof/control", {
		data: { reset: true },
	});
	expect(response.ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
	const response = await request.get("/__language-proof/receipts");
	expect(response.ok()).toBe(true);
	expect((await response.json()).unexpected).toEqual([]);
});
/**
 * Fault injection at the browser Storage method boundary: this page's language
 * writes to localStorage throw the quota error until its session flag turns it
 * off. Every storage event the page receives is recorded by key.
 */
async function refuseLanguageWrites(page: Page) {
	await page.addInitScript(() => {
		const nativeSetItem = Storage.prototype.setItem;
		const refused: string[] = [];
		const received: (string | null)[] = [];
		Reflect.set(window, "__languageProofRefusedWrites", refused);
		Reflect.set(window, "__languageProofStorageEvents", received);
		window.addEventListener("storage", (event) => received.push(event.key));
		Storage.prototype.setItem = function (key: string, value: string) {
			if (
				this === window.localStorage &&
				(key === "ryu:language-mode" || key === "ryu:language-pack") &&
				window.sessionStorage.getItem("language-proof-refusal") !== "off"
			) {
				refused.push(key);
				throw new DOMException("denied", "QuotaExceededError");
			}
			return nativeSetItem.call(this, key, value);
		};
	});
}

test("real shared-origin windows acknowledge selection, conserve a draft, and independently reload persisted locale", async ({
	page,
	context,
}) => {
	await ready(page);
	const other = await context.newPage();
	await ready(other);
	await page.evaluate(() => {
		localStorage.setItem("language-proof-unrelated", "preserved");
		localStorage.setItem("ryu:timezone", "Asia/Tokyo");
	});
	const draft = page.getByRole("textbox", {
		name: "Unsent language proof draft",
		exact: true,
	});
	await draft.fill("unsent words");
	await draft.focus();
	const originalInput = await draft.elementHandle();
	await choose(other, "Window proof Spanish", true);
	await expect(other.getByTestId("language-consumer")).toHaveText(
		"es:Instalar entre ventanas"
	);
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"es:Instalar entre ventanas"
	);
	expect(
		await originalInput!.evaluate(
			(input) =>
				input.isConnected &&
				input ===
					document.querySelector(
						'input[aria-label="Unsent language proof draft"]'
					)
		)
	).toBe(true);
	await expect(draft).toHaveValue("unsent words");
	expect(
		await draft.evaluate((input) => input === document.activeElement)
	).toBe(true);
	expect(
		await page.evaluate(() => ({
			mode: localStorage.getItem("ryu:language-mode"),
			pack: localStorage.getItem("ryu:language-pack"),
			retained: localStorage.getItem("language-proof-unrelated"),
			timezone: localStorage.getItem("ryu:timezone"),
		}))
	).toEqual({
		mode: "fixed",
		pack: "coverage/window",
		retained: "preserved",
		timezone: "Asia/Tokyo",
	});
	await page.reload();
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"es:Instalar entre ventanas"
	);
	// Exercise the genuine shared provider and Base UI portal in RTL, while
	// the other window owns a fresh draft and keyboard focus.
	await draft.fill("unsent words after reload");
	await draft.focus();
	const reloadedInput = await draft.elementHandle();
	await choose(other, "العربية", true);
	for (const window of [page, other]) {
		await expect(window.getByTestId("language-consumer")).toHaveText(
			"ar:تثبيت"
		);
		await expect(window.locator("html")).toHaveAttribute("lang", "ar");
		await expect(window.locator("html")).toHaveAttribute("dir", "rtl");
	}
	expect(
		await reloadedInput!.evaluate(
			(input) =>
				input.isConnected &&
				input ===
					document.querySelector(
						'input[aria-label="Unsent language proof draft"]'
					)
		)
	).toBe(true);
	await expect(draft).toHaveValue("unsent words after reload");
	await expect(draft).toBeFocused();
	const rtlTrigger = other.getByRole("combobox");
	await rtlTrigger.focus();
	await other.keyboard.press("ArrowDown");
	const rtlPopup = other.locator('[data-slot="select-content"]');
	await expect(rtlPopup).toBeVisible();
	await expect(rtlPopup).toHaveAttribute("dir", "rtl");
	expect(
		await rtlPopup.evaluate((popup) => getComputedStyle(popup).direction)
	).toBe("rtl");
	await other.keyboard.press("Escape");
	await expect(rtlPopup).toBeHidden();
	await expect(rtlTrigger).toBeFocused();
	expect(
		await other.evaluate(() => ({
			mode: localStorage.getItem("ryu:language-mode"),
			pack: localStorage.getItem("ryu:language-pack"),
			timezone: localStorage.getItem("ryu:timezone"),
			retained: localStorage.getItem("language-proof-unrelated"),
		}))
	).toEqual({
		mode: "fixed",
		pack: "official/ar",
		timezone: "Asia/Tokyo",
		retained: "preserved",
	});
	await page.reload();
	await expect(page.getByTestId("language-consumer")).toHaveText("ar:تثبيت");
	await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
	await choose(other, "اكتشاف تلقائي", true);
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"en-US:Install"
	);
	await expect(other.getByTestId("language-consumer")).toHaveText(
		"en-US:Install"
	);
	await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
	await expect(other.locator("html")).toHaveAttribute("dir", "ltr");
	expect(
		await page.evaluate(() => localStorage.getItem("language-proof-unrelated"))
	).toBe("preserved");
	expect(errors.get(page)).toEqual([]);
	expect(errors.get(other)).toEqual([]);
	await other.close();
});

test("native browser storage clear reaches the other window and independent writer reload reads automatic mode", async ({
	page,
	context,
}) => {
	await ready(page);
	const other = await context.newPage();
	await ready(other);
	await choose(page, "Window proof Spanish");
	await expect(other.getByTestId("language-consumer")).toHaveText(
		"es:Instalar entre ventanas"
	);
	// The producer here is actual localStorage.clear, not the product reset UI.
	await page.evaluate(() => localStorage.clear());
	await expect(other.getByTestId("language-consumer")).toHaveText(
		"en-US:Install"
	);
	await page.reload();
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"en-US:Install"
	);
	expect(
		await page.evaluate(() => localStorage.getItem("ryu:language-pack"))
	).toBeNull();
	expect(errors.get(page)).toEqual([]);
	expect(errors.get(other)).toEqual([]);
	await other.close();
});

test("real disabled-pack selection reports failed writes and retries only acknowledged enable", async ({
	page,
	request,
}) => {
	await ready(page);
	await page.evaluate(() =>
		localStorage.setItem("language-proof-unrelated", "preserved")
	);
	expect(
		(
			await request.post("/__language-proof/control", {
				data: { enabledRefused: true },
			})
		).ok()
	).toBe(true);
	await choose(page, "Disabled French");
	await expect(page.getByRole("alert")).toHaveText(
		"/api/marketplace/packages/language_pack/coverage%2Fdisabled/enable failed: 503"
	);
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"en-US:Install"
	);
	expect(
		await page.evaluate(() => localStorage.getItem("ryu:language-pack"))
	).toBeNull();
	const failed = await (await request.get("/__language-proof/receipts")).json();
	expect(failed.enableWrites).toBe(1);
	expect(failed.packs[1].enabled).toBe(false);
	expect(
		(
			await request.post("/__language-proof/control", {
				data: { enabledRefused: false },
			})
		).ok()
	).toBe(true);
	await choose(page, "Disabled French");
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"fr:Installer après confirmation"
	);
	await expect(page.getByRole("alert")).toHaveCount(0);
	const recovered = await (
		await request.get("/__language-proof/receipts")
	).json();
	expect(recovered.enableWrites).toBe(2);
	expect(recovered.packs[1].enabled).toBe(true);
	expect(recovered.packs[0]).toEqual(failed.packs[0]);
	expect(
		await page.evaluate(() => localStorage.getItem("language-proof-unrelated"))
	).toBe("preserved");
	await page.reload();
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"fr:Installer après confirmation"
	);
	expect(errors.get(page)).toEqual([]);
});

test("browser file chooser rejects malformed and refused imports then conserves exact bytes through retry and reload", async ({
	page,
	request,
}) => {
	await ready(page);
	const original = await (
		await request.get("/__language-proof/receipts")
	).json();
	await page.evaluate(() => {
		localStorage.setItem("language-proof-unrelated", "preserved");
		localStorage.setItem("ryu:timezone", "Asia/Tokyo");
	});
	const imported: LanguagePack = {
		schemaVersion: 1,
		id: "coverage/browser-import",
		name: "Browser imported French",
		version: "2.0.0",
		locale: "fr",
		baseLocale: "en",
		direction: "ltr",
		messages: { "common.install": "Installer depuis le fichier" },
	};
	const archive = languagePackArchive(imported);
	const chooseArchive = async (buffer: Uint8Array) => {
		const chooser = page.waitForEvent("filechooser");
		await page.getByRole("button", { name: "Import", exact: true }).click();
		await (await chooser).setFiles({
			name: "browser-proof.ryupack",
			mimeType: "application/zip",
			buffer: Buffer.from(buffer),
		});
	};
	await chooseArchive(new Uint8Array([1, 2, 3, 4]));
	await expect(page.getByRole("alert")).toHaveText(
		"/api/language-packs/import failed: 400"
	);
	const rejected = await (
		await request.get("/__language-proof/receipts")
	).json();
	expect(rejected.importWrites).toBe(1);
	expect(rejected.packs).toEqual(original.packs);
	expect(rejected.importedArchiveSha256).toBeNull();
	expect(
		(
			await request.post("/__language-proof/control", {
				data: { importRefused: true },
			})
		).ok()
	).toBe(true);
	await chooseArchive(archive);
	await expect(page.getByRole("alert")).toHaveText(
		"/api/language-packs/import failed: 503"
	);
	const refused = await (
		await request.get("/__language-proof/receipts")
	).json();
	expect(refused.importWrites).toBe(2);
	expect(refused.packs).toEqual(original.packs);
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"en-US:Install"
	);
	expect(
		await page.evaluate(() => localStorage.getItem("ryu:language-pack"))
	).toBeNull();
	expect(
		(
			await request.post("/__language-proof/control", {
				data: { importRefused: false },
			})
		).ok()
	).toBe(true);
	await chooseArchive(archive);
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"fr:Installer depuis le fichier"
	);
	const acknowledged = await (
		await request.get("/__language-proof/receipts")
	).json();
	expect(acknowledged.importWrites).toBe(3);
	expect(acknowledged.importedArchiveSha256).toBe(
		createHash("sha256").update(archive).digest("hex")
	);
	expect(acknowledged.packs.slice(0, 2)).toEqual(original.packs);
	expect(acknowledged.packs[2]).toEqual({ ...imported, enabled: true });
	expect(
		await page.evaluate(() => ({
			mode: localStorage.getItem("ryu:language-mode"),
			pack: localStorage.getItem("ryu:language-pack"),
			unrelated: localStorage.getItem("language-proof-unrelated"),
			timezone: localStorage.getItem("ryu:timezone"),
		}))
	).toEqual({
		mode: "fixed",
		pack: imported.id,
		unrelated: "preserved",
		timezone: "Asia/Tokyo",
	});
	await page.reload();
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"fr:Installer depuis le fichier"
	);
	expect(errors.get(page)).toEqual([]);
});

test("browser export delivers the deterministic portable archive and retires its Blob URL without catalog writes", async ({
	page,
	request,
}) => {
	await page.addInitScript(() => {
		const receipts = { created: [] as string[], revoked: [] as string[] };
		Object.defineProperty(window, "__languageBlobReceipts", {
			value: receipts,
		});
		const create = URL.createObjectURL.bind(URL);
		const revoke = URL.revokeObjectURL.bind(URL);
		URL.createObjectURL = (blob) => {
			const url = create(blob);
			receipts.created.push(url);
			return url;
		};
		URL.revokeObjectURL = (url) => {
			receipts.revoked.push(url);
			revoke(url);
		};
	});
	await ready(page);
	const before = await (await request.get("/__language-proof/receipts")).json();
	const downloaded = page.waitForEvent("download");
	await page
		.getByRole("button", {
			name: "Export Window proof Spanish",
			exact: true,
		})
		.click();
	const download = await downloaded;
	expect(download.suggestedFilename()).toBe(
		"window-proof-spanish-1.0.0.ryupack"
	);
	expect(await download.failure()).toBeNull();
	const stream = await download.createReadStream();
	if (!stream) {
		throw new Error("Browser download has no readable archive");
	}
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(Buffer.from(chunk));
	}
	const archive = Buffer.concat(chunks);
	expect(archive).toEqual(Buffer.from(languagePackArchive(before.packs[0])));
	expect(parseLanguagePackArchive(archive)).toEqual(
		parseLanguagePackArchive(languagePackArchive(before.packs[0]))
	);
	await expect
		.poll(() =>
			page.evaluate(() => {
				const receipts = (
					window as Window & {
						__languageBlobReceipts?: { created: string[]; revoked: string[] };
					}
				).__languageBlobReceipts;
				if (!receipts) {
					throw new Error("Browser Blob URL receipts are unavailable");
				}
				const { created, revoked } = receipts;
				return {
					created: created.length,
					same: JSON.stringify(created) === JSON.stringify(revoked),
				};
			})
		)
		.toEqual({ created: 1, same: true });
	const after = await (await request.get("/__language-proof/receipts")).json();
	expect(after.packs).toEqual(before.packs);
	expect(after.importWrites).toBe(0);
	expect(after.enableWrites).toBe(0);
	expect(errors.get(page)).toEqual([]);
});

test("refused browser storage keeps an automatic-to-pack choice for the session, a real reload reads durable automatic mode, and the same choice saves after recovery", async ({
	page,
	context,
}) => {
	await refuseLanguageWrites(page);
	await ready(page);
	const other = await context.newPage();
	await ready(other);
	await page.evaluate(() =>
		localStorage.setItem("language-proof-unrelated", "preserved")
	);
	const readState = (window: Page) =>
		window.evaluate(() => ({
			mode: localStorage.getItem("ryu:language-mode"),
			pack: localStorage.getItem("ryu:language-pack"),
			retained: localStorage.getItem("language-proof-unrelated"),
		}));
	await choose(page, "Window proof Spanish");
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"es:Instalar entre ventanas"
	);
	await expect(page.locator("html")).toHaveAttribute("lang", "es");
	await expect(page.getByRole("combobox")).toContainText(
		"Window proof Spanish"
	);
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__languageProofRefusedWrites")
		)
	).toEqual(["ryu:language-mode", "ryu:language-pack"]);
	expect(await readState(page)).toEqual({
		mode: null,
		pack: null,
		retained: "preserved",
	});
	// Nothing was saved, so the other window keeps automatic English.
	await expect(other.getByTestId("language-consumer")).toHaveText(
		"en-US:Install"
	);
	// A real reload starts a new document from durable storage.
	await page.reload();
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"en-US:Install"
	);
	await expect(page.getByRole("combobox")).toContainText("Auto detect");
	// Storage recovers: choosing the same pack again saves it for both windows.
	await page.evaluate(() =>
		sessionStorage.setItem("language-proof-refusal", "off")
	);
	await choose(page, "Window proof Spanish");
	for (const window of [page, other]) {
		await expect(window.getByTestId("language-consumer")).toHaveText(
			"es:Instalar entre ventanas"
		);
	}
	expect(await readState(other)).toEqual({
		mode: "fixed",
		pack: "coverage/window",
		retained: "preserved",
	});
	await page.reload();
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"es:Instalar entre ventanas"
	);
	expect(errors.get(page)).toEqual([]);
	expect(errors.get(other)).toEqual([]);
	await other.close();
});

test("a real English save in another window replaces an unsaved pack even when it only changes the saved mode to this window's session mode", async ({
	page,
	context,
}) => {
	await refuseLanguageWrites(page);
	await ready(page);
	const other = await context.newPage();
	await ready(other);
	await page.evaluate(() =>
		localStorage.setItem("language-proof-unrelated", "preserved")
	);
	await choose(page, "Window proof Spanish");
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"es:Instalar entre ventanas"
	);
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__languageProofRefusedWrites")
		)
	).toEqual(["ryu:language-mode", "ryu:language-pack"]);
	// The other window saves English through the real control: mode becomes the
	// fixed value this page already uses, and removing the absent pack is silent.
	await choose(other, "English");
	await expect(other.getByTestId("language-consumer")).toHaveText("en:Install");
	await expect(page.getByTestId("language-consumer")).toHaveText("en:Install");
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
	await expect(page.getByRole("combobox")).toContainText("English");
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__languageProofStorageEvents")
		)
	).toEqual(["ryu:language-mode"]);
	// The page projected the saved choice without writing; durable state is the
	// other window's English save, with the unrelated record conserved.
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__languageProofRefusedWrites")
		)
	).toEqual(["ryu:language-mode", "ryu:language-pack"]);
	expect(
		await page.evaluate(() => ({
			mode: localStorage.getItem("ryu:language-mode"),
			pack: localStorage.getItem("ryu:language-pack"),
			retained: localStorage.getItem("language-proof-unrelated"),
		}))
	).toEqual({ mode: "fixed", pack: null, retained: "preserved" });
	await page.reload();
	await expect(page.getByTestId("language-consumer")).toHaveText("en:Install");
	await expect(page.getByRole("combobox")).toContainText("English");
	expect(errors.get(page)).toEqual([]);
	expect(errors.get(other)).toEqual([]);
	await other.close();
});

test("every Settings control is reached in order from the keyboard and operates without a pointer", async ({
	page,
	request,
}) => {
	// Chooser interception is enabled asynchronously when a listener is added,
	// so it is registered before any key press rather than raced against one.
	const choosers: FileChooser[] = [];
	page.on("filechooser", (chooser) => choosers.push(chooser));
	await ready(page);
	const before = await (await request.get("/__language-proof/receipts")).json();
	const focused = () =>
		page.evaluate(() => {
			const active = document.activeElement;
			if (!(active instanceof HTMLElement) || active === document.body) {
				return null;
			}
			const kind = active.getAttribute("role") ?? active.tagName.toLowerCase();
			// A combobox is named by its shown value, not its decorative chevron.
			const name =
				active.getAttribute("aria-label") ??
				active.querySelector('[data-slot="select-value"]')?.textContent ??
				active.textContent?.trim() ??
				"";
			return `${kind}:${name}`;
		});
	// Walk the page from its start with Tab only.
	await page.evaluate(() => {
		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}
	});
	const exports = [
		...(await page.evaluate(() =>
			Array.from(
				document.querySelectorAll<HTMLButtonElement>(
					'button[aria-label^="Export "]'
				),
				(button) => `button:${button.getAttribute("aria-label")}`
			)
		)),
	];
	expect(exports).toContain("button:Export Window proof Spanish");
	expect(exports).toContain("button:Export Disabled French");
	const expected = [
		"button:Import",
		"combobox:Auto detect",
		...exports,
		"button:Marketplace",
		"input:Unsent language proof draft",
	];
	const visited: (string | null)[] = [];
	for (const _ of expected) {
		await page.keyboard.press("Tab");
		visited.push(await focused());
	}
	expect(visited).toEqual(expected);

	// The language picker is operated with keys alone: Tab reaches it, an arrow
	// key opens it on the saved choice, the arrows move the highlight, and Enter
	// saves and projects the highlighted language.
	const saved = () =>
		page.evaluate(() => ({
			mode: localStorage.getItem("ryu:language-mode"),
			pack: localStorage.getItem("ryu:language-pack"),
		}));
	expect(await saved()).toEqual({ mode: null, pack: null });
	// Shift+Tab walks back from the draft to Import through the same stops, and
	// Tab then reaches the picker.
	const backward: (string | null)[] = [];
	for (const _ of expected.slice(0, -1)) {
		await page.keyboard.press("Shift+Tab");
		backward.push(await focused());
	}
	expect(backward).toEqual(expected.slice(0, -1).reverse());
	await page.keyboard.press("Tab");
	const picker = page.getByRole("combobox");
	await expect(picker).toBeFocused();
	const listbox = page.getByRole("listbox");
	const highlighted = listbox.locator('[role="option"][data-highlighted]');
	await page.keyboard.press("ArrowDown");
	await expect(listbox).toBeVisible();
	const options = (await listbox.getByRole("option").allTextContents()).map(
		(option) => option.trim()
	);
	expect(options.slice(0, 2)).toEqual(["Auto detect", "English"]);
	const spanish = options.indexOf("Window proof Spanish");
	expect(spanish).toBeGreaterThan(1);
	await expect(highlighted).toHaveText("Auto detect");
	for (const option of options.slice(1, spanish + 1)) {
		await page.keyboard.press("ArrowDown");
		await expect(highlighted).toHaveText(option);
	}
	// Nothing is saved or projected while the highlight only moves.
	expect(await saved()).toEqual({ mode: null, pack: null });
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"en-US:Install"
	);
	await page.keyboard.press("Enter");
	await expect(listbox).toBeHidden();
	await expect(picker).toBeFocused();
	await expect(picker).toContainText("Window proof Spanish");
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"es:Instalar entre ventanas"
	);
	await expect(page.locator("html")).toHaveAttribute("lang", "es");
	expect(await saved()).toEqual({ mode: "fixed", pack: "coverage/window" });
	// ArrowUp opens it on the saved pack; the arrows walk back to Auto detect.
	await page.keyboard.press("ArrowUp");
	await expect(listbox).toBeVisible();
	await expect(highlighted).toHaveText("Window proof Spanish");
	for (const option of options.slice(0, spanish).reverse()) {
		await page.keyboard.press("ArrowUp");
		await expect(highlighted).toHaveText(option);
	}
	await page.keyboard.press("Enter");
	await expect(listbox).toBeHidden();
	await expect(picker).toBeFocused();
	await expect(picker).toContainText("Auto detect");
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"en-US:Install"
	);
	await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
	expect(await saved()).toEqual({ mode: "auto", pack: null });

	// Enter on Import opens the archive chooser for exactly one portable archive.
	await page.getByRole("button", { name: "Import", exact: true }).focus();
	await page.keyboard.press("Enter");
	await expect.poll(() => choosers.length).toBe(1);
	expect(choosers[0]!.isMultiple()).toBe(false);
	expect(await choosers[0]!.element().getAttribute("accept")).toBe(
		".ryupack,application/zip"
	);
	// Space on an Export button downloads that pack's archive.
	await page
		.getByRole("button", { name: "Export Window proof Spanish", exact: true })
		.focus();
	const download = page.waitForEvent("download");
	await page.keyboard.press("Space");
	expect((await download).suggestedFilename()).toBe(
		"window-proof-spanish-1.0.0.ryupack"
	);
	// Enter on Marketplace opens the Marketplace route in the same window.
	await page.getByRole("button", { name: "Marketplace", exact: true }).focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("language-location")).toHaveText(
		"/marketplace"
	);
	const after = await (await request.get("/__language-proof/receipts")).json();
	expect(after.packs).toEqual(before.packs);
	expect(after.importWrites).toBe(0);
	expect(after.enableWrites).toBe(0);
	expect(errors.get(page)).toEqual([]);
});

test("content-identical catalog refreshes leave <html> and style untouched in a real browser, while a real choice still updates them", async ({
	page,
	request,
}) => {
	await ready(page);
	await page.evaluate(() => {
		const records: string[] = [];
		Reflect.set(window, "__languageRootMutations", records);
		new MutationObserver((list) => {
			for (const record of list) {
				records.push(record.attributeName ?? "");
			}
		}).observe(document.documentElement, {
			attributeFilter: ["dir", "lang", "style"],
			attributes: true,
		});
	});
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Performance.enable");
	const styleRecalcs = async () => {
		const { metrics } = await cdp.send("Performance.getMetrics");
		return metrics.find((metric) => metric.name === "RecalcStyleCount")?.value;
	};
	// Two frames plus a timer turn: every effect, rescan and style pass of the
	// last committed refresh has run.
	const quiet = () =>
		page.evaluate(
			() =>
				new Promise((resolve) =>
					requestAnimationFrame(() =>
						requestAnimationFrame(() => setTimeout(resolve, 100))
					)
				)
		);
	await quiet();
	const readsBefore = (
		await (await request.get("/__language-proof/receipts")).json()
	).catalogReads;
	const recalcsBefore = await styleRecalcs();
	for (let refresh = 0; refresh < 3; refresh += 1) {
		const read = page.waitForResponse((response) =>
			response.url().endsWith("/api/language-packs/installed")
		);
		await page.evaluate(() =>
			window.dispatchEvent(new Event("ryu:language-packs-changed"))
		);
		await (await read).finished();
		await quiet();
	}
	const recalcsAfter = await styleRecalcs();
	const receipts = await (
		await request.get("/__language-proof/receipts")
	).json();
	expect(receipts.catalogReads).toBe(readsBefore + 3);
	expect(
		await page.evaluate(() => Reflect.get(window, "__languageRootMutations"))
	).toEqual([]);
	expect(recalcsAfter).toBe(recalcsBefore);
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"en-US:Install"
	);
	// The same observers see a real choice: one publication rewrites <html>.
	await choose(page, "Window proof Spanish");
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"es:Instalar entre ventanas"
	);
	await expect(page.locator("html")).toHaveAttribute("lang", "es");
	expect(
		await page.evaluate(() => Reflect.get(window, "__languageRootMutations"))
	).toContain("lang");
	expect(await styleRecalcs()).toBeGreaterThan(recalcsAfter!);
	expect(errors.get(page)).toEqual([]);
});
