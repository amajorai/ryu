import { mkdir } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { pluginValueSchema } from "../src/lib/api/plugin-wire-values.ts";
import { createScrollableTabsCoreFixture } from "./harness/scrollable-tabs-core-fixture.ts";

const evidence =
	"../../docs/proof/test-coverage-sweep-20260924/parallel/coordinator-tabs";
const browserFailures = new WeakMap<Page, string[]>();
const unexpectedApiCalls = new WeakMap<Page, string[]>();
declare global {
	interface Window {
		__tabsConnectionSettled?: boolean;
	}
}

const sessionReadbackSchema = z.object({
	tabs: z.array(z.object({ path: z.string(), title: z.string() })),
	activeIndex: z.number(),
});

async function waitForSettledConnection(page: Page) {
	await expect
		.poll(() => page.evaluate(() => window.__tabsConnectionSettled === true))
		.toBe(true);
	await expect(page.getByTestId("connection-status-toast")).toHaveCount(0);
}

test.beforeEach(({ page }) => {
	const errors: string[] = [];
	browserFailures.set(page, errors);
	unexpectedApiCalls.set(page, []);
	page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
});

test.afterEach(({ page }) => {
	expect(browserFailures.get(page), "Unexpected browser exceptions").toEqual(
		[]
	);
	expect(
		unexpectedApiCalls.get(page),
		"API callers missing exact fixtures"
	).toEqual([]);
});

async function setup(page: Page) {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const coreResponse = createScrollableTabsCoreFixture();
	await page.route("**/api/**", (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		if (!path.startsWith("/api/")) {
			return route.continue();
		}
		const body = route.request().postData()
			? pluginValueSchema.parse(route.request().postDataJSON())
			: undefined;
		const response = coreResponse(
			route.request().method(),
			path,
			body,
			url.search
		);
		if (response) {
			const expectedTicketRefusal =
				route.request().method() === "POST" &&
				path === "/api/ws/ticket" &&
				response.status === 503;
			if ((response.status ?? 200) >= 400 && !expectedTicketRefusal) {
				unexpectedApiCalls
					.get(page)
					?.push(
						`Fixture rejected ${route.request().method()} ${path}: ${response.status}`
					);
			}
			return route.fulfill(response);
		}
		unexpectedApiCalls.get(page)?.push(`${route.request().method()} ${path}`);
		return route.fulfill({
			status: 404,
			json: { error: "Missing explicit tab host fixture" },
		});
	});
	await page.addInitScript(() => {
		let sawOnline = false;
		const observer = new MutationObserver(() => {
			const toast = document.querySelector(
				'[data-testid="connection-status-toast"]'
			);
			if (toast?.getAttribute("data-connection-phase") === "online") {
				sawOnline = true;
			}
			if (sawOnline && !toast) {
				window.__tabsConnectionSettled = true;
				observer.disconnect();
			}
		});
		observer.observe(document, {
			subtree: true,
			childList: true,
			attributes: true,
		});
		if (sessionStorage.getItem("tabs-proof-seeded")) {
			return;
		}
		sessionStorage.setItem("tabs-proof-seeded", "true");
		localStorage.setItem("ryu_tab_layout", "scroll");
		localStorage.setItem("ryu_startup_behavior", "restore");
		localStorage.setItem(
			"ryu_session_tabs",
			JSON.stringify({
				tabs: [
					{ path: "/channels", title: "Channels" },
					{ path: "/settings", title: "Settings" },
					{ path: "/chat", title: "New chat" },
				],
				activeIndex: 0,
			})
		);
	});
	await page.goto("/scrollable-tabs-host-proof.html");
	await expect(page.getByTestId("scrollable-tabs-view")).toBeVisible();
	await expect(page.locator("[data-tab-view-card]")).toHaveCount(3);
}
async function session(page: Page) {
	const raw = await page.evaluate(() =>
		localStorage.getItem("ryu_session_tabs")
	);
	return sessionReadbackSchema.parse(JSON.parse(raw ?? "{}"));
}
test("full Layout keyboard focus moves through consecutive cards and boundaries", async ({
	page,
}) => {
	await setup(page);
	const cards = page.locator("[data-tab-view-card]");
	await cards.nth(0).focus();
	await page.keyboard.press("ArrowRight");
	await expect(cards.nth(1)).toHaveAttribute("data-focused", "true");
	await expect(cards.nth(1)).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(cards.nth(2)).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(cards.nth(2)).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(cards.nth(1)).toBeFocused();
	await expect.poll(async () => (await session(page)).activeIndex).toBe(1);
});
test("new chat creates distinct live tabs and persists across reload", async ({
	page,
}) => {
	await setup(page);
	await page.getByRole("button", { name: "New chat tab", exact: true }).click();
	await expect(page.locator("[data-tab-view-card]")).toHaveCount(4);
	await page.getByRole("button", { name: "New chat tab", exact: true }).click();
	await expect(page.locator("[data-tab-view-card]")).toHaveCount(5);
	await expect
		.poll(
			async () =>
				(await session(page)).tabs.filter((t) => t.path === "/chat").length
		)
		.toBe(3);
	await page.reload();
	await expect(page.locator("[data-tab-view-card]")).toHaveCount(5);
	await expect(
		page.locator('[data-tab-view-card][data-focused="true"]')
	).toHaveCount(1);
});
test("close selected card persists survivors and context close uses the same provider", async ({
	page,
}) => {
	await setup(page);
	await page
		.locator("[data-tab-view-header]")
		.nth(1)
		.getByRole("button", { name: "Settings", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Close Settings", exact: true })
		.click();
	await expect(page.locator("[data-tab-view-card]")).toHaveCount(2);
	await expect
		.poll(async () => (await session(page)).tabs.map((t) => t.path))
		.toEqual(["/channels", "/chat"]);
	await page
		.locator("[data-tab-view-header]")
		.first()
		.click({ button: "right" });

	await page.getByRole("menuitem", { name: "Close tab", exact: true }).click();
	await expect(page.locator("[data-tab-view-card]")).toHaveCount(1);
	await page.reload();
	await expect(page.locator("[data-tab-view-card]")).toHaveCount(1);
	await expect
		.poll(async () => (await session(page)).tabs.map((t) => t.path))
		.toEqual(["/chat"]);
	await mkdir(evidence, { recursive: true });
	await waitForSettledConnection(page);
	await page.screenshot({
		path: `${evidence}/closed-tabs-readback.png`,
		fullPage: false,
	});
});
test("context layout selection switches actual Layout branch and survives reload", async ({
	page,
}) => {
	await setup(page);
	await page
		.locator("[data-tab-view-header]")
		.first()
		.click({ button: "right" });
	await page
		.getByRole("menuitemradio", { name: "Horizontal tabs", exact: true })
		.click();
	await expect(page.getByTestId("scrollable-tabs-view")).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_tab_layout")))
		.toBe("horizontal");
	await page.reload();
	await expect(page.getByTestId("scrollable-tabs-view")).toHaveCount(0);
	expect((await session(page)).tabs).toHaveLength(3);
});
test("vertical wheel selects nearest card and responsive override keeps saved layout", async ({
	page,
}) => {
	await setup(page);
	const track = page.getByTestId("scrollable-tabs-track");
	const box = await track.boundingBox();
	if (!box) {
		throw new Error("Scrollable track missing");
	}
	await page.mouse.move(box.x + box.width / 2, box.y + 70);
	const before = await track.evaluate((el) => el.scrollLeft);
	await page.mouse.wheel(0, 800);
	await expect
		.poll(() => track.evaluate((el) => el.scrollLeft))
		.toBeGreaterThan(before);
	await expect
		.poll(async () => (await session(page)).activeIndex)
		.toBeGreaterThan(0);
	await page.setViewportSize({ width: 650, height: 820 });
	await expect(page.getByTestId("scrollable-tabs-view")).toHaveCount(0);
	expect(
		await page.evaluate(() => localStorage.getItem("ryu_tab_layout"))
	).toBe("scroll");
	await page.setViewportSize({ width: 1180, height: 820 });
	await expect(page.getByTestId("scrollable-tabs-view")).toBeVisible();
	await expect(page.locator("[data-tab-view-card]")).toHaveCount(3);
});

test("right click preserves active card until explicit menu Focus", async ({
	page,
}) => {
	await setup(page);
	const cards = page.locator("[data-tab-view-card]");
	const header = page.locator("[data-tab-view-header]").nth(1);
	const box = await header.boundingBox();
	const track = await page.getByTestId("scrollable-tabs-track").boundingBox();
	if (!(box && track)) {
		throw new Error("Tab header geometry unavailable");
	}
	const x = Math.min(box.x + 12, track.x + track.width - 8);
	expect(x).toBeGreaterThan(box.x);
	await page.mouse.click(x, box.y + 20, { button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Focus tab", exact: true })
	).toBeEnabled();
	await expect(cards.nth(0)).toHaveAttribute("data-focused", "true");
	await page.getByRole("menuitem", { name: "Focus tab", exact: true }).click();
	await expect(cards.nth(1)).toHaveAttribute("data-focused", "true");
	await expect(
		page.getByRole("menuitem", { name: "Focus tab", exact: true })
	).toBeHidden();
	await expect.poll(async () => (await session(page)).activeIndex).toBe(1);
	await mkdir(evidence, { recursive: true });
	await waitForSettledConnection(page);
	await page.screenshot({
		path: `${evidence}/context-focus-readback.png`,
		fullPage: false,
	});
});
test("arrow keys in real chat editor retain caret control and selected tab", async ({
	page,
}) => {
	await setup(page);
	const card = page.locator("[data-tab-view-card]").nth(2);
	await card
		.locator("[data-tab-view-header]")
		.getByRole("button", { name: "New chat", exact: true })
		.click();
	const editor = card.getByRole("textbox", {
		name: "Send a message",
		exact: true,
	});
	await expect(editor).toBeVisible();
	await editor.fill("review");
	await editor.press("End");
	await editor.press("ArrowLeft");
	await expect
		.poll(() =>
			editor.evaluate((element) => {
				if (!(element instanceof HTMLTextAreaElement)) {
					throw new Error("Chat editor must be the native textarea");
				}
				return element.selectionStart;
			})
		)
		.toBe(5);
	await editor.press("ArrowRight");
	await expect
		.poll(() =>
			editor.evaluate((element) => {
				if (!(element instanceof HTMLTextAreaElement)) {
					throw new Error("Chat editor must be the native textarea");
				}
				return element.selectionStart;
			})
		)
		.toBe(6);
	await expect(card).toHaveAttribute("data-focused", "true");
	await expect(editor).toBeFocused();
	await expect(editor).toHaveValue("review");
	await expect.poll(async () => (await session(page)).activeIndex).toBe(2);
	await mkdir(evidence, { recursive: true });
	await waitForSettledConnection(page);
	await page.screenshot({ path: `${evidence}/chat-caret-readback.png` });
});
