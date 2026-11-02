import { expect, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

const code = {
	device_code: "fixture-device",
	user_code: "TEST-CODE",
	interval: 5,
	expires_in: 900,
	verification_uri_complete: "http://127.0.0.1:5222/verify",
};
test("canceling a pending device-code request opens no verification tab", async ({
	page,
}) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	let cancelled = 0;
	let tokens = 0;
	page.on("requestfailed", (request) => {
		if (request.url().endsWith("/device/code")) {
			cancelled++;
		}
	});
	await page.route("**/api/auth/device/code", async (route) => {
		await pending;
		await route.fulfill({ json: code });
	});
	await page.route("**/api/auth/device/token", async (route) => {
		tokens++;
		await route.fulfill({ json: { error: "authorization_pending" } });
	});
	await page.clock.install();
	try {
		await page.goto("/device-cancel-proof.html");
		await page
			.getByRole("button", {
				name: "Use an approval code instead",
				exact: true,
			})
			.click();
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect.poll(() => cancelled).toBe(1);
		release();
		await page.clock.fastForward(20_000);
		expect(tokens).toBe(0);
		expect(await page.locator("html").getAttribute("data-opened")).toBeNull();
	} finally {
		release();
		await page.unrouteAll({ behavior: "wait" });
	}
});
test("closing device sign-in cancels its delay and held token request", async ({
	page,
}) => {
	let tokens = 0;
	let cancelled = 0;
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/auth/device/code", (route) =>
		route.fulfill({ json: code })
	);
	await page.route("**/api/auth/device/token", async (route) => {
		tokens++;
		await pending;
		await route.fulfill({ json: { access_token: "fixture-only" } });
	});
	page.on("requestfailed", (request) => {
		if (request.url().endsWith("/device/token")) {
			cancelled++;
		}
	});
	await page.clock.install();
	try {
		await page.goto("/device-cancel-proof.html");
		await page
			.getByRole("button", {
				name: "Use an approval code instead",
				exact: true,
			})
			.click();
		await expect(page.locator("html")).toHaveAttribute("data-opened", "1");
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await page.clock.fastForward(20_000);
		expect(tokens).toBe(0);
		await page
			.getByRole("button", {
				name: "Use an approval code instead",
				exact: true,
			})
			.click();
		await expect(page.locator("html")).toHaveAttribute("data-opened", "2");
		await page.clock.fastForward(5100);
		await expect.poll(() => tokens).toBe(1);
		await page
			.getByRole("button", { name: "Close popup", exact: true })
			.click();
		await expect.poll(() => cancelled).toBe(1);
		release();
		await page.clock.fastForward(20_000);
		expect(tokens).toBe(1);
		expect(
			await page.evaluate(() => localStorage.getItem("fixture-account-writes"))
		).toBeNull();
		await page.getByRole("button", { name: "Open popup", exact: true }).click();
		await expect(
			page.getByRole("button", {
				name: "Use an approval code instead",
				exact: true,
			})
		).toBeVisible();
		await page.clock.runFor(1000);
		await page.screenshot({
			path: proofEvidencePath("performance-sweep/device-cancel-completed.png"),
			fullPage: true,
			animations: "disabled",
		});
	} finally {
		release();
		await page.unrouteAll({ behavior: "wait" });
	}
});
