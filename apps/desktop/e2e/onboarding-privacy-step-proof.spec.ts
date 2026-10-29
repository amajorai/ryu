import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { z } from "zod";

const NODE_TOKEN = "first-project-integration-node-token";
const EVIDENCE = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/onboarding-privacy-step-proof-current-20261006"
);
const PRIVACY_VALUES = {
	"product-analytics-enabled": "true",
	"community-stats-enabled": "true",
	"crash-reports-enabled": "true",
	"diagnostics-export-enabled": "false",
};

interface ApiCall {
	authorization: string | undefined;
	body: unknown;
	method: string;
	path: string;
}

interface ScenarioOptions {
	holdWrites?: boolean;
	initialPreferences?: Record<string, string>;
	readFailureOnceKey?: string;
	writeFailureOnceKey?: string;
}

async function capturePrivacyScreenshot(page: Page, name: string) {
	await expect
		.poll(() =>
			page
				.getByRole("heading", { name: "Your privacy choices", exact: true })
				.evaluate((heading) => {
					for (
						let element: Element | null = heading;
						element;
						element = element.parentElement
					) {
						const style = getComputedStyle(element);
						if (
							Number(style.opacity) < 1 ||
							(style.filter !== "none" && style.filter !== "blur(0px)")
						) {
							return false;
						}
					}
					return true;
				})
		)
		.toBe(true);
	await mkdir(EVIDENCE, { recursive: true });
	await page.screenshot({ path: path.join(EVIDENCE, name), fullPage: true });
}

async function mountPrivacyPage(
	page: Page,
	options: ScenarioOptions,
	testInfo: TestInfo
) {
	const calls: ApiCall[] = [];
	const unhandled: ApiCall[] = [];
	const errors: string[] = [];
	const failedResponses: Array<{
		method: string;
		path: string;
		status: number;
	}> = [];
	const preferences = new Map(
		Object.entries({ ...PRIVACY_VALUES, ...options.initialPreferences })
	);
	let readFailurePending = options.readFailureOnceKey;
	let writeFailurePending = options.writeFailureOnceKey;
	let heldWriteCount = 0;
	let releaseHeldWrites = () => {};
	let onWriteHeld = () => {};
	const allWritesHeld = new Promise<void>((resolve) => {
		releaseHeldWrites = resolve;
	});
	const firstWriteHeld = new Promise<void>((resolve) => {
		onWriteHeld = resolve;
	});
	const writeValues: string[] = [];

	page.on("pageerror", (error) => errors.push(error.message));
	page.on("response", (response) => {
		if (response.status() >= 400) {
			failedResponses.push({
				method: response.request().method(),
				path: new URL(response.url()).pathname,
				status: response.status(),
			});
		}
	});
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (!url.pathname.startsWith("/api/")) {
			await route.continue();
			return;
		}
		let body = null;
		try {
			body = request.postDataJSON();
		} catch {
			// Read requests do not have a body.
		}
		const call = {
			method: request.method(),
			path: url.pathname,
			authorization: request.headers().authorization,
			body,
		};
		calls.push(call);
		const fulfill = <Payload>(json: Payload, status = 200) =>
			route.fulfill({ status, contentType: "application/json", json });

		// The actual onboarding harness also mounts EntitlementProvider. After
		// resolving the signed-out default verdict, useEntitlement pushes these two
		// node gates as raw boolean strings through the production preference client.
		// Keep them finite and separate from the four privacy consent choices.
		if (
			url.pathname === "/api/preferences/entitlement-active" ||
			url.pathname === "/api/preferences/managed-inference-entitled"
		) {
			const key = url.pathname.slice("/api/preferences/".length);
			const value = z
				.object({ value: z.enum(["true", "false"]) })
				.safeParse(body).data?.value;
			if (
				call.method !== "PUT" ||
				call.authorization !== `Bearer ${NODE_TOKEN}` ||
				(value !== "true" && value !== "false")
			) {
				unhandled.push(call);
				await fulfill(
					{ error: "Unexpected entitlement preference request" },
					400
				);
				return;
			}
			await fulfill({ key, value });
			return;
		}

		if (url.pathname.startsWith("/api/preferences/")) {
			if (call.authorization !== `Bearer ${NODE_TOKEN}`) {
				unhandled.push(call);
				await fulfill({ error: "Unexpected preference target" }, 401);
				return;
			}
			const key = decodeURIComponent(
				url.pathname.slice("/api/preferences/".length)
			);
			if (!(key in PRIVACY_VALUES) || key.includes("/")) {
				unhandled.push(call);
				await fulfill({ error: "Unknown privacy preference" }, 404);
				return;
			}
			if (call.method === "GET") {
				if (readFailurePending === key) {
					readFailurePending = undefined;
					await fulfill({ message: "Privacy preference read refused" }, 503);
					return;
				}
				await fulfill({ key, value: preferences.get(key) ?? null });
				return;
			}
			const parsedWrite = z
				.object({ value: z.enum(["true", "false"]) })
				.safeParse(body);
			if (call.method !== "PUT" || !parsedWrite.success) {
				unhandled.push(call);
				await fulfill(
					{ message: "Expected a canonical privacy boolean write" },
					400
				);
				return;
			}
			const value = parsedWrite.data.value;
			writeValues.push(value);
			if (writeFailurePending === key) {
				writeFailurePending = undefined;
				await fulfill({ message: "Preference write refused" }, 503);
				return;
			}
			if (options.holdWrites) {
				heldWriteCount += 1;
				if (heldWriteCount === 1) {
					onWriteHeld();
				}
				await allWritesHeld;
			}
			preferences.set(key, value);
			await fulfill({ key, value });
			return;
		}
		if (url.pathname === "/api/auth/get-session" && call.method === "GET") {
			await fulfill({ session: null });
			return;
		}
		unhandled.push(call);
		await fulfill(
			{ error: `No finite privacy fixture for ${call.method} ${call.path}` },
			404
		);
	});
	await page.addInitScript(() => {
		localStorage.setItem("ryu_desktop_onboarding_phase", "privacy");
		localStorage.removeItem("ryu_desktop_onboarding_complete");
	});
	await page.goto("/onboarding-first-project-integration-proof.html");
	await expect(page.getByTestId("onboarding-final-step")).toBeVisible();
	await expect
		.poll(
			() =>
				calls.filter(
					(call) =>
						call.method === "GET" && call.path.startsWith("/api/preferences/")
				).length
		)
		.toBe(4);

	return {
		calls,
		errors,
		failedResponses,
		preferences,
		unhandled,
		writeValues,
		waitForHeldWrite: () => firstWriteHeld,
		releaseWrites: releaseHeldWrites,
		async diagnostics() {
			releaseHeldWrites();
			await page.unrouteAll({ behavior: "wait" });
			await testInfo.attach("privacy-step-browser-diagnostics.json", {
				body: Buffer.from(
					JSON.stringify({ calls, errors, failedResponses, unhandled }, null, 2)
				),
				contentType: "application/json",
			});
		},
	};
}

test("privacy read refusal is visible, retryable, and blocks completion", async ({
	page,
}, testInfo) => {
	const fixture = await mountPrivacyPage(
		page,
		{
			readFailureOnceKey: "product-analytics-enabled",
			initialPreferences: { "product-analytics-enabled": "false" },
		},
		testInfo
	);
	try {
		await expect
			.poll(() =>
				fixture.failedResponses.some(
					(response) =>
						response.path === "/api/preferences/product-analytics-enabled" &&
						response.status === 503
				)
			)
			.toBe(true);
		await capturePrivacyScreenshot(page, "privacy-read-refusal.png");
		await expect(page.getByRole("alert")).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Get started", exact: true })
		).toBeDisabled();
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu_desktop_onboarding_phase")
			)
		).toBe("privacy");
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu_desktop_onboarding_complete")
			)
		).toBeNull();
		await page.getByRole("button", { name: /retry/i }).click();
		await expect(
			page.getByRole("switch", { name: "Product analytics", exact: true })
		).toHaveAttribute("aria-checked", "false");
		await expect(
			page.getByRole("button", { name: "Get started", exact: true })
		).toBeEnabled();
		await capturePrivacyScreenshot(page, "privacy-read-refusal-recovered.png");
		expect(fixture.failedResponses).toContainEqual({
			method: "GET",
			path: "/api/preferences/product-analytics-enabled",
			status: 503,
		});
		expect(fixture.unhandled).toEqual([]);
		expect(fixture.errors).toEqual([]);
	} finally {
		await fixture.diagnostics();
	}
});

test("privacy write acknowledgement blocks finish and further toggles", async ({
	page,
}, testInfo) => {
	const fixture = await mountPrivacyPage(page, { holdWrites: true }, testInfo);
	try {
		const analytics = page.getByRole("switch", {
			name: "Product analytics",
			exact: true,
		});
		await analytics.click();
		await fixture.waitForHeldWrite();
		await expect(analytics).toHaveAttribute("aria-checked", "false");
		await capturePrivacyScreenshot(page, "privacy-write-pending.png");
		// Try the same switch again while its Core write is held. A correctly
		// pending-guarded control rejects a user double-toggle and emits no second
		// PUT; the current unguarded switch exposes the duplicate request path.
		if (await analytics.isEnabled()) {
			await analytics.click();
		}
		expect(fixture.writeValues).toEqual(["false"]);
		await expect(analytics).toBeDisabled();
		await expect(
			page.getByRole("button", { name: "Get started", exact: true })
		).toBeDisabled();
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu_desktop_onboarding_phase")
			)
		).toBe("privacy");
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu_desktop_onboarding_complete")
			)
		).toBeNull();
		fixture.releaseWrites();
		await expect
			.poll(() => fixture.preferences.get("product-analytics-enabled"))
			.toBe("false");
		await expect(analytics).toBeEnabled();
		await expect(
			page.getByRole("button", { name: "Get started", exact: true })
		).toBeEnabled();
		await capturePrivacyScreenshot(page, "privacy-write-acknowledged.png");
		expect(fixture.writeValues).toEqual(["false"]);
		expect(fixture.unhandled).toEqual([]);
		expect(fixture.errors).toEqual([]);
	} finally {
		await fixture.diagnostics();
	}
});

test("failed privacy save restores the acknowledged state and exact retry persists", async ({
	page,
}, testInfo) => {
	const fixture = await mountPrivacyPage(
		page,
		{ writeFailureOnceKey: "product-analytics-enabled" },
		testInfo
	);
	try {
		const analytics = page.getByRole("switch", {
			name: "Product analytics",
			exact: true,
		});
		await analytics.click();
		await expect
			.poll(() =>
				fixture.failedResponses.some(
					(response) =>
						response.path === "/api/preferences/product-analytics-enabled" &&
						response.status === 503
				)
			)
			.toBe(true);
		await expect(analytics).toHaveAttribute("aria-checked", "true");
		await expect
			.poll(() => fixture.preferences.get("product-analytics-enabled"))
			.toBe("true");
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu:product-analytics-enabled")
				)
			)
			.toBe("true");
		await capturePrivacyScreenshot(page, "privacy-write-refusal-restored.png");
		const refusalAlert = page
			.getByRole("alert")
			.filter({ hasText: "Couldn't save your privacy choice." });
		await expect(
			refusalAlert.getByText(/Your previous choice is restored\./)
		).toBeVisible();
		await expect(analytics).toBeDisabled();
		await expect(
			page.getByRole("button", { name: "Get started", exact: true })
		).toBeDisabled();

		await page
			.getByRole("button", { name: "Retry saving", exact: true })
			.click();
		await expect
			.poll(() => fixture.preferences.get("product-analytics-enabled"))
			.toBe("false");
		await expect(analytics).toHaveAttribute("aria-checked", "false");
		await expect(analytics).toBeEnabled();
		await expect(
			page.getByRole("button", { name: "Get started", exact: true })
		).toBeEnabled();
		const readback = await page.evaluate(async (token) => {
			const response = await fetch(
				"/api/preferences/product-analytics-enabled",
				{
					headers: { Authorization: `Bearer ${token}` },
				}
			);
			return { status: response.status, body: await response.json() };
		}, NODE_TOKEN);
		expect(readback).toEqual({
			status: 200,
			body: { key: "product-analytics-enabled", value: "false" },
		});
		await page.reload();
		await expect(page.getByTestId("onboarding-final-step")).toBeVisible();
		await expect(analytics).toHaveAttribute("aria-checked", "false");
		await capturePrivacyScreenshot(page, "privacy-exact-retry-readback.png");
		expect(fixture.writeValues).toEqual(["false", "false"]);
		expect(fixture.failedResponses).toContainEqual({
			method: "PUT",
			path: "/api/preferences/product-analytics-enabled",
			status: 503,
		});
		expect(fixture.unhandled).toEqual([]);
		expect(fixture.errors).toEqual([]);
	} finally {
		await fixture.diagnostics();
	}
});
