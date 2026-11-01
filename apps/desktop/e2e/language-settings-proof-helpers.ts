// Shared fixture helpers for the language-settings storage and keyboard specs.
import { expect, type Page, test } from "@playwright/test";

export const errors = new WeakMap<Page, string[]>();
function audit(page: Page) {
	const messages: string[] = [];
	errors.set(page, messages);
	page.on("pageerror", (error) => messages.push(error.message));
}
export async function ready(page: Page) {
	audit(page);
	await page.goto("/language-settings-proof.html");
	await expect(
		page.getByRole("button", {
			name: "Export Window proof Spanish",
			exact: true,
		})
	).toBeVisible();
}
export async function choose(page: Page, name: string, keyboard = false) {
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
/** Resets the fixture before each test and asserts it saw no undeclared calls. */
export function registerLanguageFixtureHooks() {
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
}
/**
 * Fault injection at the browser Storage method boundary: this page's language
 * writes to localStorage throw the quota error until its session flag turns it
 * off. Every storage event the page receives is recorded by key.
 */
export async function refuseLanguageWrites(page: Page) {
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
