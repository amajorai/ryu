import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	installSyncApiMock,
	REMOTE_UPDATED_AT,
	seedSettingsState,
} from "./settings-sync-proof.fixture.ts";

const STORY_URL = "/settings-sync-proof.html";
// Verification runs set RYU_PROOF_OUTPUT_ROOT so screenshots land in scratch
// space instead of rewriting the tracked sweep evidence.
const evidence = (name: string) =>
	process.env.RYU_PROOF_OUTPUT_ROOT
		? path.resolve(process.env.RYU_PROOF_OUTPUT_ROOT, name)
		: path.resolve(
				process.cwd(),
				"../../docs/proof/test-coverage-sweep-20260924/evidence",
				name
			);
const CONFLICT_SCREENSHOT = evidence("desktop-settings-sync-conflicts.png");
const DELETE_CONFIRMATION_SCREENSHOT = evidence(
	"desktop-settings-sync-delete-confirmation.png"
);

test("Settings Sync opt-in, policies, manual sync, and offline feedback work", async ({
	page,
}) => {
	const mock = await installSyncApiMock(page);
	await seedSettingsState(page, { pending: true });
	await page.goto(STORY_URL);

	const enabled = page.getByRole("switch");
	const syncNow = page.getByRole("button", { name: "Sync now" });
	// 99500215a7 dropped the section title that repeated the pane title
	// ("Settings Sync"); the opt-in row is now the tab's first content.
	await expect(
		page.getByText("Sync My Settings Across Machines", { exact: true })
	).toBeVisible();
	await expect(enabled).toHaveAttribute("aria-checked", "false");
	await expect(page.getByText("Off", { exact: true })).toBeVisible();
	await expect(syncNow).toBeDisabled();
	// 1ca1de7ee8 shortened the exclusion note to one line.
	await expect(
		page.getByText(
			"Never includes node config, API keys, folders or device picks."
		)
	).toBeVisible();

	await enabled.click();
	await expect(enabled).toHaveAttribute("aria-checked", "true");
	await expect(syncNow).toBeEnabled();
	await expect(page.getByText("Up to date", { exact: true })).toBeVisible();
	await expect.poll(() => mock.pullCalls).toBeGreaterThanOrEqual(1);
	await expect.poll(() => mock.pushRequests.length).toBe(1);
	// SAFETY: The mounted SettingsSync proof runs the real engine collectDirty and pushSettings JSON serializer: string keys, native string/null values, boolean deleted, and timestamps from this spec's finite seeds or Date.now. This observation decodes that captured POST after the request-count assertion; forged requests or foreign nonfinite metadata are outside this controlled fixture.
	const optInPush = JSON.parse(mock.pushBodies[0] ?? "{}") as {
		entries: {
			deleted: boolean;
			key: string;
			updatedAt: number;
			value: string | null;
		}[];
	};
	const firstPushRequest = mock.pushRequests[0];
	expect(firstPushRequest).toMatchObject({
		authorization: "Bearer settings-sync-fixture-token",
		method: "POST",
	});
	expect(new URL(firstPushRequest?.url ?? page.url()).pathname).toBe(
		"/api/desktop-settings-sync/push"
	);
	expect(optInPush).toEqual({
		entries: [
			{ deleted: false, key: "theme", updatedAt: 10, value: "dark" },
			{ deleted: false, key: "ryu_ui_font", updatedAt: 11, value: "Inter" },
		],
	});
	expect(mock.pushBodies[0]).not.toContain("settings-sync-fixture-token");
	expect(mock.pushBodies[0]).not.toContain("/private/workspace");
	expect(mock.pushBodies[0]).not.toContain("fixture-node-settings");

	const conflictPolicy = page.getByRole("combobox");
	for (const [label, value] of [
		["Ask me every time", "ask"],
		["Always use the newer cloud copy", "download"],
		["Always keep this machine's copy", "upload"],
	] as const) {
		await conflictPolicy.click();
		await page.getByRole("option", { name: label, exact: true }).click();
		await expect
			.poll(() =>
				page.evaluate(() => localStorage.getItem("ryu:settings-sync-policy"))
			)
			.toBe(value);
	}

	mock.delayNextPull(300);
	const pullsBeforeManualSync = mock.pullCalls;
	await syncNow.click();
	await expect(syncNow).toBeDisabled();
	await expect
		.poll(() => mock.pullCalls)
		.toBeGreaterThan(pullsBeforeManualSync);
	await expect(
		page.getByText("Settings synced", { exact: true })
	).toBeVisible();
	await expect(syncNow).toBeEnabled();

	mock.failNextPull();
	await syncNow.click();
	await expect(
		page.getByText("Sync incomplete", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Couldn't sync settings", { exact: true })
	).toBeVisible();
	const pullsAfterFailure = mock.pullCalls;
	await syncNow.click();
	await expect.poll(() => mock.pullCalls).toBeGreaterThan(pullsAfterFailure);
	await expect(page.getByText("Up to date", { exact: true })).toBeVisible();

	await page.evaluate(() => localStorage.setItem("theme", "light"));
	await expect(page.getByText(/1 change waiting to upload/u)).toBeVisible();
	mock.failNextPush();
	await syncNow.click();
	await expect(
		page.getByText("Sync incomplete", { exact: true })
	).toBeVisible();
	await expect(page.getByText(/1 change waiting to upload/u)).toBeVisible();
	await expect.poll(() => mock.pushRequests.length).toBe(2);
	// SAFETY: The mounted SettingsSync proof runs the real engine collectDirty and pushSettings JSON serializer: string keys, native string/null values, boolean deleted, and timestamps from this spec's finite seeds or Date.now. This observation decodes that captured POST after the request-count assertion; forged requests or foreign nonfinite metadata are outside this controlled fixture.
	const failedPush = JSON.parse(mock.pushBodies[1] ?? "{}") as {
		entries: {
			deleted: boolean;
			key: string;
			updatedAt: number;
			value: string | null;
		}[];
	};
	expect(failedPush.entries).toHaveLength(1);
	expect(failedPush.entries[0]).toMatchObject({
		deleted: false,
		key: "theme",
		value: "light",
	});
	expect(failedPush.entries[0]?.updatedAt).toBeGreaterThan(0);

	await syncNow.click();
	await expect.poll(() => mock.pushRequests.length).toBe(3);
	await expect(page.getByText("Up to date", { exact: true })).toBeVisible();
	// SAFETY: The mounted SettingsSync proof runs the real engine collectDirty and pushSettings JSON serializer: string keys, native string/null values, boolean deleted, and timestamps from this spec's finite seeds or Date.now. This observation decodes that captured POST after the request-count assertion; forged requests or foreign nonfinite metadata are outside this controlled fixture.
	const retriedPush = JSON.parse(mock.pushBodies[2] ?? "{}") as {
		entries: {
			deleted: boolean;
			key: string;
			updatedAt: number;
			value: string | null;
		}[];
	};
	expect(retriedPush.entries).toHaveLength(1);
	expect(retriedPush.entries[0]).toMatchObject({
		deleted: false,
		key: "theme",
		value: "light",
	});
	expect(retriedPush.entries[0]?.updatedAt).toBeGreaterThan(0);

	await enabled.click();
	await expect(enabled).toHaveAttribute("aria-checked", "false");
	await expect(syncNow).toBeDisabled();
	await expect(page.getByText("Off", { exact: true })).toBeVisible();
});

test("deleting the cloud copy reports success or failure and keeps local settings", async ({
	page,
}) => {
	const mock = await installSyncApiMock(page);
	await seedSettingsState(page);
	await page.goto(STORY_URL);

	const deleteCopy = page
		.locator("#root")
		.getByRole("button", { name: "Delete cloud copy" });
	await deleteCopy.click();
	const confirmation = page.getByRole("alertdialog");
	await expect(
		confirmation.getByRole("heading", { name: "Delete your cloud settings?" })
	).toBeVisible();
	await expect(
		confirmation.getByText(
			/permanently removes the synced copy.*cannot be undone/u
		)
	).toBeVisible();
	await page.screenshot({
		path: DELETE_CONFIRMATION_SCREENSHOT,
		fullPage: true,
	});
	await expect.poll(() => mock.deleteCalls).toBe(0);
	await confirmation.getByRole("button", { name: "Cancel" }).click();
	await expect(confirmation).not.toBeVisible();
	await expect.poll(() => mock.deleteCalls).toBe(0);

	await deleteCopy.click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete cloud copy" })
		.click();
	await expect(
		page.getByText("Cloud copy deleted", { exact: true })
	).toBeVisible();
	await expect.poll(() => mock.deleteCalls).toBe(1);
	const deleteRequest = mock.deleteRequests[0];
	expect(deleteRequest).toMatchObject({
		authorization: "Bearer settings-sync-fixture-token",
		method: "DELETE",
	});
	expect(new URL(deleteRequest?.url ?? page.url()).pathname).toBe(
		"/api/desktop-settings-sync"
	);
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("theme")))
		.toBe("dark");

	mock.failNextDelete();
	await deleteCopy.click();
	const retryConfirmation = page.getByRole("alertdialog");
	await retryConfirmation
		.getByRole("button", { name: "Delete cloud copy" })
		.click();
	await expect(
		page.getByText("Couldn't delete the cloud copy", { exact: true })
	).toBeVisible();
	await expect.poll(() => mock.deleteCalls).toBe(2);
	await expect(retryConfirmation).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("theme")))
		.toBe("dark");
	await retryConfirmation
		.getByRole("button", { name: "Delete cloud copy" })
		.click();
	await expect.poll(() => mock.deleteCalls).toBe(3);
	await expect(
		page.getByText("Cloud copy deleted", { exact: true })
	).toBeVisible();
	await expect(retryConfirmation).not.toBeVisible();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("theme")))
		.toBe("dark");
});

test("per-setting and bulk conflict actions apply the selected copy", async ({
	page,
}) => {
	const mock = await installSyncApiMock(page);
	await seedSettingsState(page, { enabled: true, conflict: true });
	await page.goto(`${STORY_URL}?scenario=conflict`);

	await expect(
		page.getByRole("heading", { name: "2 settings need a decision" })
	).toBeVisible();
	await expect(page.getByText("local-night", { exact: true })).toBeVisible();
	await expect(page.getByText("cloud-night", { exact: true })).toBeVisible();
	await expect(page.getByText(/changes? waiting to upload/u)).toHaveCount(0);
	await page.screenshot({ path: CONFLICT_SCREENSHOT, fullPage: true });
	await expect.poll(() => mock.pushRequests.length).toBe(0);
	await page.getByRole("button", { name: "Sync now" }).click();
	await expect(
		page.getByText("Settings need your decision", { exact: true })
	).toBeVisible();
	expect(mock.pushRequests).toHaveLength(0);

	await page
		.getByRole("button", { name: "Keep this", exact: true })
		.first()
		.click();
	await expect.poll(() => mock.pushRequests.length).toBe(1);
	// SAFETY: The mounted SettingsSync proof runs the real engine collectDirty and pushSettings JSON serializer: string keys, native string/null values, boolean deleted, and timestamps from this spec's finite seeds or Date.now. This observation decodes that captured POST after the request-count assertion; forged requests or foreign nonfinite metadata are outside this controlled fixture.
	const oneConflictPush = JSON.parse(mock.pushBodies[0] ?? "{}") as {
		entries: { key: string; updatedAt: number; value: string | null }[];
	};
	expect(oneConflictPush.entries).toEqual([
		expect.objectContaining({ key: "theme", value: "dark" }),
	]);
	expect(oneConflictPush.entries[0]?.updatedAt).toBeGreaterThan(
		REMOTE_UPDATED_AT
	);
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("theme")))
		.toBe("dark");
	await expect(
		page.getByRole("heading", { name: "1 setting needs a decision" })
	).toBeVisible();
	await page.getByRole("button", { name: "Use cloud", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_dark_preset")))
		.toBe("cloud-night");
	await expect(
		page.getByRole("button", { name: "Keep this", exact: true })
	).toHaveCount(0);
	expect(mock.pushRequests).toHaveLength(1);

	for (const [label, expectedTheme, expectedPreset] of [
		["Use cloud for all", "light", "cloud-night"],
		["Keep this machine", "dark", "local-night"],
	] as const) {
		mock.resetConflicts();
		await seedSettingsState(page, { enabled: true, conflict: true });
		await page.goto(`${STORY_URL}?scenario=conflict`);
		await expect(
			page.getByRole("heading", { name: "2 settings need a decision" })
		).toBeVisible();
		await page.getByRole("button", { name: label, exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Use cloud", exact: true })
		).toHaveCount(0);
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("theme")))
			.toBe(expectedTheme);
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("ryu_dark_preset")))
			.toBe(expectedPreset);
		if (label === "Use cloud for all") {
			expect(mock.pushRequests).toHaveLength(1);
		} else {
			await expect.poll(() => mock.pushRequests.length).toBe(2);
			// SAFETY: The mounted SettingsSync proof runs the real engine collectDirty and pushSettings JSON serializer: string keys, native string/null values, boolean deleted, and timestamps from this spec's finite seeds or Date.now. This observation decodes that captured POST after the request-count assertion; forged requests or foreign nonfinite metadata are outside this controlled fixture.
			const keepAllPush = JSON.parse(mock.pushBodies[1] ?? "{}") as {
				entries: {
					key: string;
					updatedAt: number;
					value: string | null;
				}[];
			};
			expect(
				keepAllPush.entries.map(({ key, value }) => ({ key, value }))
			).toEqual([
				{ key: "theme", value: "dark" },
				{ key: "ryu_dark_preset", value: "local-night" },
			]);
			for (const entry of keepAllPush.entries) {
				expect(entry.updatedAt).toBeGreaterThan(REMOTE_UPDATED_AT);
			}
		}
	}
});
