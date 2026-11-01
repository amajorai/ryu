// Per-test hooks, local Core API routing and shared page helpers for the
// AppSidebar interactions proof specs.
import { mkdir, writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { sidebarCoreApiResponse } from "./app-sidebar-interactions-proof.api-core.ts";
import { sidebarWorkspaceApiResponse } from "./app-sidebar-interactions-proof.api-workspace.ts";
import {
	type SidebarProofJson,
	type SidebarProofState,
	sidebarProofJsonSchema,
	sidebarTabSnapshotSchema,
} from "./app-sidebar-interactions-proof.contracts.ts";
import {
	type ApiFixture,
	channelConfig,
	EVIDENCE_DIRECTORY,
	EXPECTED_OPTIONAL_RESOURCE_URLS,
	jsonResponse,
	type ProofWindow,
	type RecordedRequest,
	STORY_URL,
} from "./app-sidebar-interactions-proof.fixture-data.ts";

export const unexpectedBrowserErrors = new WeakMap<Page, string[]>();
const nativeRequestLedger = new WeakMap<
	Page,
	Array<{ command: string; args: unknown }>
>();
const unexpectedHttpRequests = new WeakMap<Page, RecordedRequest[]>();
const fixtures = new WeakMap<Page, ApiFixture>();

async function installLocalApiFixture(
	page: Page,
	options?: { failChannelCreateOnce?: boolean }
): Promise<ApiFixture> {
	const fixture: ApiFixture = {
		calendarEnabled: false,
		channels: [channelConfig("channel-proof", "Proof Telegram")],
		identities: [{ connections: [], profile_id: "proof-profile" }],
		spaces: [
			{
				created_at: 1_700_000_000_000,
				description: "Local sidebar proof space",
				document_count: 1,
				icon: null,
				id: "space-proof",
				name: "Proof space",
				retrieval_mode: "vector",
				system: false,
				updated_at: 1_700_000_000_000,
				visibility: "private",
			},
		],
		failChannelCreateOnce: options?.failChannelCreateOnce ?? false,
		failSpaceCreateOnce: false,
		failSkillReadCount: 0,
		failFolderCreateOnce: false,
		failFolderCloneOnce: false,
		requests: [],
	};
	await page.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname.startsWith("/api/")) {
			let body: SidebarProofJson = null;
			try {
				body = sidebarProofJsonSchema.parse(request.postDataJSON());
			} catch {
				body = null;
			}
			fixture.requests.push({
				body,
				method: request.method(),
				path: url.pathname,
			});

			const response =
				sidebarCoreApiResponse(fixture, request, url, body) ??
				sidebarWorkspaceApiResponse(fixture, request, url, body);
			if (response) {
				return await route.fulfill(response);
			}
			return await route.fulfill(jsonResponse({}));
		}
		if (url.hostname === "api.iconify.design") {
			if (url.pathname.endsWith("/search")) {
				return await route.fulfill(jsonResponse({ icons: ["lucide:folder"] }));
			}
			if (url.pathname.endsWith("/collection")) {
				return await route.fulfill(jsonResponse({ uncategorized: ["folder"] }));
			}
			return await route.fulfill({
				body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
				contentType: "image/svg+xml",
				status: 200,
			});
		}
		const harnessOrigin = new URL(
			process.env.RYU_SIDEBAR_PROOF_ORIGIN ??
				test.info().project.use.baseURL ??
				"http://127.0.0.1:5452"
		).origin;
		if (url.origin === harnessOrigin) {
			return await route.continue();
		}
		return await route.abort();
	});
	return fixture;
}

export function fixtureFor(page: Page): ApiFixture {
	const fixture = fixtures.get(page);
	if (!fixture) {
		throw new Error("AppSidebar API fixture was not installed");
	}
	return fixture;
}

export function tabs(page: Page) {
	return page
		.getByTestId("tab-state")
		.evaluate((element) => JSON.parse(element.textContent ?? "{}"))
		.then(sidebarTabSnapshotSchema.parse);
}

export async function activeTabPath(page: Page): Promise<string | undefined> {
	const state = await tabs(page);
	return state.tabs.find((tab) => tab.id === state.activeTabId)?.path;
}

export async function openGlobalContextMenu(page: Page) {
	// The real ContextMenuTrigger wraps SidebarContent. Right-click a rendered
	// section header inside it so the event bubbles through the production wrapper.
	const preferredTarget = page.locator("#sidebar-sec-agents");
	const fallbackTarget = page.locator("[data-sidebar='group']").first();
	await expect(preferredTarget.or(fallbackTarget).first()).toBeVisible();
	let target = preferredTarget;
	if ((await target.count()) === 0) {
		target = fallbackTarget;
	}
	if ((await target.count()) === 0) {
		const rendered = await page.evaluate(() =>
			Array.from(
				document.querySelectorAll("[data-sidebar='group']"),
				(element) => ({
					id: element.id,
					rect: element.getBoundingClientRect().toJSON(),
					text: element.textContent?.slice(0, 80),
				})
			)
		);
		throw new Error(
			`No visible sidebar section for global menu: ${JSON.stringify(rendered)}`
		);
	}
	await target.scrollIntoViewIfNeeded();
	const bounds = await target.boundingBox();
	if (!bounds) {
		throw new Error("The production sidebar section surface did not render");
	}
	await page.mouse.click(bounds.x + 10, bounds.y + 10, {
		button: "right",
	});
	const menus = page.locator('[data-slot="context-menu-content"]:visible');
	await expect(menus.last()).toBeVisible();
	return menus.last();
}

export async function openRowContextMenu(page: Page, rowName: string) {
	const row = page.getByRole("button", { name: rowName }).first();
	await row.click({ button: "right", force: true });
	const menus = page.locator('[data-slot="context-menu-content"]:visible');
	await expect(menus.last()).toBeVisible();
	return menus.last();
}

export async function openSectionRowContextMenu(
	page: Page,
	sectionKey: string,
	rowName: string
) {
	const row = page
		.locator(`#sidebar-sec-${sectionKey}`)
		.getByRole("button", { name: rowName })
		.last();
	await row.click({ button: "right", force: true });
	const menus = page.locator('[data-slot="context-menu-content"]:visible');
	await expect(menus.last()).toBeVisible();
	return menus.last();
}

export async function openChromeContextMenu(page: Page, buttonName: string) {
	const button = page
		.getByTestId("sidebar-header-actions")
		.getByRole("button", { name: buttonName, exact: true })
		.last();
	await expect(button).toBeVisible();
	await button.click({ button: "right", force: true });
	const menus = page.locator('[data-slot="context-menu-content"]:visible');
	await expect(menus.last()).toBeVisible();
	return menus.last();
}

/** Since 306ce31b7f (Ryu Quiet one-line rows) the Chats header shows only
 *  "+" and "⋯": New section and both imports are rows in its ⋯ menu. */
export async function chooseChatsMenuAction(page: Page, name: string) {
	await page
		.getByRole("button", { name: "Chats options", exact: true })
		.click();
	await page.getByRole("menuitem", { name, exact: true }).click();
}

export async function storageValue(page: Page, key: string) {
	return page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
}

/** Registers the per-test native ledger, boot seeding and local API fixture. */
export function registerAppSidebarProofHooks() {
	// Any part of the split proof can be the first file against a cold dev
	// server. Load the story once, with no assertions, so compiling the module
	// graph does not spend the first test's own time budget.
	test.beforeAll(async ({ browser }, testInfo) => {
		test.setTimeout(120_000);
		const page = await browser.newPage();
		try {
			await page.goto(new URL(STORY_URL, testInfo.project.use.baseURL).href, {
				waitUntil: "load",
			});
		} finally {
			await page.close();
		}
	});
	test.beforeEach(async ({ page }) => {
		const unexpectedErrors: string[] = [];
		unexpectedBrowserErrors.set(page, unexpectedErrors);
		const nativeCalls: Array<{ command: string; args: unknown }> = [];
		nativeRequestLedger.set(page, nativeCalls);
		unexpectedHttpRequests.set(page, []);
		await page.exposeBinding(
			"__SIDEBAR_NATIVE_LEDGER__",
			(_source, call: { command: string; args: unknown }) => {
				nativeCalls.push(call);
			}
		);
		await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
		await page.setViewportSize({ width: 1440, height: 1000 });
		page.on("pageerror", (error) => {
			unexpectedErrors.push(error.message);
			console.error("AppSidebar proof page error:", error);
		});
		page.on("console", (message) => {
			if (message.type() === "error") {
				if (
					!EXPECTED_OPTIONAL_RESOURCE_URLS.has(message.location().url) ||
					message.text() !== "Failed to load resource: net::ERR_FAILED"
				) {
					unexpectedErrors.push(`${message.location().url}: ${message.text()}`);
				}
				console.error(
					"AppSidebar proof browser error:",
					message.text(),
					JSON.stringify(message.location())
				);
			}
		});
		page.on("requestfailed", (request) => {
			if (
				!EXPECTED_OPTIONAL_RESOURCE_URLS.has(request.url()) ||
				request.failure()?.errorText !== "net::ERR_FAILED"
			) {
				unexpectedErrors.push(
					`${request.url()}: ${request.failure()?.errorText}`
				);
			}
			console.error(
				"AppSidebar proof failed resource:",
				request.method(),
				request.url(),
				request.failure()?.errorText
			);
		});
		await page.addInitScript(() => {
			if (location.protocol === "about:") {
				return;
			}
			const search = new URLSearchParams(location.search);
			const bootKey = "proof:app-sidebar-interactions-booted";
			const bootSeed = location.pathname + location.search;
			if (sessionStorage.getItem(bootKey) !== bootSeed) {
				localStorage.clear();
				const sections = [
					"tabs",
					"agents",
					"spaces",
					"channels",
					"integrations",
					"identities",
					"skills",
					"mcp",
					"tools",
					"plugins",
					"companions",
					"engines",
					"pinned",
					"projects",
					"chats",
					"archived",
				];
				const focus = search.get("focus");
				const visible = new Set(
					focus === null ? sections : focus === "none" ? [] : focus.split(",")
				);
				const defaultHiddenSections = [
					"channels",
					"integrations",
					"identities",
					"skills",
					"mcp",
					"tools",
					"engines",
					"plugins",
				];
				localStorage.setItem(
					"ryu:sidebar-hidden-seeded",
					JSON.stringify(defaultHiddenSections)
				);
				localStorage.setItem("ryu:sidebar-hidden-chrome-seeded", "[]");
				localStorage.setItem(
					"ryu:sidebar-hidden-sections",
					JSON.stringify(sections.filter((section) => !visible.has(section)))
				);
				localStorage.setItem(
					"ryu:sidebar-hidden-chrome",
					JSON.stringify(["node-selector", "logo"])
				);
				localStorage.setItem(
					"ryu:sidebar-mode",
					search.get("mode") ?? "sections"
				);
				if (search.get("session") === "main") {
					localStorage.setItem("ryu_startup_behavior", "restore");
				}
				localStorage.setItem("ryu:product-mode", "console");
				localStorage.setItem("ryu:interface-level", "expert");
				localStorage.setItem("ryu_tab_layout", "vertical");
				localStorage.setItem("ryu:notification-layout", "unified");
				localStorage.setItem("ryu:agent-row-style", "compact");
				if (search.get("auth") !== "off") {
					localStorage.setItem(
						"ryu_session_token",
						"local-app-sidebar-proof-token"
					);
				}
				localStorage.setItem("ryu:sidebar-overflow-popover", "false");
				localStorage.setItem(
					"ryu_tab_open_behavior",
					search.get("behavior") === "current" ? "current" : "new"
				);
				localStorage.setItem(
					"ryu:sidebar-grouped-nav",
					search.get("grouped") === "off" ? "false" : "true"
				);
				localStorage.setItem(
					"ryu:sidebar-section-page-sizes",
					JSON.stringify({ channels: 10, identities: 10, skills: 10 })
				);
				sessionStorage.setItem(bootKey, bootSeed);
			}

			const proofWindow = window;
			const proofState: SidebarProofState = {
				callbackId: 0,
				nativeCalls: [],
				quickPreviewId: null,
				quickReplyId: null,
			};
			proofWindow.__APP_SIDEBAR_PROOF__ = proofState;
			Object.defineProperty(window, "__TAURI_INTERNALS__", {
				configurable: true,
				value: {
					invoke: async (command: string, args?: InvokeArgs) => {
						proofState.nativeCalls.push({ args: args ?? null, command });
						await (window as ProofWindow).__SIDEBAR_NATIVE_LEDGER__?.({
							args: args ?? null,
							command,
						});
						if (command === "plugin:app|version") {
							if (
								args !== undefined &&
								(args === null ||
									typeof args !== "object" ||
									Array.isArray(args) ||
									Object.keys(args).length !== 0)
							) {
								throw new Error("Unexpected app version native arguments");
							}
							return "0.0.0";
						}
						if (command === "plugin:event|listen") {
							return 1;
						}
						if (command === "plugin:event|unlisten") {
							return undefined;
						}
						if (command === "open_tab_window") {
							return { accepted: true };
						}
						return undefined;
					},
					transformCallback: () => {
						proofState.callbackId += 1;
						return proofState.callbackId;
					},
				},
			});
		});
		fixtures.set(page, await installLocalApiFixture(page));
	});

	test.afterEach(async ({ page }, testInfo) => {
		const ledgerPath = testInfo.outputPath(
			"sidebar-request-and-error-ledgers.json"
		);
		await writeFile(
			ledgerPath,
			JSON.stringify(
				{
					http: fixtures.get(page)?.requests ?? [],
					unexpectedHttp: unexpectedHttpRequests.get(page) ?? [],
					native: nativeRequestLedger.get(page) ?? [],
					browserErrors: unexpectedBrowserErrors.get(page) ?? [],
				},
				null,
				2
			),
			"utf8"
		);
		await testInfo.attach("sidebar-request-and-error-ledgers", {
			path: ledgerPath,
			contentType: "application/json",
		});
	});
}
