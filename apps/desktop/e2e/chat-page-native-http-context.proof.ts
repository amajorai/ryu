import { expect, type Page, test } from "@playwright/test";
import { CONTEXT_PANEL_BREAKDOWN } from "./chat-page-native-http-context.ts";
import {
	assertNativeWindowLifetime,
	persistNativeLifetimeDiagnostics,
} from "./chat-page-native-http-lifetime.ts";
import {
	CHAT_PAGE_NATIVE_NODE_A_TOKEN,
	chatPageControl,
	chatPageState,
} from "./chat-page-native-http-support.ts";

const path = "/api/conversations/conversation-toolbar-share-fixture/context";
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page, request }, testInfo) => {
	const capture = () =>
		page.evaluate(() => {
			const fixture = Reflect.get(window, "__chatPageNativeFixture");
			return fixture
				? {
						snapshot: fixture.nativeSnapshot(),
						details: fixture.nativeDiagnostics(),
					}
				: null;
		});
	const beforeCleanup = await capture();
	try {
		for (const requestId of (await chatPageState(request)).heldRequestIds) {
			await chatPageControl(request, {
				action: "release",
				requestId,
				accept: false,
			});
		}
		expect.soft((await chatPageState(request)).unexpected).toEqual([]);
		expect.soft((await chatPageState(request)).heldRequestIds).toEqual([]);
		expect.soft(pageErrors.get(page)).toEqual([]);
		await page.evaluate(() =>
			Reflect.get(window, "__chatPageNativeFixture")?.unmount()
		);
		await assertNativeWindowLifetime(page);
	} finally {
		await persistNativeLifetimeDiagnostics(testInfo, {
			beforeCleanup,
			afterCleanup: await capture(),
			pageErrors: pageErrors.get(page),
			http: await chatPageState(request),
		});
	}
});
async function boot(page: Page, scenario: string) {
	await page.goto(`/chat-page-native-http.html?scenario=${scenario}`);
	await expect(
		page.getByText("The organization copy is ready for review.", {
			exact: true,
		})
	).toBeVisible();
	await expect(
		page.getByRole("button", {
			name: "Context 73% used — open breakdown",
			exact: true,
		})
	).toBeVisible();
}
// The workbench opens the breakdown as a closable tab titled after the
// conversation ("Context: <title>"); its close button names that tab.
const CONTEXT_TAB_TITLE = /^Context: /u;
function contextTab(page: Page) {
	return page.getByRole("tab", { name: CONTEXT_TAB_TITLE });
}
function closeContextTab(page: Page) {
	return page.getByRole("button", { name: /^Close Context: /u });
}
async function open(page: Page, status: number, body: unknown) {
	const response = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === path &&
			response.request().method() === "GET"
	);
	await page
		.getByRole("button", {
			name: "Context 73% used — open breakdown",
			exact: true,
		})
		.click();
	const actual = await response;
	expect(actual.status()).toBe(status);
	expect(actual.headers()["content-type"]).toContain("application/json");
	if (status === 200) {
		expect(await actual.json()).toEqual(body);
	}
	await expect(contextTab(page)).toHaveCount(1);
}
async function close(page: Page) {
	await closeContextTab(page).click();
	// The closed tab and its content must disappear while the meter that opens
	// the breakdown again remains usable.
	await expect(contextTab(page)).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Context window", exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", {
			name: "Context 73% used — open breakdown",
			exact: true,
		})
	).toBeEnabled();
}
async function assertBreakdown(page: Page) {
	const panel = page.locator(".scroll-fade").filter({
		has: page.getByRole("heading", { name: "Context window", exact: true }),
	});
	await expect(panel).toHaveCount(1);
	await expect(panel.getByText("73.0%", { exact: true })).toBeVisible();
	for (const [label, value] of [
		["Reported by provider", "730"],
		["Attributed by Core", "460"],
		["Reserved for reply", "100 tokens"],
		["Free", "270 of 1,000"],
	]) {
		await expect(
			panel.getByText(label, { exact: true }).locator("..")
		).toHaveText(label + value);
	}
	for (const [label, tokens, width] of [
		["Instructions", 200, "20%"],
		["Messages", 160, "16%"],
		["Tools", 100, "10%"],
		["Unattributed", 270, "27%"],
	] as const) {
		const band = panel.getByTitle(`${label} — ${tokens} tokens`, {
			exact: true,
		});
		await expect(band).toBeVisible();
		// Each band draws its share through the `--agent-width` custom property.
		expect(
			await band.evaluate((element) =>
				(element as HTMLElement).style.getPropertyValue("--agent-width")
			)
		).toBe(width);
	}
	await expect(
		panel.getByText("4 tools across 2 servers", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("No context breakdown yet", { exact: true })
	).toHaveCount(0);
}
async function assertReads(
	request: Parameters<typeof chatPageState>[0],
	statuses: number[]
) {
	const calls = (await chatPageState(request)).calls.filter(
		(call) => call.path === path
	);
	expect(calls.map((call) => call.responseStatus)).toEqual(statuses);
	for (const call of calls) {
		expect(call).toMatchObject({
			node: "a",
			method: "GET",
			origin: "http://127.0.0.1:5590",
			authorization: `Bearer ${CHAT_PAGE_NATIVE_NODE_A_TOKEN}`,
			userJwt: null,
			body: null,
			rawBody: null,
		});
	}
	expect(
		(await chatPageState(request)).calls.filter(
			(call) =>
				call.path === "/api/chat/cancel" ||
				(call.path === "/api/chat/stream" && call.method === "POST")
		)
	).toEqual([]);
}
test("shipping context meter opens attributed dock with provider totals and fresh read after close/reopen", async ({
	page,
	request,
}) => {
	await chatPageControl(request, {
		action: "reset",
		scenario: "context-breakdown-caller",
	});
	await boot(page, "context-breakdown-caller");
	await open(page, 200, { breakdown: CONTEXT_PANEL_BREAKDOWN });
	await assertBreakdown(page);
	await close(page);
	await open(page, 200, { breakdown: CONTEXT_PANEL_BREAKDOWN });
	await assertBreakdown(page);
	await assertReads(request, [200, 200]);
});
test("missing Core snapshot opens honest empty dock without invented attribution", async ({
	page,
	request,
}) => {
	await chatPageControl(request, {
		action: "reset",
		scenario: "context-breakdown-empty",
	});
	await boot(page, "context-breakdown-empty");
	await open(page, 200, { breakdown: null });
	await expect(
		page.getByText("No context breakdown yet", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Attributed by Core", { exact: true })
	).toHaveCount(0);
	await close(page);
	await open(page, 200, { breakdown: null });
	await expect(
		page.getByText("No context breakdown yet", { exact: true })
	).toBeVisible();
	await assertReads(request, [200, 200]);
});
test("refused context read stays empty and close/reopen physically retries into real attribution", async ({
	page,
	request,
}) => {
	await chatPageControl(request, {
		action: "reset",
		scenario: "context-breakdown-caller",
	});
	await boot(page, "context-breakdown-caller");
	await chatPageControl(request, {
		action: "refuse_next",
		node: "a",
		method: "GET",
		path,
		status: 503,
		message: "Owned context read unavailable.",
	});
	await open(page, 503, null);
	await expect(
		page.getByText("No context breakdown yet", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Attributed by Core", { exact: true })
	).toHaveCount(0);
	await close(page);
	await open(page, 200, { breakdown: CONTEXT_PANEL_BREAKDOWN });
	await assertBreakdown(page);
	await assertReads(request, [503, 200]);
});
