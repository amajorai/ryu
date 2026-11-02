import { expect, test } from "@playwright/test";

import {
	fixture,
	PROOF_URL,
} from "./onboarding-remaining-page-proof.fixture.ts";
import {
	nativeFixture,
	phase,
	screenshot,
} from "./onboarding-remaining-page-proof.helpers.ts";

test("offer Choose my own model completes the production page without checkout or task writes", async ({
	page,
}) => {
	const f = await fixture(page);
	try {
		await phase(page, "activation-offer");
		await page.goto(PROOF_URL);
		// The offer's decline is "Choose my own model" (ec6fac15e2); it finishes
		// onboarding with the task as an unsent draft for the user's own model.
		const decline = page.getByRole("button", {
			name: "Choose my own model",
			exact: true,
		});
		await expect(decline).toBeVisible();
		await screenshot(page, "offer-before-skip");
		await decline.click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_complete")
				)
			)
			.toBe("true");
		expect(
			f.calls.filter(
				(c) => /checkout|quests/.test(c.path) && c.method === "POST"
			)
		).toEqual([]);
	} finally {
		await f.close();
	}
});

test("a stored welcome phase resumes on guidance; privacy docs use the exact native open contract and Get started completes onboarding", async ({
	page,
}) => {
	const f = await fixture(page);
	const n = await nativeFixture(page, "welcome");
	try {
		await page.goto(PROOF_URL);
		// The former welcome step is the guidance summary now; a stored
		// "welcome" phase resumes there and is rewritten as "guidance".
		await expect(
			page.getByRole("heading", { name: "A few things to know" })
		).toBeVisible();
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_phase")
				)
			)
			.toBe("guidance");
		await page.getByTestId("onboarding-guidance-continue").click();
		await expect(
			page.getByRole("heading", { name: "Know when your agents reply" })
		).toBeVisible();
		await page.getByRole("button", { name: "Not now", exact: true }).click();
		// The privacy step's docs link is "Full privacy details" (4f7563c79d).
		await page
			.getByRole("button", { name: "Full privacy details", exact: true })
			.click();
		await expect
			.poll(() => n.calls.filter((c) => c.command === "open_external").length)
			.toBe(1);
		expect(n.calls.find((c) => c.command === "open_external")?.args?.url).toBe(
			"https://onboarding.fixture.invalid/docs/surfaces/desktop/transparency"
		);
		await page
			.getByTestId("onboarding-final-continue")
			.scrollIntoViewIfNeeded();
		await screenshot(page, "privacy-docs-open");
		await page.getByTestId("onboarding-final-continue").click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_complete")
				)
			)
			.toBe("true");
	} finally {
		await f.close();
	}
});

// Telegram left the forward flow (imports and profile hand straight to the
// safety or guidance step), so a stored "telegram" phase from an older release
// is the only way onto the step. Its channels were never read on this run, so
// it fails closed: nothing is created, and either button moves on.
for (const button of ["Continue", "Skip for now"]) {
	test(`a resumed Telegram step fails closed and ${button} advances to safety without channel writes`, async ({
		page,
	}) => {
		const f = await fixture(page, { existingChannels: true });
		try {
			await phase(page, "telegram", true);
			await page.goto(PROOF_URL);
			await expect(
				page.getByRole("heading", {
					name: "Check your channels",
					exact: true,
				})
			).toBeVisible();
			await screenshot(
				page,
				button === "Continue" ? "telegram-fail-closed" : "telegram-skip"
			);
			await page.getByRole("button", { name: button, exact: true }).click();
			await expect
				.poll(() =>
					page.evaluate(() =>
						localStorage.getItem("ryu_desktop_onboarding_phase")
					)
				)
				.toBe("safety");
			await expect(
				page.getByRole("heading", { name: "Set your safety posture" })
			).toBeVisible();
			expect(
				f.calls.filter(
					(c) => /channels|managed-bots/.test(c.path) && c.method !== "GET"
				)
			).toEqual([]);
		} finally {
			await f.close();
		}
	});
}

test("OS preference projection rejects failed writes, retries and reads persisted host state on reload", async ({
	page,
}) => {
	const f = await fixture(page);
	const n = await nativeFixture(page, "preferences");
	try {
		await page.goto(PROOF_URL);
		const startup = page.locator(
			'[role="switch"]:has(+ #onboarding-launch-at-login)'
		);
		const tray = page.locator(
			'[role="switch"]:has(+ #onboarding-close-to-tray)'
		);
		await expect(startup).not.toBeChecked();
		await expect(tray).toBeChecked();
		n.failures.add("plugin:autostart|enable");
		await startup.click();
		await expect
			.poll(
				() =>
					n.calls.filter((c) => c.command === "plugin:autostart|enable").length
			)
			.toBe(1);
		await expect(startup).not.toBeChecked();
		expect((await n.read()).autostart).toBe(false);
		await startup.click();
		await expect(startup).toBeChecked();
		n.failures.add("set_close_to_tray");
		await tray.click();
		await expect
			.poll(
				() => n.calls.filter((c) => c.command === "set_close_to_tray").length
			)
			.toBe(1);
		await expect(tray).toBeChecked();
		expect((await n.read()).tray).toBe(true);
		await tray.click();
		await expect(tray).not.toBeChecked();
		await expect.poll(async () => (await n.read()).tray).toBe(false);
		expect(
			n.calls
				.filter((c) => c.command === "set_close_to_tray")
				.map((c) => c.args)
		).toEqual([{ enabled: false }, { enabled: false }]);
		await page.reload();
		await expect(startup).toBeChecked();
		await expect(tray).not.toBeChecked();
		await screenshot(page, "native-preferences-readback");
	} finally {
		await f.close();
	}
});

test("production update switch prepares exact signed source and explicit install uses native projection", async ({
	page,
}) => {
	const f = await fixture(page);
	const n = await nativeFixture(page, "updates");
	try {
		await page.goto(PROOF_URL);
		await expect(
			page.getByRole("heading", { name: "Update available", exact: true })
		).toBeVisible();
		const automatic = page.getByRole("switch", {
			name: "Download app updates automatically",
		});
		await expect(automatic).not.toBeChecked();
		expect(f.calls.find((c) => c.path === "/api/update/check")).toMatchObject({
			method: "GET",
			query: "?channel=stable",
			authorization: "Bearer setup-proof-node-token",
			body: null,
		});
		n.failures.add("set_app_update_download_preference");
		await automatic.click();
		await expect
			.poll(
				() =>
					n.calls.filter(
						(c) => c.command === "set_app_update_download_preference"
					).length
			)
			.toBe(1);
		await expect(automatic).not.toBeChecked();
		await automatic.click();
		await expect(automatic).toBeChecked();
		await expect(
			page.getByRole("button", { name: "Install and restart", exact: true })
		).toBeVisible();
		expect(
			n.calls.find((c) => c.command === "prepare_app_update")?.args
		).toEqual({
			request: { expectedVersion: "0.2.0", source: { kind: "stable" } },
		});
		expect((await n.read()).installed).toBe(false);
		await page
			.getByRole("button", { name: "Install and restart", exact: true })
			.click();
		await expect.poll(async () => (await n.read()).installed).toBe(true);
		await screenshot(page, "update-prepared-install-projection");
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_phase")
				)
			)
			.toBe("choose");
	} finally {
		await f.close();
	}
});

test("closed personal offer continues local setup without purchase", async ({
	page,
}) => {
	const f = await fixture(page);
	try {
		await phase(page, "activation-offer");
		await page.goto(PROOF_URL);
		await page
			.getByRole("button", { name: "Continue with local setup", exact: true })
			.click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_complete")
				)
			)
			.toBe("true");
		expect(
			f.calls.filter(
				(c) => /checkout|quests/.test(c.path) && c.method === "POST"
			)
		).toEqual([]);
	} finally {
		await f.close();
	}
});

test("production update transport failure retries and Continue reaches the node choice", async ({
	page,
}) => {
	const f = await fixture(page);
	await nativeFixture(page, "updates");
	let attempts = 0;
	await page.route("**/api/update/check?*", async (route) => {
		attempts += 1;
		if (attempts === 1) {
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ error: "Fixture update service unavailable" }),
			});
		} else {
			await route.fallback();
		}
	});
	try {
		await page.goto(PROOF_URL);
		await expect(
			page.getByRole("heading", {
				name: "Couldn't check for updates",
				exact: true,
			})
		).toBeVisible();
		await page.getByRole("button", { name: "Try again", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Update available", exact: true })
		).toBeVisible();
		expect(attempts).toBe(2);
		await screenshot(page, "update-retry-recovered");
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_phase")
				)
			)
			.toBe("choose");
	} finally {
		await f.close();
	}
});

test("enabled personal offer rejects denied billing permission before checkout without purchase", async ({
	page,
}) => {
	// The control plane publishes billing.individual_plans with the
	// subscription status, and the flag cache is scoped per account and org,
	// so a hand-written cache record no longer stands in for it.
	const f = await fixture(page, { individualPlans: true });
	// The account vault is sealed in a native secret slot now: the seeded
	// plaintext vault below migrates into the native fixture's empty slot, so
	// the flag fetch runs for a signed-in account.
	await nativeFixture(page, "activation-offer");
	try {
		await page.addInitScript(() => {
			localStorage.setItem(
				"ryu_accounts",
				JSON.stringify([
					{
						userId: "offer-fixture-user",
						token: "onboarding-fixture-session",
						name: "Fixture user",
						email: "fixture@example.invalid",
					},
				])
			);
			localStorage.setItem("ryu_active_user_id", "offer-fixture-user");
		});
		await page.route("**/api/step-up/status?scope=billing", async (route) => {
			await route.fulfill({
				status: 403,
				contentType: "application/json",
				body: JSON.stringify({ error: "Fixture billing permission denied" }),
			});
		});
		await page.goto(PROOF_URL);
		// Checkout waits for the automatic-renewal consent (4f7563c79d).
		const startPro = page.getByRole("button", {
			name: "Start Pro for $49/month",
			exact: true,
		});
		await expect(startPro).toBeDisabled();
		await page
			.getByRole("checkbox", {
				name: "I agree to automatic renewal and the subscription terms",
			})
			.check();
		await startPro.click();
		await expect(page.getByRole("alert")).toContainText(
			"We couldn't start checkout. Try again."
		);
		expect(f.calls.filter((c) => /checkout/.test(c.path))).toEqual([]);
		await screenshot(page, "offer-billing-denied");
		await page
			.getByRole("button", { name: "Choose my own model", exact: true })
			.click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_complete")
				)
			)
			.toBe("true");
	} finally {
		await f.close();
	}
});
