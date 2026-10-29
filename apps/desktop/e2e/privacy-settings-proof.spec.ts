import { expect, type Page, type Route, test } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";

const STORY_URL = "/privacy-settings-proof.html";
const ERROR = "Fixture save failure";
const SUPPORT_GRANT_NOW = Date.UTC(2030, 0, 2, 12, 0, 0);
const EIGHT_HOUR_EXPIRY = SUPPORT_GRANT_NOW + 8 * 60 * 60 * 1000;

interface HealingConfig {
	auto_decide: boolean;
	cooldown_secs: number;
	diagnose_effort: string;
	diagnose_model: string;
	enabled: boolean;
	max_attempts: number;
}

interface ProofWindow extends Window {
	__proofOpenExternal?: string;
}

interface PrivacyFixtures {
	healing: HealingConfig;
	preferences: Map<string, string>;
	writes: Array<{ key: string; value: string }>;
}

function createFixtures(): PrivacyFixtures {
	return {
		healing: {
			auto_decide: false,
			cooldown_secs: 60,
			diagnose_effort: "medium",
			diagnose_model: "default",
			enabled: true,
			max_attempts: 2,
		},
		preferences: new Map([
			["product-analytics-enabled", "true"],
			["community-stats-enabled", "true"],
			["profile-activity-enabled", "true"],
			["crash-reports-enabled", "true"],
			["diagnostics-export-enabled", "false"],
			["diagnostics-otlp-endpoint", ""],
			["diagnostics-otlp-content-mode", "metadata_only"],
			["support-access-local-enabled", "false"],
			["support-access-local-expiry", "0"],
		]),
		writes: [],
	};
}

async function mockPrivacyApi(
	page: Page,
	fixtures: PrivacyFixtures,
	options: {
		failContentMode?: boolean;
		failHealing?: boolean;
		failProductAnalytics?: boolean;
		failSupportExpiryOnce?: boolean;
	} = {}
) {
	let supportExpiryRefusalRemaining = options.failSupportExpiryOnce ? 1 : 0;
	await page.route("**/api/preferences/**", async (route: Route) => {
		const request = route.request();
		const key = new URL(request.url()).pathname.split("/").at(-1);
		if (!key) {
			await route.fulfill({ status: 400, body: "Missing preference key" });
			return;
		}

		if (request.method() === "GET") {
			const value = fixtures.preferences.get(key);
			if (value === undefined) {
				await route.fulfill({
					status: 404,
					contentType: "application/json",
					body: JSON.stringify({ error: "Preference not found" }),
				});
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ key, value }),
			});
			return;
		}

		const body = request.postDataJSON();
		if (options.failProductAnalytics && key === "product-analytics-enabled") {
			await route.fulfill({
				status: 500,
				contentType: "application/json",
				body: JSON.stringify({ error: ERROR }),
			});
			return;
		}
		if (options.failContentMode && key === "diagnostics-otlp-content-mode") {
			await route.fulfill({ status: 503, json: { error: ERROR } });
			return;
		}
		if (
			key === "support-access-local-expiry" &&
			supportExpiryRefusalRemaining > 0
		) {
			supportExpiryRefusalRemaining -= 1;
			await route.fulfill({ status: 503, json: { error: ERROR } });
			return;
		}
		if (!isNativeText(body.value)) {
			await route.fulfill({ status: 400, body: "Missing preference value" });
			return;
		}
		fixtures.preferences.set(key, body.value);
		fixtures.writes.push({ key, value: body.value });
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ key, value: body.value }),
		});
	});

	await page.route("**/api/healing/config", async (route: Route) => {
		if (route.request().method() === "GET") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(fixtures.healing),
			});
			return;
		}
		if (options.failHealing) {
			await route.fulfill({
				status: 500,
				contentType: "application/json",
				body: JSON.stringify({ error: ERROR }),
			});
			return;
		}
		const patch = route.request().postDataJSON();
		fixtures.healing = { ...fixtures.healing, ...patch };
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(fixtures.healing),
		});
	});
}

test.describe.configure({ timeout: 60_000 });

test("saves each privacy choice and analytics inspector action", async ({
	page,
}) => {
	page.setDefaultTimeout(5000);
	page.setDefaultNavigationTimeout(30_000);
	const fixtures = createFixtures();
	await mockPrivacyApi(page, fixtures);
	await page.clock.setFixedTime(SUPPORT_GRANT_NOW);
	await page.addInitScript(() => {
		// The Desktop egress-log reader (src/lib/analytics.ts) parses every entry
		// against the event catalog and drops the whole log on an unknown name,
		// so the seeded row must be a real catalog event.
		localStorage.setItem(
			"ryu:analytics-egress-log",
			JSON.stringify([
				{
					at: 1_800_000_000_000,
					event: "agent_installed",
					props: { agent_id: "proof-agent" },
				},
			])
		);
	});
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await expect(page.getByTestId("privacy-settings-proof")).toBeVisible();

	const privacyLinks = page.getByRole("button", {
		name: "our privacy & data page",
	});
	await expect(privacyLinks).toHaveCount(2);
	await privacyLinks.first().click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: privacy-settings-proof.tsx installs __proofOpenExternal before this proof page is evaluated. */ (
						window as ProofWindow
					).__proofOpenExternal
			)
		)
		.toMatch(/\/docs\/surfaces\/desktop\/transparency$/);
	await page.getByRole("button", { name: "Got it", exact: true }).click();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:privacy-disclosure-ack"))
	).resolves.toBe("true");
	await page.getByRole("button", { name: "our privacy & data page" }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: privacy-settings-proof.tsx installs __proofOpenExternal before this proof page is evaluated. */ (
						window as ProofWindow
					).__proofOpenExternal
			)
		)
		.toMatch(/\/docs\/surfaces\/desktop\/transparency$/);
	await page.getByText("Usage & crash data", { exact: true }).click();
	await expect(
		page.getByText("Share anonymous usage analytics", { exact: true })
	).toBeVisible();
	const sharingSwitches = page.getByRole("switch");
	for (const index of [0, 1, 2]) {
		const control = sharingSwitches.nth(index);
		await control.click();
		await expect(control).not.toBeChecked();
	}
	await expect
		.poll(() => fixtures.preferences.get("product-analytics-enabled"))
		.toBe("false");
	await expect
		.poll(() => fixtures.preferences.get("community-stats-enabled"))
		.toBe("false");
	await expect
		.poll(() => fixtures.preferences.get("crash-reports-enabled"))
		.toBe("false");

	await page.getByRole("button", { name: "See what we send" }).click();
	await expect(
		page.getByRole("dialog", { name: "What product analytics sends" })
	).toBeVisible();
	// The catalog lists agent_installed too, so the log row is identified by
	// the seeded prop text that only an egress row renders.
	await expect(
		page.getByText("agent_id=proof-agent", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Refresh" }).click();
	await expect(page.getByText("Egress log (1)", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Clear log" }).click();
	await expect(page.getByText("Egress log (0)", { exact: true })).toBeVisible();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:analytics-egress-log"))
	).resolves.toBeNull();
	await page.getByRole("button", { name: "Close" }).click();

	await page.getByRole("button", { name: "Privacy", exact: true }).click();
	await page.getByText("Diagnostics & support", { exact: true }).click();
	await expect(
		page.getByText("Export local diagnostics over OTLP", { exact: true })
	).toBeVisible();
	const diagnosticsSwitches = page.getByRole("switch");
	const diagnosticsExport = diagnosticsSwitches.nth(0);
	await diagnosticsExport.click();
	await expect(diagnosticsExport).toBeChecked();
	await expect
		.poll(() => fixtures.preferences.get("diagnostics-export-enabled"))
		.toBe("true");

	const endpoint = page.getByRole("textbox", { name: "OTLP endpoint" });
	await endpoint.fill("  https://otel.example.test/v1/traces  ");
	await endpoint.press("Tab");
	await expect
		.poll(() => fixtures.preferences.get("diagnostics-otlp-endpoint"))
		.toBe("https://otel.example.test/v1/traces");

	const duration = page.getByRole("combobox").last();
	await duration.click();
	await page.getByRole("option", { exact: true, name: "8 hours" }).click();
	await expect(duration.locator('[data-slot="select-value"]')).toHaveText(
		"8 hours"
	);
	const grantSupport = diagnosticsSwitches.nth(1);
	await grantSupport.click();
	await expect(grantSupport).toBeChecked();
	await expect(duration).toBeDisabled();
	await expect
		.poll(() => fixtures.preferences.get("support-access-local-enabled"))
		.toBe("true");
	const expiryWriteIndex = fixtures.writes.findIndex(
		(write) => write.key === "support-access-local-expiry"
	);
	const enabledWriteIndex = fixtures.writes.findIndex(
		(write) => write.key === "support-access-local-enabled"
	);
	expect(expiryWriteIndex).toBeGreaterThanOrEqual(0);
	expect(enabledWriteIndex).toBeGreaterThan(expiryWriteIndex);
	const expiry = Number(
		fixtures.preferences.get("support-access-local-expiry")
	);
	expect(expiry).toBe(EIGHT_HOUR_EXPIRY);
	expect(
		fixtures.writes.filter((write) =>
			write.key.startsWith("support-access-local-")
		)
	).toEqual([
		{ key: "support-access-local-expiry", value: String(EIGHT_HOUR_EXPIRY) },
		{ key: "support-access-local-enabled", value: "true" },
	]);
	await page.screenshot({
		fullPage: true,
		path: "e2e/artifacts/desktop-privacy-diagnostics-proof.png",
	});

	await grantSupport.click();
	await expect(grantSupport).not.toBeChecked();
	await expect
		.poll(() => fixtures.preferences.get("support-access-local-enabled"))
		.toBe("false");

	await page.getByRole("button", { name: "Privacy", exact: true }).click();
	await page.getByText("Self-healing", { exact: true }).click();
	const healingSwitches = page.getByRole("switch");
	const healingEnabled = healingSwitches.nth(0);
	const autoFix = healingSwitches.nth(1);
	await healingEnabled.click();
	await expect(healingEnabled).not.toBeChecked();
	await expect(healingEnabled).toHaveAttribute("data-unchecked", "");
	await expect(autoFix).toBeDisabled();
	await expect.poll(() => fixtures.healing.enabled).toBe(false);
	await healingEnabled.click();
	await expect(healingEnabled).toBeChecked();
	await expect(healingEnabled).toHaveAttribute("data-checked", "");
	await expect(autoFix).toBeEnabled();
	const uncheckedAutoFixBackground = await autoFix.evaluate(
		(element) => getComputedStyle(element).backgroundColor
	);
	await autoFix.click();
	await expect(autoFix).toBeChecked();
	await expect(autoFix).toHaveAttribute("data-checked", "");
	await expect
		.poll(() =>
			autoFix.evaluate((element) => getComputedStyle(element).backgroundColor)
		)
		.not.toBe(uncheckedAutoFixBackground);
	await expect.poll(() => fixtures.healing.auto_decide).toBe(true);
	await page.screenshot({
		fullPage: true,
		path: "e2e/artifacts/desktop-privacy-self-healing-proof.png",
	});
});

test("reverts an unsaved analytics or self-healing change and shows an error", async ({
	page,
}) => {
	page.setDefaultTimeout(5000);
	page.setDefaultNavigationTimeout(30_000);
	const fixtures = createFixtures();
	await mockPrivacyApi(page, fixtures, {
		failHealing: true,
		failProductAnalytics: true,
	});
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "Got it", exact: true }).click();
	await page.getByText("Usage & crash data", { exact: true }).click();
	const analytics = page.getByRole("switch").nth(0);
	await analytics.click();
	await expect(
		page.getByText("Couldn't save your analytics choice", { exact: true })
	).toBeVisible();
	await expect(analytics).toBeChecked();

	await page.getByRole("button", { name: "Privacy", exact: true }).click();
	await page.getByText("Self-healing", { exact: true }).click();
	const autoFix = page.getByRole("switch").nth(1);
	await autoFix.click();
	await expect(
		page.getByText("Couldn't save your auto-fix choice", { exact: true })
	).toBeVisible();
	await expect(autoFix).not.toBeChecked();
});

test("an eight-hour support grant refuses an unsaved expiry, retries the exact deadline before enabling, and reloads the server-stored finite grant", async ({
	page,
}) => {
	const fixtures = createFixtures();
	await mockPrivacyApi(page, fixtures, { failSupportExpiryOnce: true });
	await page.clock.setFixedTime(SUPPORT_GRANT_NOW);
	const writes: Array<{ key: string; body: unknown }> = [];
	const reads: string[] = [];
	page.on("request", (request) => {
		const key = new URL(request.url()).pathname.split("/").at(-1);
		if (
			key !== "support-access-local-expiry" &&
			key !== "support-access-local-enabled"
		) {
			return;
		}
		if (request.method() === "PUT") {
			writes.push({ key, body: request.postDataJSON() });
		} else if (request.method() === "GET") {
			reads.push(key);
		} else {
			throw new Error(
				`Unexpected support preference method ${request.method()}`
			);
		}
	});
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "Got it", exact: true }).click();
	await page.getByText("Diagnostics & support", { exact: true }).click();
	const duration = page.getByRole("combobox").last();
	await duration.click();
	await page.getByRole("option", { name: "8 hours", exact: true }).click();
	const grant = page.getByRole("switch").nth(1);
	await expect(grant).not.toBeChecked();
	await grant.click();
	await expect(
		page.getByText("Couldn't grant support access", { exact: true })
	).toBeVisible();
	await expect(grant).not.toBeChecked();
	await expect(duration).toBeEnabled();
	expect(fixtures.preferences.get("support-access-local-enabled")).toBe(
		"false"
	);
	expect(fixtures.preferences.get("support-access-local-expiry")).toBe("0");
	expect(writes).toEqual([
		{
			key: "support-access-local-expiry",
			body: { value: String(EIGHT_HOUR_EXPIRY) },
		},
	]);
	await grant.click();
	await expect(grant).toBeChecked();
	await expect(duration).toBeDisabled();
	await expect
		.poll(() => fixtures.preferences.get("support-access-local-enabled"))
		.toBe("true");
	expect(fixtures.preferences.get("support-access-local-expiry")).toBe(
		String(EIGHT_HOUR_EXPIRY)
	);
	expect(writes).toEqual([
		{
			key: "support-access-local-expiry",
			body: { value: String(EIGHT_HOUR_EXPIRY) },
		},
		{
			key: "support-access-local-expiry",
			body: { value: String(EIGHT_HOUR_EXPIRY) },
		},
		{ key: "support-access-local-enabled", body: { value: "true" } },
	]);
	const readCount = reads.length;
	await page.reload();
	await page.getByText("Diagnostics & support", { exact: true }).click();
	await expect(grant).toBeChecked();
	await expect(page.getByRole("combobox").last()).toBeDisabled();
	await expect(page.getByText(/Active until /)).toBeVisible();
	expect(reads.slice(readCount).sort()).toEqual([
		"support-access-local-enabled",
		"support-access-local-expiry",
	]);
	expect(writes).toHaveLength(3);
	expect(fixtures.preferences.get("support-access-local-expiry")).toBe(
		String(EIGHT_HOUR_EXPIRY)
	);
});

const CONTENT_MODE_KEY = "diagnostics-otlp-content-mode";
const FULL_CONTENT_WARNING =
	/Your prompts, model responses, and tool data will leave this device/;

test("the OTLP content mode offers exactly two choices, stores the chosen value, shows the full-content warning only while it is selected, and reloads from the stored value", async ({
	page,
}) => {
	page.setDefaultTimeout(5000);
	page.setDefaultNavigationTimeout(30_000);
	const fixtures = createFixtures();
	await mockPrivacyApi(page, fixtures);
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "Got it", exact: true }).click();
	await page.getByText("Diagnostics & support", { exact: true }).click();

	const mode = page.getByRole("combobox", { name: "Content mode" });
	const shownMode = mode.locator('[data-slot="select-value"]');
	await expect(shownMode).toHaveText("Metadata only");
	await expect(page.getByText(FULL_CONTENT_WARNING)).toHaveCount(0);

	await mode.click();
	await expect(page.getByRole("option")).toHaveText([
		"Metadata only",
		"Full content",
	]);
	await page.getByRole("option", { exact: true, name: "Full content" }).click();
	await expect(shownMode).toHaveText("Full content");
	await expect(page.getByText(FULL_CONTENT_WARNING)).toBeVisible();
	await expect
		.poll(() => fixtures.preferences.get(CONTENT_MODE_KEY))
		.toBe("content");
	// Content mode is its own consent: choosing it never turns export on.
	expect(fixtures.preferences.get("diagnostics-export-enabled")).toBe("false");
	expect(fixtures.writes).toEqual([
		{ key: CONTENT_MODE_KEY, value: "content" },
	]);

	await page.reload();
	await page.getByText("Diagnostics & support", { exact: true }).click();
	await expect(shownMode).toHaveText("Full content");
	await expect(page.getByText(FULL_CONTENT_WARNING)).toBeVisible();

	await mode.click();
	await page
		.getByRole("option", { exact: true, name: "Metadata only" })
		.click();
	await expect(shownMode).toHaveText("Metadata only");
	await expect(page.getByText(FULL_CONTENT_WARNING)).toHaveCount(0);
	await expect
		.poll(() => fixtures.preferences.get(CONTENT_MODE_KEY))
		.toBe("metadata_only");
	expect(fixtures.writes).toEqual([
		{ key: CONTENT_MODE_KEY, value: "content" },
		{ key: CONTENT_MODE_KEY, value: "metadata_only" },
	]);
});

test("a refused content-mode save keeps metadata only, shows the error, and never reveals the full-content warning", async ({
	page,
}) => {
	page.setDefaultTimeout(5000);
	page.setDefaultNavigationTimeout(30_000);
	const fixtures = createFixtures();
	await mockPrivacyApi(page, fixtures, { failContentMode: true });
	const attempts: unknown[] = [];
	page.on("request", (request) => {
		const key = new URL(request.url()).pathname.split("/").at(-1);
		if (key === CONTENT_MODE_KEY && request.method() === "PUT") {
			attempts.push(request.postDataJSON());
		}
	});
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "Got it", exact: true }).click();
	await page.getByText("Diagnostics & support", { exact: true }).click();

	const mode = page.getByRole("combobox", { name: "Content mode" });
	const shownMode = mode.locator('[data-slot="select-value"]');
	await mode.click();
	await page.getByRole("option", { exact: true, name: "Full content" }).click();
	await expect(
		page.getByText("Couldn't save the diagnostics content mode", {
			exact: true,
		})
	).toBeVisible();
	await expect(shownMode).toHaveText("Metadata only");
	await expect(page.getByText(FULL_CONTENT_WARNING)).toHaveCount(0);
	expect(attempts).toEqual([{ value: "content" }]);
	expect(fixtures.preferences.get(CONTENT_MODE_KEY)).toBe("metadata_only");
	expect(fixtures.writes).toEqual([]);
});
