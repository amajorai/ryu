import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	chooseOrg,
	EVIDENCE,
	fixture,
	localDefault,
	PROOF_URL,
} from "./onboarding-setup-page-proof.fixture.ts";

test("production org/provider/cloud/import callers persist exact mutations and reload auto-import", async ({
	page,
}) => {
	const f = await fixture(page);
	try {
		await localDefault(page);
		await chooseOrg(page);
		const key = page.getByLabel("Fixture Provider API key");
		await expect(key).toHaveAttribute("type", "password");
		await key.fill("  fixture-key-only  ");
		await page.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(page.getByText("Configured on this node")).toBeVisible();
		expect(
			f.calls.find((c) => c.path === "/api/pi-config/providers")?.body
		).toEqual({ apiKey: "fixture-key-only", provider: "fixture-provider" });
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await page
			.getByRole("button", { name: "Skip for now", exact: true })
			.click();
		await expect(
			page.getByText("No importable threads were found on this node.")
		).toBeVisible();
		const toggle = page.getByRole("switch");
		await expect(toggle).toBeChecked();
		await toggle.click();
		await page.reload();
		await expect(page.getByRole("switch")).not.toBeChecked();
		const saved = await f.read();
		expect(saved.activeOrg).toBe("org-two");
		expect(saved.preferences["default-cloud-agent-selection"]).toBe("");
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu:auto-import-agent-threads")
			)
		).toBe("false");
		expect(
			f.calls
				.filter((c) => c.path === "/api/auth/organization/set-active")
				.at(-1)?.body
		).toEqual({ organizationId: "org-two" });
		await mkdir(EVIDENCE, { recursive: true });
		await page.screenshot({
			path: path.join(
				EVIDENCE,
				"onboarding-production-import-toggle-readback.png"
			),
			fullPage: true,
		});
	} finally {
		await f.close();
	}
});

test("production acquisition answer retries exact session mutation and navigates activation steps", async ({
	page,
}) => {
	const f = await fixture(page, { failedSource: true, paid: true });
	try {
		await page.addInitScript(() =>
			localStorage.setItem("ryu_desktop_onboarding_phase", "activation-source")
		);
		await page.goto(PROOF_URL);
		await expect(
			page.getByRole("button", { name: "Continue", exact: true })
		).toBeDisabled();
		await page.getByRole("radio", { name: "Search", exact: true }).click();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(
			page.getByText(
				"We couldn't save that answer. Try again or check your connection."
			)
		).toBeVisible();
		expect((await f.read()).onboardingSource).toBeNull();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Recommended for you" })
		).toBeVisible();
		const writes = f.calls.filter(
			(c) => c.path === "/api/profile/me/onboarding-source"
		);
		expect(writes).toHaveLength(2);
		for (const call of writes) {
			expect(call).toMatchObject({
				method: "PATCH",
				authorization: "Bearer onboarding-fixture-session",
				body: { source: "search" },
			});
		}
		expect((await f.read()).onboardingSource).toBe("search");
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await page.getByRole("button", { name: "See your first task" }).click();
		await expect(
			page.getByRole("heading", { name: "Your subscription is ready" })
		).toBeVisible();
		await page.getByRole("button", { name: "Continue to task" }).click();
		await expect(
			page.getByRole("button", { name: "Start task" })
		).toBeVisible();
		await page.getByRole("button", { name: "Start task" }).click();
		await expect(page.getByRole("alert")).toHaveText(
			"This workspace cannot create an onboarding task. Ask the node owner to continue."
		);
		expect(
			f.calls.some((c) => c.method === "POST" && c.path === "/api/quests")
		).toBe(false);
		expect(
			f.calls.some((c) => c.method === "POST" && c.path.includes("checkout"))
		).toBe(false);
	} finally {
		await f.close();
	}
});

test("production appearance controls persist both presets, theme and roundness before continuation", async ({
	page,
}) => {
	const f = await fixture(page);
	try {
		await page.addInitScript(() =>
			localStorage.setItem("ryu_desktop_onboarding_phase", "theme")
		);
		await page.goto(PROOF_URL);
		await expect(
			page.getByRole("heading", { name: "Make it yours" })
		).toBeVisible();
		await page
			.locator("label")
			.filter({
				has: page.locator('input[name="onboarding-theme"][value="dark"]'),
			})
			.click();
		for (const index of [0, 1]) {
			await page.getByRole("combobox").nth(index).click();
			await page.getByRole("option").last().click();
		}
		const slider = page.getByRole("slider", { name: "Roundness" });
		await slider.focus();
		await slider.press("End");
		const saved = await page.evaluate(() => ({
			theme: localStorage.getItem("theme"),
			light: localStorage.getItem("ryu_light_preset"),
			dark: localStorage.getItem("ryu_dark_preset"),
			radius: localStorage.getItem("ryu_radius"),
		}));
		expect(saved.theme).toBe("dark");
		expect(saved.light).toBeTruthy();
		expect(saved.dark).toBeTruthy();
		await page.reload();
		await expect(
			page.getByRole("radio", { name: /^Dark\s+Dark$/ })
		).toBeChecked();
		await expect(slider).toHaveAttribute("aria-valuenow", saved.radius ?? "");
		expect(
			await page.evaluate(() => ({
				light: localStorage.getItem("ryu_light_preset"),
				dark: localStorage.getItem("ryu_dark_preset"),
			}))
		).toEqual({ light: saved.light, dark: saved.dark });
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Set your preferences" })
		).toBeVisible();
	} finally {
		await f.close();
	}
});

test("production desktop preferences persist appearance and continue to privacy", async ({
	page,
}) => {
	const f = await fixture(page);
	try {
		await page.addInitScript(() =>
			localStorage.setItem("ryu_desktop_onboarding_phase", "preferences")
		);
		await page.goto(PROOF_URL);
		await expect(
			page.getByRole("heading", { name: "Set your preferences" })
		).toBeVisible();
		// The inset sidebar is the default since 0db714a247 (Ryu Quiet P1: "quiet
		// shell frame: flush inset"), so the switch starts on and the persisted
		// change is turning it off to the floating sidebar.
		const insetSidebar = page.locator(
			'[role="switch"]:has(+ #onboarding-inset-sidebar)'
		);
		await expect(insetSidebar).toBeChecked();
		await insetSidebar.click();
		await page
			.locator('[role="switch"]:has(+ #onboarding-pointer-cursor)')
			.click();
		expect(
			await page.evaluate(() => ({
				sidebar: localStorage.getItem("ryu:sidebar-variant"),
				pointer: localStorage.getItem("ryu_pointer_cursor"),
				attribute: document.documentElement.getAttribute("data-pointer-cursor"),
			}))
		).toEqual({ sidebar: "floating", pointer: "true", attribute: "true" });
		await page.reload();
		await expect(insetSidebar).not.toBeChecked();
		await expect(
			page.locator('[role="switch"]:has(+ #onboarding-pointer-cursor)')
		).toBeChecked();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		// Preferences hand off to the agent guidance step and then, while no
		// notification choice is saved, the notifications ask before privacy (the
		// "guidance" and "notifications" phases, already in place before Ryu Quiet
		// at 07d403e33).
		await expect(
			page.getByRole("heading", { name: "A few things to know" })
		).toBeVisible();
		await page
			.getByRole("button", { name: "Continue to privacy", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Know when your agents reply" })
		).toBeVisible();
		await page.getByRole("button", { name: "Not now", exact: true }).click();
		await expect(page.getByTestId("onboarding-final-continue")).toBeVisible();
	} finally {
		await f.close();
	}
});

test("production privacy choices reject failed write, retry and persist all four after reload", async ({
	page,
}) => {
	const f = await fixture(page, { failedPreference: true });
	try {
		await page.addInitScript(() =>
			localStorage.setItem("ryu_desktop_onboarding_phase", "welcome")
		);
		await page.goto(PROOF_URL);
		const analytics = page.locator(
			'[role="switch"]:has(+ #onboarding-product-analytics)'
		);
		await expect(analytics).toBeChecked();
		await analytics.click();
		await expect
			.poll(
				() =>
					f.calls.filter(
						(c) =>
							c.method === "PUT" &&
							c.path === "/api/preferences/product-analytics-enabled"
					).length
			)
			.toBe(1);
		await expect(analytics).toBeChecked();
		expect(
			(await f.read()).preferences["product-analytics-enabled"]
		).toBeUndefined();
		await analytics.click();
		await expect(analytics).not.toBeChecked();
		await page
			.locator('[role="switch"]:has(+ #onboarding-community-stats)')
			.click();
		await page
			.locator('[role="switch"]:has(+ #onboarding-crash-reports)')
			.click();
		await page
			.locator('[role="switch"]:has(+ #onboarding-diagnostics-export)')
			.click();
		await expect
			.poll(
				async () => (await f.read()).preferences["diagnostics-export-enabled"]
			)
			.toBe("true");
		for (const [key, value] of Object.entries({
			"product-analytics-enabled": "false",
			"community-stats-enabled": "false",
			"crash-reports-enabled": "false",
			"diagnostics-export-enabled": "true",
		})) {
			expect((await f.read()).preferences[key]).toBe(value);
			expect(
				f.calls
					.filter(
						(c) => c.method === "PUT" && c.path === `/api/preferences/${key}`
					)
					.at(-1)
			).toMatchObject({
				authorization: "Bearer setup-proof-node-token",
				body: { value },
			});
		}
		await page.reload();
		for (const id of [
			"product-analytics",
			"community-stats",
			"crash-reports",
		]) {
			await expect(
				page.locator(`[role="switch"]:has(+ #onboarding-${id})`)
			).not.toBeChecked();
		}
		await expect(
			page.locator('[role="switch"]:has(+ #onboarding-diagnostics-export)')
		).toBeChecked();
		await mkdir(EVIDENCE, { recursive: true });
		await page
			.getByText("Choose your privacy settings", { exact: true })
			.locator("..")
			.screenshot({
				path: path.join(
					EVIDENCE,
					"onboarding-production-privacy-persisted-readback.png"
				),
				animations: "disabled",
			});
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
