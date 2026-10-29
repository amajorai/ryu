import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	chatControlNativeNetworkLedger,
	installChatControlNativeNetwork,
} from "./chat-control-native-network.ts";

const proof = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-shell-flows/window-tray"
);
test.setTimeout(120_000);
// Preserve all real uncaught errors and exact shared-fixture bootstrap requests.
const pageErrorsByPage = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
	await installChatControlNativeNetwork(page);
	const errors: string[] = [];
	pageErrorsByPage.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
});
test.afterEach(async ({ page }, testInfo) => {
	const state = await page.evaluate(() => {
		const fixture = window.__shareToolbarFixture;
		const readBackground = Reflect.get(window, "__chatControlBackground");
		return {
			mounted: Boolean(fixture),
			nativeSnapshot: fixture?.nativeSnapshot(),
			nativeDiagnostics: fixture?.nativeDiagnostics(),
			unexpectedRequests: fixture?.unexpectedRequests ?? [],
			featureCalls: fixture?.calls ?? [],
			background:
				typeof readBackground === "function" ? readBackground() : null,
		};
	});
	const errors = pageErrorsByPage.get(page) ?? [];
	const ledgerPath = testInfo.outputPath(
		"window-tray-bootstrap-native-http-page-errors.json"
	);
	await writeFile(
		ledgerPath,
		JSON.stringify(
			{
				...state,
				pageErrors: errors,
				actualNetwork: chatControlNativeNetworkLedger(page),
			},
			null,
			2
		),
		"utf8"
	);
	await testInfo.attach("window-tray-bootstrap-native-http-page-errors", {
		path: ledgerPath,
		contentType: "application/json",
	});
	expect(errors, "Shipping Layout must not throw uncaught errors").toEqual([]);
	expect(chatControlNativeNetworkLedger(page).unexpected).toEqual([]);
	expect(
		state.unexpectedRequests,
		"Unregistered bootstrap API requests must not be accepted"
	).toEqual([]);
});

test("actual Layout sidebar, search dismissal and DownloadCenter tray keyboard navigation", async ({
	page,
}) => {
	await page.goto(
		"/share-conversation-toolbar-entry.html?scenario=window-tray"
	);
	const navigation = page.getByTestId("window-navigation-cluster");
	await expect(navigation).toBeVisible();
	await navigation.getByRole("button", { name: "Search", exact: true }).click();
	await expect(
		page.getByPlaceholder("Search everything or run a command…")
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		page.getByPlaceholder("Search everything or run a command…")
	).toBeHidden();
	const closed = navigation.getByRole("button", {
		name: "Open navigation",
		exact: true,
	});
	if (await closed.isVisible()) {
		await closed.click();
	}
	await expect(
		navigation.getByRole("button", { name: "Close navigation", exact: true })
	).toBeVisible();
	const downloads = page.getByRole("button", {
		name: "Downloads",
		exact: true,
	});
	await expect(downloads).toBeVisible();
	await downloads.focus();
	await page.keyboard.press("Enter");
	const tray = page.getByRole("dialog", { name: "Downloads", exact: true });
	await expect(tray).toBeVisible();
	await expect(tray).toBeFocused();
	await expect(downloads).toHaveAttribute("aria-expanded", "true");
	await expect(downloads).toHaveAttribute("aria-haspopup", "dialog");
	await expect(
		tray.getByText("Nothing downloading", { exact: true })
	).toBeVisible();
	await page.screenshot({
		path: path.join(proof, "desktop-downloads-tray.png"),
	});
	await page.keyboard.press("Escape");
	await expect(downloads).toBeFocused();
	await expect(downloads).toHaveAttribute("aria-expanded", "false");
	await expect(tray).toBeHidden();
	await page.keyboard.press("Enter");
	await tray
		.getByRole("button", { name: "Open downloads", exact: true })
		.click();
	await expect(tray).toBeHidden();
	await expect(page.getByRole("tab", { name: /Downloads/ })).toBeVisible();
	await expect(
		navigation.getByRole("button", { name: "Go back", exact: true })
	).toBeEnabled();
	await navigation
		.getByRole("button", { name: "Go back", exact: true })
		.click();
	await expect(
		navigation.getByRole("button", { name: "Go forward", exact: true })
	).toBeEnabled();
	await navigation
		.getByRole("button", { name: "Go forward", exact: true })
		.click();
	await page.screenshot({
		path: path.join(proof, "desktop-downloads-navigation.png"),
	});
});
