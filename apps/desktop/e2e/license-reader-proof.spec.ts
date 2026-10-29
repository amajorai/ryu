import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type Request, test } from "@playwright/test";

const STORY_URL = "/index.html";
function shippingLicenseReceipt() {
	const text = readFileSync(
		new URL("../src/lib/desktop-licenses.generated.txt", import.meta.url),
		"utf8"
	);
	return {
		length: text.length,
		digest: createHash("sha256").update(text).digest("hex"),
	};
}

async function expectShippingLicenseText(
	dialog: import("@playwright/test").Locator
) {
	const notices = dialog.locator("pre");
	await expect(notices).toContainText(
		"THE FOLLOWING SETS FORTH ATTRIBUTION NOTICES"
	);
	const actual = await notices.textContent();
	if (actual === null) {
		throw new Error("Missing rendered license notices");
	}
	const expected = shippingLicenseReceipt();
	expect(actual.length).toBe(expected.length);
	expect(createHash("sha256").update(actual).digest("hex")).toBe(
		expected.digest
	);
}

test("open source licenses load the shipping legal artifact on demand and restore keyboard focus on dismissal", async ({
	page,
}) => {
	const noticeRequests: string[] = [];
	page.on("request", (request) => {
		if (
			request.resourceType() === "fetch" &&
			request.url().includes("desktop-licenses.generated")
		) {
			noticeRequests.push(request.url());
		}
	});
	await page.goto(STORY_URL);
	const view = page.getByRole("button", { name: "View open source licenses" });
	await expect(view).toBeVisible();
	expect(noticeRequests).toEqual([]);
	await view.focus();
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("dialog", { name: "Open source licenses" });
	await expect(dialog).toBeVisible();
	await expectShippingLicenseText(dialog);
	expect(noticeRequests).toHaveLength(1);
	expect(
		await dialog.evaluate((element) => element.contains(document.activeElement))
	).toBe(true);
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	await expect(view).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(dialog).toBeVisible();
	await expectShippingLicenseText(dialog);
	expect(noticeRequests).toHaveLength(1);
});

test("failed delivery of the real license chunk surfaces an error and explicit retry recovers the complete notices", async ({
	page,
}) => {
	let attempts = 0;
	await page.route("**/desktop-licenses.generated*.txt*", async (route) => {
		if (route.request().resourceType() !== "fetch") {
			await route.continue();
			return;
		}
		attempts += 1;
		if (attempts === 1) {
			await route.abort("failed");
		} else {
			await route.continue();
		}
	});
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "View open source licenses" }).click();
	const dialog = page.getByRole("dialog", { name: "Open source licenses" });
	await expect(
		dialog.getByText("The license notices could not be loaded.")
	).toBeVisible();
	expect(attempts).toBe(1);
	await expect(dialog.locator("pre")).toHaveCount(0);
	await dialog.getByRole("button", { name: "Try again" }).click();
	await expectShippingLicenseText(dialog);
	expect(attempts).toBe(2);
	await expect(
		dialog.getByText("The license notices could not be loaded.")
	).toHaveCount(0);
});

test("unmounting the license reader cancels an outstanding asset delivery", async ({
	page,
}) => {
	let release: (() => void) | undefined;
	let finished: Promise<void> | undefined;
	let started = false;
	let heldRequest: Request | undefined;
	let unmounted = false;
	let navigations = 0;
	let aborted = false;
	page.on("requestfailed", (request) => {
		if (request === heldRequest && unmounted) {
			aborted = request.failure()?.errorText.includes("ERR_ABORTED") ?? false;
		}
	});
	await page.route("**/desktop-licenses.generated*.txt*", async (route) => {
		if (route.request().resourceType() !== "fetch") {
			await route.continue();
			return;
		}
		if (heldRequest) {
			throw new Error("Unexpected second held license delivery");
		}
		heldRequest = route.request();
		started = true;
		finished = (async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			// The canceled request is already retired by Chromium; only an actual
			// native abort permits this fixture cleanup path.
			if (route.request().failure()?.errorText.includes("ERR_ABORTED")) {
				return;
			}
			await route.continue();
		})();
		await finished;
	});
	try {
		await page.goto(STORY_URL);
		await page
			.getByRole("button", { name: "View open source licenses" })
			.click();
		await expect.poll(() => started).toBe(true);
		await expect(
			page.getByRole("dialog", { name: "Open source licenses" })
		).toBeVisible();
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) {
				navigations += 1;
			}
		});
		unmounted = true;
		await page.evaluate(() => window.__licenseReaderUnmount());
		await expect(
			page.getByRole("dialog", { name: "Open source licenses" })
		).toHaveCount(0);
		await expect.poll(() => aborted).toBe(true);
		expect(navigations).toBe(0);
	} finally {
		release?.();
		await finished;
	}
});

declare global {
	interface Window {
		__licenseReaderUnmount: () => void;
	}
}
