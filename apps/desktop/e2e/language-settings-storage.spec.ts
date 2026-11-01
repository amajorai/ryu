import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
	type LanguagePack,
	languagePackArchive,
	parseLanguagePackArchive,
} from "@ryu/i18n";
import {
	choose,
	errors,
	ready,
	refuseLanguageWrites,
	registerLanguageFixtureHooks,
} from "./language-settings-proof-helpers.ts";

registerLanguageFixtureHooks();

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
