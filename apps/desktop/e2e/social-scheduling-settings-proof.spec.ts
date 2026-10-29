import { expect, type Page, test } from "@playwright/test";
import type { SettingsResponse } from "../../../apps-store/social/ui/src/types.ts";
import {
	socialSettingsProofSchema,
	socialWorkspaceProofSchema,
} from "./social-scheduling-settings-proof.contracts.ts";

interface SocialBridgeCall {
	body?: unknown;
	method?: string;
	path: string;
}

declare global {
	interface Window {
		__socialSchedulingSettingsProof?: { calls: SocialBridgeCall[] };
	}
}

function settingSwitch(page: Page, label: string) {
	return page
		.getByText(label, { exact: true })
		.locator("xpath=../..")
		.getByRole("switch");
}

async function readSettings(
	page: Page,
	workspaceId: string
): Promise<SettingsResponse> {
	const response = await page.request.get(
		`/__social/settings?workspace_id=${encodeURIComponent(workspaceId)}`
	);
	expect(response.ok()).toBe(true);
	return socialSettingsProofSchema.parse(await response.json());
}

async function saveScreenshot(page: Page, filename: string) {
	await page.screenshot({
		animations: "disabled",
		path: test.info().outputPath(filename),
	});
}

test("scheduling policy saves exact values, clamps safely, recovers from failure, and reloads", async ({
	page,
}) => {
	const workspaceName = "Scheduling QA";
	const workspaceResponse = await page.request.post("/__social/workspaces", {
		data: { name: workspaceName },
	});
	expect(workspaceResponse.ok()).toBe(true);
	const defaultWorkspace = socialWorkspaceProofSchema.parse(
		await workspaceResponse.json()
	);
	const before = await readSettings(page, "default");
	const localOffset = await page.evaluate(() => {
		const offset = new Date().getTimezoneOffset();
		// JSON transport serializes negative zero as zero on UTC devices.
		return offset === 0 ? 0 : -offset;
	});

	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	await page.getByRole("tab", { name: "Scheduling" }).click();
	await expect(page.getByRole("heading", { name: "Scheduling" })).toBeVisible();

	const schedulerSwitch = settingSwitch(page, "Run the scheduler");
	await expect(schedulerSwitch).toHaveAttribute("aria-checked", "true");
	await schedulerSwitch.click();
	await expect(schedulerSwitch).toHaveAttribute("aria-checked", "false");
	await page.getByLabel("Tick interval").fill("5");
	await page.getByLabel("Timezone").fill("Europe/London");

	const limitsSwitch = settingSwitch(page, "Enforce platform limits");
	await expect(limitsSwitch).toHaveAttribute("aria-checked", "true");
	await limitsSwitch.click();
	await expect(limitsSwitch).toHaveAttribute("aria-checked", "false");

	await page.getByLabel("Attempts").fill("15");
	await page.getByLabel("Base backoff").fill("90000");
	await page.getByLabel("Claim lease").fill("5");

	const inboxSwitch = settingSwitch(page, "Poll the inbox");
	await expect(inboxSwitch).toHaveAttribute("aria-checked", "true");
	await inboxSwitch.click();
	await expect(inboxSwitch).toHaveAttribute("aria-checked", "false");
	await page.getByLabel("Inbox poll interval").fill("30");
	await page.getByLabel("Engagement refresh interval").fill("100");
	await page.getByLabel("Engagement refresh batch").fill("250");

	const quietHoursSwitch = settingSwitch(page, "Observe quiet hours");
	await expect(quietHoursSwitch).toHaveAttribute("aria-checked", "false");
	await quietHoursSwitch.click();
	await expect(quietHoursSwitch).toHaveAttribute("aria-checked", "true");
	await page.getByLabel("From").fill("22");
	await page.getByLabel("Until").fill("22");
	await expect(
		page.getByText(
			"From and Until are equal, which means an EMPTY window — not a full day. Nothing will be quieted."
		)
	).toBeVisible();
	await page.getByLabel("Until").fill("7");
	await expect(
		page.getByText(
			"From and Until are equal, which means an EMPTY window — not a full day. Nothing will be quieted."
		)
	).toBeHidden();

	const utcOffset = page.getByLabel("UTC offset");
	await utcOffset.fill("-480");
	await expect(utcOffset).toHaveValue("-480");
	await page.getByRole("button", { name: /Use this device/ }).click();
	await expect(utcOffset).toHaveValue(String(localOffset));

	await page.getByLabel("Default workspace").selectOption(defaultWorkspace.id);
	const platforms = [
		{ key: "x", label: "X" },
		{ key: "instagram", label: "Instagram" },
		{ key: "tiktok", label: "TikTok" },
		{ key: "youtube", label: "YouTube" },
		{ key: "linkedin", label: "LinkedIn" },
		{ key: "reddit", label: "Reddit" },
		{ key: "facebook", label: "Facebook" },
		{ key: "bluesky", label: "Bluesky" },
		{ key: "threads", label: "Threads" },
	];
	for (const platform of platforms) {
		const toggle = page.getByRole("button", {
			name: platform.label,
			exact: true,
		});
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		if (platform.key === "tiktok") {
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-pressed", "false");
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-pressed", "true");
		}
	}

	const expectedPatch = {
		base_backoff_ms: 90_000,
		claim_lease_secs: 5,
		enforce_platform_limits: false,
		max_attempts: 15,
		node: {
			default_platforms: platforms.map((platform) => platform.key),
			default_workspace_id: defaultWorkspace.id,
			engagement_refresh_batch: 250,
			engagement_refresh_interval_secs: 100,
			inbox_poll_interval_secs: 30,
			inbox_polling_enabled: false,
			quiet_hours_enabled: true,
			quiet_hours_end: 7,
			quiet_hours_start: 22,
			utc_offset_minutes: localOffset,
		},
		poll_interval_secs: 5,
		scheduler_enabled: false,
		timezone: "Europe/London",
		workspace_id: "default",
	};

	const armFailure = await page.request.post(
		"/__proof/fail-next-settings-patch"
	);
	expect(armFailure.ok()).toBe(true);
	const saveButton = page.getByRole("button", {
		name: "Save changes",
		exact: true,
	});
	await saveButton.click();
	const errorToast = page.getByRole("alert");
	await expect(errorToast).toContainText("Could not save the settings");
	await expect(errorToast).toContainText(
		"Fixture rejected the first settings write."
	);
	await expect
		.poll(async () => (await readSettings(page, "default")).settings)
		.toEqual(before.settings);
	await expect
		.poll(async () => (await readSettings(page, "default")).node)
		.toEqual(before.node);

	await saveButton.click();
	await expect(page.getByRole("status")).toContainText("Settings saved");
	await expect(page.getByLabel("Tick interval")).toHaveValue("10");
	await expect(page.getByLabel("Attempts")).toHaveValue("10");
	await expect(page.getByLabel("Base backoff")).toHaveValue("60000");
	await expect(page.getByLabel("Claim lease")).toHaveValue("60");
	await expect(page.getByLabel("Inbox poll interval")).toHaveValue("60");
	await expect(page.getByLabel("Engagement refresh interval")).toHaveValue(
		"300"
	);
	await expect(page.getByLabel("Engagement refresh batch")).toHaveValue("200");

	const calls = await page.evaluate(
		() => window.__socialSchedulingSettingsProof?.calls ?? []
	);
	const patches = calls.filter(
		(call) => call.method === "PATCH" && call.path === "/settings"
	);
	expect(patches).toHaveLength(2);
	expect(patches.map((call) => call.body)).toEqual([
		expectedPatch,
		expectedPatch,
	]);

	const expectedSettings = {
		...before.settings,
		scheduler_enabled: false,
		poll_interval_secs: 10,
		max_attempts: 10,
		base_backoff_ms: 60_000,
		claim_lease_secs: 60,
		timezone: "Europe/London",
		enforce_platform_limits: false,
	};
	const expectedNode = {
		...before.node,
		default_platforms: platforms.map((platform) => platform.key),
		default_workspace_id: defaultWorkspace.id,
		engagement_refresh_batch: 200,
		engagement_refresh_interval_secs: 300,
		inbox_poll_interval_secs: 60,
		inbox_polling_enabled: false,
		quiet_hours: { enabled: true, end_hour: 7, start_hour: 22 },
		utc_offset_minutes: localOffset,
	};
	const saved = await readSettings(page, "default");
	expect(saved).toEqual({ settings: expectedSettings, node: expectedNode });

	await page.reload();
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	await page.getByRole("tab", { name: "Scheduling" }).click();
	await expect(page.getByLabel("Tick interval")).toHaveValue("10");
	await expect(page.getByLabel("Timezone")).toHaveValue("Europe/London");
	await expect(page.getByLabel("Attempts")).toHaveValue("10");
	await expect(page.getByLabel("Base backoff")).toHaveValue("60000");
	await expect(page.getByLabel("Claim lease")).toHaveValue("60");
	await expect(page.getByLabel("Inbox poll interval")).toHaveValue("60");
	await expect(page.getByLabel("Engagement refresh interval")).toHaveValue(
		"300"
	);
	await expect(page.getByLabel("Engagement refresh batch")).toHaveValue("200");
	await expect(settingSwitch(page, "Run the scheduler")).toHaveAttribute(
		"aria-checked",
		"false"
	);
	await expect(settingSwitch(page, "Enforce platform limits")).toHaveAttribute(
		"aria-checked",
		"false"
	);
	await expect(settingSwitch(page, "Poll the inbox")).toHaveAttribute(
		"aria-checked",
		"false"
	);
	await expect(settingSwitch(page, "Observe quiet hours")).toHaveAttribute(
		"aria-checked",
		"true"
	);
	await expect(page.getByLabel("From")).toHaveValue("22");
	await expect(page.getByLabel("Until")).toHaveValue("7");
	await expect(page.getByLabel("UTC offset")).toHaveValue(String(localOffset));
	await expect(page.getByLabel("Default workspace")).toHaveValue(
		defaultWorkspace.id
	);
	for (const platform of platforms) {
		await expect(
			page.getByRole("button", { name: platform.label, exact: true })
		).toHaveAttribute("aria-pressed", "true");
	}
	await saveScreenshot(page, "social-scheduling-settings-saved-top.png");

	await page.getByLabel("Default workspace").scrollIntoViewIfNeeded();
	await expect(
		page.getByText("Default platforms", { exact: true })
	).toBeVisible();
	await saveScreenshot(page, "social-scheduling-settings-saved-defaults.png");
});
