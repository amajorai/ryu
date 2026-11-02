import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	chatControlNativeNetworkLedger,
	installChatControlNativeNetwork,
} from "./chat-control-native-network.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

const proof = proofEvidencePath(
	"test-coverage-sweep-20260924/parallel/desktop-shell-flows/window-tray"
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

async function openNavigation(page: Page) {
	const navigation = page.getByTestId("window-navigation-cluster");
	await expect(navigation).toBeVisible();
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
	return navigation;
}

// The title-bar tab strip renders each tab as a close button plus a title
// button (shell/title-bar/regular-tab.tsx); the page itself owns the heading.
async function expectDownloadsTabOpen(page: Page) {
	await expect(
		page.getByRole("button", { name: "Close Downloads", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Downloads", level: 1 })
	).toBeVisible();
}

// TrayMorph keeps the panel mounted so the closed box stays measurable
// (shell/tray/tray-morph.tsx): closed means inert, out of the pointer path and
// faded out by `.t-morph-menu`, not removed, so Playwright still sees a box.
async function expectTrayClosed(tray: Locator) {
	await expect(tray).toHaveAttribute("inert", "");
	await expect(tray).toHaveCSS("opacity", "0");
	await expect(tray).toHaveCSS("pointer-events", "none");
}

function backgroundStreams(page: Page) {
	return page.evaluate(() => {
		const read = Reflect.get(window, "__chatControlBackground");
		const snapshot = typeof read === "function" ? read() : null;
		return (snapshot?.streams ?? []) as Array<{ path: string }>;
	});
}

// Since 2643ab5fab ("ui(P2): quiet sidebar footer and a three-section account
// menu") the footer DownloadCenter tray only shows while something is in flight
// or failed; idle, Downloads is an account-menu row that opens the full page.
test("actual Layout search dismissal; idle Downloads lives in the account menu", async ({
	page,
}) => {
	await page.goto(
		"/share-conversation-toolbar-entry.html?scenario=window-tray"
	);
	const navigation = await openNavigation(page);
	await navigation.getByRole("button", { name: "Search", exact: true }).click();
	await expect(
		page.getByPlaceholder("Search everything or run a command…")
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		page.getByPlaceholder("Search everything or run a command…")
	).toBeHidden();
	const account = page.getByRole("button", { name: /^Jia Wei Ng/u });
	await expect(account).toBeVisible();
	// Nothing in flight or failed: no footer tray.
	await expect(
		page.getByRole("button", { name: "Downloads", exact: true })
	).toHaveCount(0);
	await account.click();
	await page
		.getByRole("menu")
		.last()
		.getByRole("menuitem", { name: "Downloads", exact: true })
		.click();
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expectDownloadsTabOpen(page);
	await expect(
		page.getByText("Nothing downloading", { exact: true })
	).toBeVisible();
	await page.screenshot({
		path: path.join(proof, "desktop-downloads-idle-page.png"),
	});
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
	await expect(
		page.getByText("Nothing downloading", { exact: true })
	).toBeVisible();
});

test("actual Layout DownloadCenter tray keyboard navigation with in-flight and failed downloads", async ({
	page,
}) => {
	await page.goto(
		"/share-conversation-toolbar-entry.html?scenario=window-tray-downloads"
	);
	const navigation = await openNavigation(page);
	const downloads = page.getByRole("button", {
		name: "Downloads",
		exact: true,
	});
	await expect(downloads).toBeVisible();
	// The seeded snapshot arrived over the owned, ledgered Core event stream.
	expect(
		(await backgroundStreams(page)).map((stream) => stream.path)
	).toContain("/api/events/all");
	await expect(
		page.getByLabel("1 downloads in progress", { exact: true })
	).toBeAttached();
	await downloads.focus();
	await page.keyboard.press("Enter");
	const tray = page.getByRole("dialog", { name: "Downloads", exact: true });
	await expect(tray).toBeVisible();
	await expect(tray).toBeFocused();
	await expect(downloads).toHaveAttribute("aria-expanded", "true");
	await expect(downloads).toHaveAttribute("aria-haspopup", "dialog");
	await expect(tray.getByText("Nothing downloading")).toHaveCount(0);
	// Active lists both: the in-flight model (friendly label) and the failure.
	await expect(tray.getByText("Active", { exact: true })).toBeVisible();
	await expect(tray.getByText("Qwen3", { exact: true })).toBeVisible();
	await expect(tray.getByRole("button", { name: "Pause" })).toBeVisible();
	await expect(
		tray.getByText("llama.cpp engine", { exact: true })
	).toBeVisible();
	await expect(
		tray.getByText(/Connection reset while downloading/u)
	).toBeVisible();
	await expect(tray.getByRole("button", { name: "Retry" })).toBeVisible();
	await page.screenshot({
		path: path.join(proof, "desktop-downloads-tray.png"),
	});
	await page.keyboard.press("Escape");
	await expect(downloads).toBeFocused();
	await expect(downloads).toHaveAttribute("aria-expanded", "false");
	await expectTrayClosed(tray);
	await page.keyboard.press("Enter");
	await tray
		.getByRole("button", { name: "Open downloads", exact: true })
		.click();
	await expectTrayClosed(tray);
	await expectDownloadsTabOpen(page);
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
