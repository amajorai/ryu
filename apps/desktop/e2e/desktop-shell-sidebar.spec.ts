import { mkdir, writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
const proof =
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-shell-flows/sidebar";
const registry = "ryu:standalone-apps:v1:http://127.0.0.1:5493";
const diagnostics = new WeakMap<
	Page,
	{
		pageErrors: string[];
		native: Array<{ command: string; args: unknown }>;
		http: unknown[];
		unexpectedHttp: unknown[];
	}
>();
test.beforeEach(async ({ page }) => {
	const state = {
		pageErrors: [] as string[],
		native: [] as Array<{ command: string; args: unknown }>,
		http: [] as unknown[],
		unexpectedHttp: [] as unknown[],
	};
	diagnostics.set(page, state);
	page.on("pageerror", (error) =>
		state.pageErrors.push(error.stack ?? error.message)
	);
	await page.exposeBinding(
		"__recordStandaloneNativeInvocation",
		(_source, entry: { command: string; args: unknown }) =>
			state.native.push(entry)
	);
});
test.afterEach(async ({ page }, testInfo) => {
	const state = diagnostics.get(page);
	if (!state) throw new Error("Standalone diagnostics were not initialized");
	const ledgerPath = testInfo.outputPath("standalone-native-http-errors.json");
	await writeFile(ledgerPath, JSON.stringify(state, null, 2), "utf8");
	await testInfo.attach("standalone-native-http-errors", {
		path: ledgerPath,
		contentType: "application/json",
	});
	expect(state.pageErrors).toEqual([]);
	expect(state.unexpectedHttp).toEqual([]);
	expect(
		state.native.filter(
			(entry) =>
				entry.command !== "close_current_window" ||
				(entry.args !== null &&
					(typeof entry.args !== "object" ||
						Object.keys(entry.args).length > 0))
		)
	).toEqual([]);
});
async function setup(page: Page) {
	const requests: string[] = [];
	await page.addInitScript(
		({ registry }) => {
			if (!sessionStorage.getItem("sidebar-seeded"))
				localStorage.setItem(
					registry,
					JSON.stringify([
						{
							appId: "@ryu/records",
							installedAt: "2026-10-04T00:00:00Z",
							version: "1.0.0",
						},
					])
				);
			sessionStorage.setItem("sidebar-seeded", "true");
			const state = { calls: [] as string[], failClose: true };
			Object.defineProperty(window, "__sidebarHost", { value: state });
			Object.defineProperty(window, "__TAURI_INTERNALS__", {
				value: {
					metadata: {
						currentWindow: { label: "standalone" },
						currentWebview: { label: "standalone" },
					},
					transformCallback: () => 1,
					unregisterCallback: () => undefined,
					invoke: async (command: string, args?: Record<string, unknown>) => {
						state.calls.push(command);
						const record = Reflect.get(
							window,
							"__recordStandaloneNativeInvocation"
						);
						if (typeof record !== "function")
							throw new Error("Missing persistent native ledger binding");
						await record({ command, args: args ?? null });
						if (command === "close_current_window" && state.failClose)
							throw new Error("Window close denied");
						return null;
					},
				},
			});
		},
		{ registry }
	);
	await page.route("**/api/**", async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		// Vite source-module URLs may contain /lib/api/; they are not API endpoints.
		if (!path.startsWith("/api/")) return route.continue();
		requests.push(path);
		const state = diagnostics.get(page);
		if (!state) throw new Error("Missing standalone HTTP diagnostics");
		const request = route.request();
		const entry = {
			url: request.url(),
			method: request.method(),
			authorization: request.headers().authorization ?? null,
			body: request.postData(),
		};
		state.http.push(entry);
		if (
			request.method() !== "GET" ||
			url.search ||
			url.origin !== "http://127.0.0.1:5493" ||
			request.headers().authorization !== "Bearer sidebar-test-token" ||
			!["/api/plugins/contributions", "/api/proof/records"].includes(path)
		) {
			state.unexpectedHttp.push(entry);
			return route.fulfill({
				status: 503,
				json: { error: "Unregistered standalone fixture request" },
			});
		}
		if (path === "/api/plugins/contributions") {
			await route.fulfill({
				json: {
					companions: [
						{
							id: "app__records",
							plugin_id: "@ryu/records",
							name: "Records",
							label: "Records",
							has_ui: true,
						},
					],
					sidebar_buttons: [
						{
							id: "query",
							plugin: "@ryu/records",
							title: "Recent records",
							target: "/plugin/app__records?filter=recent%20records",
							order: 2,
						},
						{
							id: "explicit",
							plugin: "@ryu/records",
							title: "Team records",
							target: "/plugin/app__records?filter=ignored",
							context: { team: "design" },
							order: 1,
						},
						{
							id: "foreign",
							plugin: "@ryu/other",
							title: "Foreign button",
							target: "/foreign",
						},
					],
					sidebar_sections: [
						{
							id: "records",
							plugin: "@ryu/records",
							title: "Projects",
							approved_grants: ["ui:declarative-http"],
							http_policy: "core",
							spec: {
								itemTarget: "/plugin/app__records?record={{item.id}}",
								context: { recordId: "id", owner: "owner" },
								source: {
									http: { path: "/api/proof/records" },
									items: "records",
									map: { id: "id", title: "name" },
								},
							},
						},
						{
							id: "denied",
							plugin: "@ryu/records",
							title: "Private projects",
							approved_grants: [],
							http_policy: "core",
							spec: {
								emptyState: { title: "No accessible records" },
								source: {
									http: { path: "/api/proof/private" },
									items: "records",
									map: { id: "id", title: "name" },
								},
							},
						},
					],
				},
			});
		} else if (path === "/api/proof/records") {
			await route.fulfill({
				json: {
					records: [{ id: "a/b ?&", name: "Design review", owner: "Jiawei" }],
				},
			});
		} else
			await route.fulfill({ status: 503, json: { error: "Fixture boundary" } });
	});
	await page.goto("/desktop-shell-sidebar.html");
	await expect(
		page.getByRole("button", { name: "Design review" })
	).toBeVisible();
	return requests;
}
test("shipping hosted sidebar forwards encoded targets, contexts and permission-scoped sources", async ({
	page,
}) => {
	const requests = await setup(page);
	await expect(
		page.getByRole("button", { name: "Foreign button" })
	).toHaveCount(0);
	await expect(page.getByText("No accessible records")).toBeVisible();
	expect(requests).not.toContain("/api/proof/private");
	await page.getByRole("button", { name: "Design review" }).focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("navigation-path")).toHaveText(
		"/plugin/app__records?record=a%2Fb%20%3F%26"
	);
	await expect(page.getByTestId("navigation-context")).toHaveText(
		JSON.stringify({ recordId: "a/b ?&", owner: "Jiawei" })
	);
	await page.getByRole("button", { name: "Recent records" }).click();
	await expect(page.getByTestId("navigation-context")).toHaveText(
		JSON.stringify({ filter: "recent records" })
	);
	await page.getByRole("button", { name: "Team records" }).click();
	await expect(page.getByTestId("navigation-context")).toHaveText(
		JSON.stringify({ team: "design" })
	);
	await page.getByRole("button", { name: "Records", exact: true }).click();
	await expect(page.getByTestId("navigation-path")).toHaveText(
		"/plugin/app__records"
	);
	await expect(page.getByTestId("navigation-context")).toHaveText("null");
	await mkdir(proof, { recursive: true });
	await page.screenshot({
		path: `${proof}/standalone-navigation-completed.png`,
	});
});
test("removal cancel retains registry; native failure stays visible and retries without app lifecycle calls", async ({
	page,
}) => {
	const requests = await setup(page);
	await page.getByRole("button", { name: "Remove standalone app" }).click();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(
		await page.evaluate(
			(key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
			registry
		)
	).toHaveLength(1);
	await page.getByRole("button", { name: "Remove standalone app" }).click();
	const dialog = page.getByRole("alertdialog");
	await dialog.getByRole("button", { name: "Remove standalone app" }).click();
	await expect(dialog.getByRole("alert")).toContainText("Window close denied");
	await expect(dialog).toBeVisible();
	expect(
		await page.evaluate(
			(key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
			registry
		)
	).toHaveLength(0);
	await mkdir(proof, { recursive: true });
	await page.screenshot({ path: `${proof}/standalone-removal-error.png` });
	await page.evaluate(() => {
		(
			window as Window & { __sidebarHost: { failClose: boolean } }
		).__sidebarHost.failClose = false;
	});
	await dialog.getByRole("button", { name: "Remove standalone app" }).click();
	await expect(dialog).toHaveCount(0);
	const calls = await page.evaluate(() =>
		(
			window as Window & { __sidebarHost: { calls: string[] } }
		).__sidebarHost.calls.filter(
			(command) => command === "close_current_window"
		)
	);
	expect(calls).toHaveLength(2);
	expect(
		requests.every(
			(path) => !path.includes("/uninstall") && !path.includes("/disable")
		)
	).toBe(true);
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Design review" })
	).toBeVisible();
	expect(
		await page.evaluate(
			(key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
			registry
		)
	).toHaveLength(0);
	await page.screenshot({ path: `${proof}/standalone-removal-completed.png` });
});
