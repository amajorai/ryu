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

// After the organization choice the flow goes to the cloud default (paid) or
// straight to safety/guidance (4f7563c79d, kept by the 5f8fe1f66e split);
// provider keys, connections and thread imports are no longer onboarding steps.
test("production org choice persists the exact active organization and an unpaid plan goes straight to guidance", async ({
	page,
}) => {
	const f = await fixture(page);
	try {
		await localDefault(page);
		await chooseOrg(page);
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
		const saved = await f.read();
		expect(saved.activeOrg).toBe("org-two");
		// An unpaid plan has no cloud lane to set, and nothing is configured
		// for a provider on the way.
		expect(saved.preferences["default-cloud-agent-selection"]).toBeUndefined();
		expect(
			f.calls.some(
				(c) => c.method !== "GET" && c.path === "/api/pi-config/providers"
			)
		).toBe(false);
		const setActive = f.calls.filter(
			(c) => c.path === "/api/auth/organization/set-active"
		);
		expect(setActive.at(-1)).toMatchObject({
			method: "POST",
			authorization: "Bearer onboarding-fixture-session",
			body: { organizationId: "org-two" },
		});
		await mkdir(EVIDENCE, { recursive: true });
		await page.screenshot({
			path: path.join(EVIDENCE, "onboarding-production-org-guidance.png"),
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
		// The source hands off to the task picker ("Recommended for you" is gone
		// since 4f7563c79d).
		await expect(
			page.getByRole("heading", { name: "What would you like Ryu to do?" })
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
		await page
			.getByRole("button", { name: "Preview a starting task", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "See what Ryu will work on" })
		).toBeVisible();
		await page
			.getByRole("button", { name: "Start managed task", exact: true })
			.click();
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
			localStorage.setItem("ryu_desktop_onboarding_phase", "privacy")
		);
		await page.goto(PROOF_URL);
		// The privacy choices are their own step; a stored "welcome" phase now
		// resumes on guidance instead.
		await expect(
			page.getByRole("heading", { name: "Your privacy choices" })
		).toBeVisible();
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
		// A failed write restores the previous choice and holds every switch
		// until the user retries that same write.
		await expect(page.getByRole("alert")).toContainText(
			"Couldn't save your privacy choice."
		);
		await expect(analytics).toBeDisabled();
		await page
			.getByRole("button", { name: "Retry saving", exact: true })
			.click();
		await expect(analytics).not.toBeChecked();
		await expect(analytics).toBeEnabled();
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
		await page.screenshot({
			path: path.join(
				EVIDENCE,
				"onboarding-production-privacy-persisted-readback.png"
			),
			animations: "disabled",
			fullPage: true,
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
