import { expect, type Page, test } from "@playwright/test";

const STORY_URL = "/clips-quick-attach-settings-proof.html";

interface NativeCall {
	args?: { enabled?: boolean; url?: string };
	command: string;
}

async function openSettings(
	page: Page,
	query = "",
	platform: "macOS" | "Windows" = "macOS"
) {
	const userAgent =
		platform === "macOS"
			? "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36"
			: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
	await page.addInitScript((nextUserAgent) => {
		Object.defineProperty(navigator, "userAgent", {
			configurable: true,
			get: () => nextUserAgent,
		});
	}, userAgent);
	await page.goto(`${STORY_URL}${query}`);
	await expect(
		page.getByRole("heading", {
			name: "Clips quick attach",
			exact: true,
			level: 1,
		})
	).toBeVisible();
}

test("Input Monitoring prompt and OS settings handoff update the supported switch", async ({
	page,
}) => {
	await openSettings(page);

	const attachSwitch = page.getByRole("switch", {
		name: "Attach recent activity to a chat",
	});
	await expect(attachSwitch).toBeVisible();
	await expect(attachSwitch).not.toBeChecked();
	await expect(
		page.getByRole("button", { name: "Grant", exact: true })
	).toBeVisible();

	await attachSwitch.click();
	await expect(attachSwitch).not.toBeChecked();
	await expect(
		page.getByText("Grant Input Monitoring to Ryu, then try again.", {
			exact: true,
		})
	).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(() =>
				/* SAFETY: clips-quick-attach-settings-proof.tsx installs __clipsQuickAttachCalls before this proof page is evaluated. */ (
					Reflect.get(window, "__clipsQuickAttachCalls") as NativeCall[]
				).some(
					(call) =>
						call.command === "clips_quick_attach_set_enabled" &&
						call.args?.enabled === true
				)
			)
		)
		.toBe(true);

	await page.getByRole("button", { name: "Grant", exact: true }).click();
	await expect(page.getByText("Granted", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Grant", exact: true })
	).toHaveCount(0);
	await expect
		.poll(() =>
			page.evaluate(() =>
				/* SAFETY: clips-quick-attach-settings-proof.tsx installs __clipsQuickAttachCalls before this proof page is evaluated. */ (
					Reflect.get(window, "__clipsQuickAttachCalls") as NativeCall[]
				)
					.filter((call) =>
						[
							"clips_quick_attach_set_enabled",
							"request_input_monitoring_permission",
							"open_privacy_settings",
							"clips_quick_attach_status",
						].includes(call.command)
					)
					.map((call) => ({ command: call.command, args: call.args }))
			)
		)
		.toEqual([
			{ command: "clips_quick_attach_status", args: {} },
			{ command: "clips_quick_attach_set_enabled", args: { enabled: true } },
			{ command: "clips_quick_attach_status", args: {} },
			{ command: "request_input_monitoring_permission", args: {} },
			{
				command: "open_privacy_settings",
				args: { capability: "inputMonitoring" },
			},
			{ command: "clips_quick_attach_status", args: {} },
		]);
});

test("failed enable remains off and a successful retry reads back the new state", async ({
	page,
}) => {
	await openSettings(page, "?scenario=retry&permission=granted");

	const attachSwitch = page.getByRole("switch", {
		name: "Attach recent activity to a chat",
	});
	await attachSwitch.click();
	await expect(attachSwitch).not.toBeChecked();
	await expect(
		page.getByText("Native listener could not start", { exact: true })
	).toBeVisible();

	await attachSwitch.click();
	await expect(attachSwitch).toBeChecked();
	await attachSwitch.click();
	await expect(attachSwitch).not.toBeChecked();

	await expect
		.poll(() =>
			page.evaluate(() =>
				/* SAFETY: clips-quick-attach-settings-proof.tsx installs __clipsQuickAttachCalls before this proof page is evaluated. */ (
					Reflect.get(window, "__clipsQuickAttachCalls") as NativeCall[]
				).filter((call) => call.command === "clips_quick_attach_set_enabled")
			)
		)
		.toEqual([
			{ command: "clips_quick_attach_set_enabled", args: { enabled: true } },
			{ command: "clips_quick_attach_set_enabled", args: { enabled: true } },
			{ command: "clips_quick_attach_set_enabled", args: { enabled: false } },
		]);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: clips-quick-attach-settings-proof.tsx installs __clipsQuickAttachCalls before this proof page is evaluated. */ (
						Reflect.get(window, "__clipsQuickAttachCalls") as NativeCall[]
					).length
			)
		)
		.toBeGreaterThan(3);
	await expect(attachSwitch).not.toBeChecked();
});

test("granted Input Monitoring enables quick attach and reads the saved switch state", async ({
	page,
}) => {
	await openSettings(page, "?permission=granted");

	const attachSwitch = page.getByRole("switch", {
		name: "Attach recent activity to a chat",
	});
	await expect(page.getByText("Granted", { exact: true })).toBeVisible();
	await attachSwitch.click();
	await expect(attachSwitch).toBeChecked();
	await expect
		.poll(() =>
			page.evaluate(() =>
				/* SAFETY: clips-quick-attach-settings-proof.tsx installs __clipsQuickAttachCalls before this proof page is evaluated. */ (
					Reflect.get(window, "__clipsQuickAttachCalls") as NativeCall[]
				).filter((call) => call.command === "clips_quick_attach_set_enabled")
			)
		)
		.toEqual([
			{ command: "clips_quick_attach_set_enabled", args: { enabled: true } },
		]);
	// Verification runs set RYU_PROOF_OUTPUT_ROOT so the screenshot lands in
	// scratch space instead of the checkout.
	await page.screenshot({
		fullPage: true,
		path: process.env.RYU_PROOF_OUTPUT_ROOT
			? `${process.env.RYU_PROOF_OUTPUT_ROOT}/clips-quick-attach-settings-granted.png`
			: "e2e/artifacts/clips-quick-attach-settings-granted.png",
	});

	await attachSwitch.click();
	await expect(attachSwitch).not.toBeChecked();
	await expect
		.poll(() =>
			page.evaluate(() =>
				/* SAFETY: clips-quick-attach-settings-proof.tsx installs __clipsQuickAttachCalls before this proof page is evaluated. */ (
					Reflect.get(window, "__clipsQuickAttachCalls") as NativeCall[]
				).filter((call) => call.command === "clips_quick_attach_set_enabled")
			)
		)
		.toEqual([
			{ command: "clips_quick_attach_set_enabled", args: { enabled: true } },
			{ command: "clips_quick_attach_set_enabled", args: { enabled: false } },
		]);
});

test("unsupported platforms explain the limit and keep the switch disabled", async ({
	page,
}) => {
	await openSettings(page, "?scenario=unsupported");

	const attachSwitch = page.getByRole("switch", {
		name: "Attach recent activity to a chat",
	});
	await expect(
		page.getByText("Clips quick attach is supported on macOS and Windows.")
	).toBeVisible();
	await expect(attachSwitch).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Grant", exact: true })
	).toHaveCount(0);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: clips-quick-attach-settings-proof.tsx installs __clipsQuickAttachCalls before this proof page is evaluated. */ (
						Reflect.get(window, "__clipsQuickAttachCalls") as NativeCall[]
					).filter((call) => call.command === "clips_quick_attach_set_enabled")
						.length
			)
		)
		.toBe(0);
});

test("Windows uses the Alt gesture without showing macOS permission controls", async ({
	page,
}) => {
	await openSettings(page, "", "Windows");

	await expect(
		page.getByText(/Press Alt twice to attach recent activity/)
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Grant", exact: true })
	).toHaveCount(0);

	const attachSwitch = page.getByRole("switch", {
		name: "Attach recent activity to a chat",
	});
	await attachSwitch.click();
	await expect(attachSwitch).toBeChecked();
	await expect
		.poll(() =>
			page.evaluate(() =>
				/* SAFETY: clips-quick-attach-settings-proof.tsx installs __clipsQuickAttachCalls before this proof page is evaluated. */ (
					Reflect.get(window, "__clipsQuickAttachCalls") as NativeCall[]
				).filter((call) => call.command === "clips_quick_attach_set_enabled")
			)
		)
		.toEqual([
			{ command: "clips_quick_attach_set_enabled", args: { enabled: true } },
		]);
});

test("destination choices send their native value and read back after reload", async ({
	page,
}) => {
	await openSettings(page, "?permission=granted");
	const destination = page.getByRole("combobox", { name: "Clips destination" });
	await expect(destination.locator('[data-slot="select-value"]')).toHaveText(
		"Automatic"
	);
	for (const [label, value] of [
		["Current chat", "current_chat"],
		["New chat", "new_chat"],
		["Automatic", "automatic"],
	] as const) {
		await destination.click();
		await page.getByRole("option", { name: new RegExp(`^${label}`) }).click();
		await expect(destination.locator('[data-slot="select-value"]')).toHaveText(
			label
		);
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						(Reflect.get(window, "__clipsQuickAttachCalls") as NativeCall[])
							.filter(
								(call) => call.command === "clips_quick_attach_set_destination"
							)
							.at(-1)?.args
				)
			)
			.toEqual({ destination: value });
		await page.reload();
		await expect(destination.locator('[data-slot="select-value"]')).toHaveText(
			label
		);
		await expect(
			page.getByRole("switch", { name: "Attach recent activity to a chat" })
		).not.toBeChecked();
	}
});

test("a refused destination keeps the previous choice and allows retry", async ({
	page,
}) => {
	await openSettings(page, "?permission=granted&scenario=destination-retry");
	const destination = page.getByRole("combobox", { name: "Clips destination" });
	await destination.click();
	await page.getByRole("option", { name: /^New chat/ }).click();
	await expect(
		page.getByText("Destination could not be saved", { exact: true })
	).toBeVisible();
	await expect(destination.locator('[data-slot="select-value"]')).toHaveText(
		"Automatic"
	);
	await destination.click();
	await page.getByRole("option", { name: /^New chat/ }).click();
	await expect(destination.locator('[data-slot="select-value"]')).toHaveText(
		"New chat"
	);
	await expect
		.poll(() =>
			page.evaluate(() =>
				(Reflect.get(window, "__clipsQuickAttachCalls") as NativeCall[]).filter(
					(call) => call.command === "clips_quick_attach_set_destination"
				)
			)
		)
		.toEqual([
			{
				command: "clips_quick_attach_set_destination",
				args: { destination: "new_chat" },
			},
			{
				command: "clips_quick_attach_set_destination",
				args: { destination: "new_chat" },
			},
		]);
	await page.reload();
	await expect(destination.locator('[data-slot="select-value"]')).toHaveText(
		"New chat"
	);
});
