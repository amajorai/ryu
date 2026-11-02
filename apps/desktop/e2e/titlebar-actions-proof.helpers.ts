import { expect, type Page } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";
import {
	parseTitlebarSession,
	type TitlebarFixtureHooks,
} from "./titlebar-fixture-contract.ts";

// Fixtures and helpers for titlebar-actions-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const EVIDENCE = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);

// The harness installs these immutable hooks before rendering the workspace.
declare global {
	interface Window extends TitlebarFixtureHooks {}
}

export async function installBackendFixture(page: Page) {
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.origin === "http://127.0.0.1:5177") {
			await route.continue();
			return;
		}
		await route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({
				error: "TitleBar proof fixture: Core unavailable",
			}),
		});
	});
}

export async function openWorkspace(
	page: Page,
	url = "/titlebar-actions-proof.html"
) {
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (
			message.type() === "error" &&
			!message.text().includes("server responded with a status of 503")
		) {
			consoleErrors.push(message.text());
		}
	});
	await installBackendFixture(page);
	await page.goto(url, { waitUntil: "domcontentloaded" });
	const notice = page.getByRole("button", { name: "Got it", exact: true });
	if (await notice.count()) {
		await notice.click();
	}
	await expect(
		page.locator('[data-tab-appearance][draggable="true"]')
	).toHaveCount(url.includes("rename=1") ? 4 : 3);
	await expect(
		page.getByRole("button", { name: "Workspace overview", exact: true })
	).toBeVisible();
	return { consoleErrors, pageErrors };
}

export async function readSession(page: Page) {
	return parseTitlebarSession(
		await page.evaluate(() =>
			window.__readSealedLocalStorage("ryu_session_tabs")
		)
	);
}

export async function showTitlebar(page: Page) {
	// Since 1f12960693 (ui(P1): one ShellBanner strip) the connection banner is
	// an h-8 strip that, with the title bar auto-hidden, sits at the window's
	// top edge over the reveal zone; the "Connection restored" strip clears
	// after 3s.
	await expect(
		page.locator(
			'[data-testid="connection-status-toast"][data-connection-restored="true"]'
		)
	).toHaveCount(0, { timeout: 10_000 });
	const titlebar = page
		.locator("div[data-tab-appearance][data-tauri-drag-region]")
		.first();
	if (
		await titlebar.evaluate(
			(element) => getComputedStyle(element).opacity === "0"
		)
	) {
		const peekZone = page.locator(
			'[aria-hidden="true"][class~="h-4"][class~="w-full"]'
		);
		const box = await peekZone.boundingBox();
		if (!box) {
			throw new Error("Auto-hide top-edge reveal zone is not visible");
		}
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	}
	await expect(titlebar).toHaveCSS("opacity", "1");
}

// With the Center split into panes, the title bar lists the focused pane's
// tabs (TitleBar's displayedCenterGroup) and every other pane keeps its own
// Center tab strip. Focus the pane through that strip, then use the tab's
// title-bar menu.
export async function focusedTitlebarTab(page: Page, name: string) {
	const inTitlebar = page
		.locator("div[data-tab-appearance][data-tauri-drag-region]")
		.first()
		.getByRole("button", { name, exact: true });
	if ((await inTitlebar.count()) === 0) {
		await page.getByRole("tab", { name, exact: true }).click();
	}
	await expect(inTitlebar).toBeVisible();
	return inTitlebar;
}

export async function openTitlebarContextMenu(page: Page) {
	await showTitlebar(page);
	const newTab = page.getByRole("button", {
		name: "New chat tab",
		exact: true,
	});
	await newTab.click({ button: "right" });
}

export async function openNonHorizontalTitlebarContextMenu(page: Page) {
	await showTitlebar(page);
	const titlebar = page
		.locator("div[data-tab-appearance][data-tauri-drag-region]")
		.first();
	const trigger = titlebar.locator(
		'[data-slot="context-menu-trigger"][data-tauri-drag-region]'
	);
	await expect(trigger).toHaveCount(1);
	if (!(await trigger.isVisible())) {
		const layout = await trigger.evaluate((element) => {
			const describe = (node: Element | null) => {
				if (!node) {
					return null;
				}
				const style = getComputedStyle(node);
				const rect = node.getBoundingClientRect();
				return {
					className: node.getAttribute("class"),
					display: style.display,
					height: rect.height,
					opacity: style.opacity,
					width: rect.width,
				};
			};
			return [
				describe(element),
				describe(element.parentElement),
				describe(element.parentElement?.parentElement ?? null),
			];
		});
		throw new Error(`Non-horizontal trigger layout: ${JSON.stringify(layout)}`);
	}
	await trigger.click({ button: "right" });
	await expect(
		page.getByRole("menuitemcheckbox", {
			name: "Auto-hide title bar",
			exact: true,
		})
	).toBeVisible();
	return titlebar;
}

export async function readNativeCalls(page: Page) {
	return page.evaluate(() => {
		const host = window.__titlebarHost;
		return host.calls;
	});
}
