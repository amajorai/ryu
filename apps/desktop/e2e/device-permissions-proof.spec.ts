import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

// The device-permissions proof installs this frame-local API before mounting the
// settings component; every scenario below loads that native fixture entry.
declare global {
	interface Window {
		permissionFixture: {
			calls: string[];
			setGranted(value: boolean): void;
			readonly stopped: number;
		};
	}
}

const proof = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/os-permissions-20261002"
);
test.beforeAll(async () => {
	await mkdir(proof, { recursive: true });
});
test("macOS denial, fixed settings links, and microphone retry", async ({
	page,
}) => {
	await page.goto("/device-permissions-proof.html?platform=macos");
	await expect(
		page.getByRole("button", { name: "Request Screen Recording", exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Request Screen Recording", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Request Screen Recording", exact: true })
	).toBeEnabled();
	await page
		.getByRole("button", {
			name: "Open Screen Recording settings",
			exact: true,
		})
		.click();
	await page
		.getByRole("button", { name: "Enable microphone", exact: true })
		.click();
	await expect(
		page.getByText("Microphone access is blocked.", { exact: false })
	).toBeVisible();
	await page.screenshot({
		path: path.join(proof, "macos-denial-browser-fixture.png"),
		fullPage: true,
	});
	await page
		.getByRole("button", { name: "Open settings", exact: true })
		.click();
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(
		page.getByText("Microphone enabled.", { exact: true })
	).toBeVisible();
	const fixture = await page.evaluate(() => window.permissionFixture);
	expect(fixture.calls).toContain("open_privacy_settings:screenRecording");
	expect(fixture.calls).toContain("open_privacy_settings:microphone");
	expect(fixture.stopped).toBe(1);
	await page.screenshot({
		path: path.join(proof, "macos-retry-browser-fixture.png"),
		fullPage: true,
	});
});
test("returning from OS settings refreshes native access status", async ({
	page,
}) => {
	await page.goto("/device-permissions-proof.html?platform=macos");
	await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(3);
	await page.evaluate(() => {
		window.permissionFixture.setGranted(true);
		window.dispatchEvent(new Event("focus"));
	});
	await expect(page.getByText("Granted", { exact: true })).toHaveCount(3);
	await expect(page.getByRole("button", { name: /^Request / })).toHaveCount(0);
});

test("Windows and Linux expose their distinct setup states", async ({
	page,
}) => {
	await page.goto("/device-permissions-proof.html?platform=windows");
	await expect(page.getByText("No OS prompt required")).toHaveCount(3);
	await expect(page.getByRole("button", { name: /^Request / })).toHaveCount(0);
	await page.getByRole("button", { name: "Enable microphone" }).click();
	await page
		.getByRole("button", { name: "Open settings", exact: true })
		.click();
	await page.screenshot({
		path: path.join(proof, "windows-browser-fixture.png"),
		fullPage: true,
	});
	await page.goto("/device-permissions-proof.html?platform=linux");
	await expect(
		page.getByText("Native screen capture and global automation require X11.", {
			exact: false,
		})
	).toBeVisible();
	await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(3);
	await expect(page.getByRole("button", { name: /^Request / })).toHaveCount(0);
	await page.getByRole("button", { name: "Enable microphone" }).click();
	await expect(
		page.getByRole("button", { name: "Open settings", exact: true })
	).toHaveCount(0);
	await page.screenshot({
		path: path.join(proof, "linux-browser-fixture.png"),
		fullPage: true,
	});
});

interface DeviceNativeFixture {
	calls: string[];
	unexpected: string[];
	failNextSettings(): void;
}
async function deviceNative(page: import("@playwright/test").Page) {
	return page.evaluate(
		() => Reflect.get(window, "permissionFixture") as DeviceNativeFixture
	);
}
const nativeChecks = [
	"check_screen_recording_permission",
	"check_accessibility_permission",
	"check_input_monitoring_permission",
];

test("all three denied native request prompts perform the exact capability command and fresh access readback", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/device-permissions-proof.html?platform=macos");
	await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(3);
	expect((await deviceNative(page)).calls).toEqual(nativeChecks);
	for (const [label, command] of [
		["Screen Recording", "request_screen_recording_permission"],
		["Accessibility", "request_accessibility_permission"],
		["Input Monitoring", "request_input_monitoring_permission"],
	] as const) {
		const before = (await deviceNative(page)).calls.length;
		await page
			.getByRole("button", { name: `Request ${label}`, exact: true })
			.click();
		await expect
			.poll(async () => (await deviceNative(page)).calls.slice(before))
			.toEqual([command, ...nativeChecks]);
		await expect(
			page.getByRole("button", { name: `Request ${label}`, exact: true })
		).toBeEnabled();
		await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(3);
		await expect(page.getByText("Granted", { exact: true })).toHaveCount(0);
	}
	expect((await deviceNative(page)).unexpected).toEqual([]);
	expect(errors).toEqual([]);
});

test("each native privacy-settings refusal stays visible, retries the identical capability and refreshes without manufacturing a grant", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/device-permissions-proof.html?platform=macos");
	await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(3);
	for (const [label, capability] of [
		["Screen Recording", "screenRecording"],
		["Accessibility", "accessibility"],
		["Input Monitoring", "inputMonitoring"],
	] as const) {
		const before = (await deviceNative(page)).calls.length;
		await page.evaluate(() =>
			Reflect.get(window, "permissionFixture").failNextSettings()
		);
		const open = page.getByRole("button", {
			name: `Open ${label} settings`,
			exact: true,
		});
		await open.click();
		await expect(page.getByRole("alert")).toHaveText(
			"Couldn't open system settings. Open Privacy & Security manually."
		);
		await open.click();
		await expect
			.poll(async () => (await deviceNative(page)).calls.slice(before))
			.toEqual([
				`open_privacy_settings:${capability}`,
				`open_privacy_settings:${capability}`,
			]);
		await page
			.getByRole("button", { name: "Check access again", exact: true })
			.click();
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(3);
		expect((await deviceNative(page)).calls.slice(before)).toEqual([
			`open_privacy_settings:${capability}`,
			`open_privacy_settings:${capability}`,
			...nativeChecks,
		]);
	}
	expect((await deviceNative(page)).unexpected).toEqual([]);
	expect(errors).toEqual([]);
});
