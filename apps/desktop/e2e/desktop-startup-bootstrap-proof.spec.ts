import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	answerDesktopSecretSlot,
	LEGACY_VAULT_LOCAL_STORAGE_KEYS,
	memorySlotStorage,
	readAuthVaultSlot,
	type SlotStorage,
} from "./harness/desktop-secret-slots.ts";

const proofDir = resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/coordinator-startup"
);

// The sealed `auth-vault` / `license-key` slots, kept per test across reloads.
// Empty at first, so the plaintext vault seeded below migrates into the slot
// exactly as an upgraded install does; the auth client then reads the slot.
let slotStorage: SlotStorage = memorySlotStorage();

function sealedVault() {
	const vault = readAuthVaultSlot(slotStorage);
	if (!vault) {
		throw new Error("The auth-vault slot is empty");
	}
	return vault;
}

async function expectNoPlaintextVault(page: Page) {
	expect(
		await page.evaluate(
			(keys) => keys.map((key) => localStorage.getItem(key)),
			[...LEGACY_VAULT_LOCAL_STORAGE_KEYS]
		)
	).toEqual([null, null, null]);
}

test.beforeEach(async ({ page }) => {
	slotStorage = memorySlotStorage();
	await page.exposeBinding(
		"startupSecretSlot",
		(_source, command: string, args?: Record<string, unknown>) =>
			answerDesktopSecretSlot(slotStorage, command, args ?? {}).value
	);
	await page.addInitScript(() => {
		if (location.protocol === "about:") {
			return;
		}
		if (!sessionStorage.getItem("startup-seeded")) {
			sessionStorage.setItem("startup-seeded", "true");
			localStorage.clear();
			localStorage.setItem(
				"ryu_accounts",
				JSON.stringify([
					{
						userId: "user-one",
						name: "First account",
						email: "one@example.test",
						image: null,
						token: "token-one",
					},
					{
						userId: "user-two",
						name: "Second account",
						email: "two@example.test",
						image: null,
						token: "token-two",
					},
				])
			);
			localStorage.setItem("ryu_active_user_id", "user-one");
			localStorage.setItem("ryu_session_token", "token-one");
			localStorage.setItem("ryu_startup_selection_mode", "always");
			localStorage.setItem("ryu:product-mode", "os");
			// OS is rollout-flagged off by default; this proof boots into it.
			localStorage.setItem(
				"ryu.feature-flags",
				JSON.stringify({
					accountId: "user-one",
					features: { "ui.interface_os": true },
					fetchedAtMs: Date.now(),
				})
			);
		}
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: {
				metadata: {
					currentWindow: { label: "main" },
					currentWebview: { label: "main" },
				},
				transformCallback: () => 1,
				unregisterCallback: () => undefined,
				invoke: async (
					command: string,
					args?: {
						name?: string;
						path?: string;
						key?: string;
						value?: string;
						event?: string;
						handler?: number;
					}
				) => {
					const calls: Array<{
						command: string;
						args?: {
							name?: string;
							path?: string;
							key?: string;
							value?: string;
							event?: string;
							handler?: number;
						};
					}> = JSON.parse(sessionStorage.getItem("startup-calls") ?? "[]");
					calls.push({ command, args });
					sessionStorage.setItem("startup-calls", JSON.stringify(calls));
					if (command.startsWith("desktop_secret_")) {
						return (
							window as unknown as {
								startupSecretSlot: (
									command: string,
									args?: unknown
								) => Promise<unknown>;
							}
						).startupSecretSlot(command, args);
					}
					if (command === "list_nodes") {
						return {
							default: localStorage.getItem("proof-default-node") ?? "local",
							nodes: [
								{ name: "local", url: "http://127.0.0.1:5490", token: null },
								{
									name: "Studio Mac",
									url: "http://studio.example.test",
									token: "node-token",
								},
							],
						};
					}
					if (command === "set_default_node") {
						if (sessionStorage.getItem("hold-node-save") === "true") {
							await new Promise<void>((resolve) =>
								window.addEventListener(
									"release-startup-save",
									() => resolve(),
									{ once: true }
								)
							);
						}
						if (sessionStorage.getItem("fail-node-save") === "true") {
							sessionStorage.removeItem("fail-node-save");
							throw new Error("Node file is read-only");
						}
						localStorage.setItem("proof-default-node", String(args?.name));
						return;
					}
					if (command === "plugin:store|load") {
						return 1;
					}
					if (command === "plugin:store|get") {
						return [null, false];
					}
					if (command === "plugin:event|listen") {
						return 1;
					}
					if (command === "get_ryu_status") {
						return "running";
					}
					return null;
				},
			},
			configurable: true,
		});
	});
	let failDeviceCodeOnce = true;
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/api/auth/device/code") {
			if (failDeviceCodeOnce) {
				failDeviceCodeOnce = false;
				return route.fulfill({
					status: 503,
					body: "Sign-in temporarily unavailable",
				});
			}
			return route.fulfill({
				json: {
					device_code: "startup-device",
					user_code: "STAR-2026",
					verification_uri: "http://127.0.0.1:5490/device",
					verification_uri_complete:
						"http://127.0.0.1:5490/device?user_code=STAR-2026",
					interval: 5,
					expires_in: 900,
				},
			});
		}
		if (url.pathname === "/api/auth/device/token") {
			return route.fulfill({ json: { access_token: "token-third" } });
		}
		if (
			url.pathname === "/api/auth/get-session" &&
			route.request().headers().authorization === "Bearer token-third"
		) {
			return route.fulfill({
				json: {
					session: { userId: "user-three", token: "token-third" },
					user: {
						id: "user-three",
						name: "Third account",
						email: "three@example.test",
						isAnonymous: false,
					},
				},
			});
		}
		if (url.pathname === "/api/auth/get-session") {
			return route.fulfill({
				json: {
					session: {
						token: "token-one",
						userId: "user-one",
						expiresAt: "2099-01-01T00:00:00Z",
					},
					user: {
						id: "user-one",
						name: "First account",
						email: "one@example.test",
						isAnonymous: false,
						waitlistStatus: "approved",
					},
				},
			});
		}
		if (url.pathname === "/api/waitlist/me") {
			// Approved, so App's fail-closed waitlist gate admits the account.
			return route.fulfill({ json: { status: "approved" } });
		}
		if (url.pathname.startsWith("/api/")) {
			return route.fulfill({
				json: {
					organizations: [],
					nodes: [],
					completed: true,
					canConfigure: true,
					status: "running",
				},
			});
		}
		if (url.origin === "http://127.0.0.1:5490") {
			return route.continue();
		}
		return route.abort();
	});
	page.on("pageerror", (error) => console.error("Startup proof", error));
});
test("production bootstrap shows account and node chooser after vault and node hydration", async ({
	page,
}) => {
	await page.goto("/desktop-startup-bootstrap-proof.html");
	await expect(page.getByTestId("startup-account-step")).toBeVisible({
		timeout: 60_000,
	});
	await page.getByRole("radio", { name: /Second account/ }).click();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await expect(page.getByTestId("startup-node-step")).toBeVisible();
	await expect(
		page.getByRole("radio", { name: "Studio Mac", exact: true })
	).toBeVisible();
});

test("failed native node save keeps startup defaults unchanged and retry saves exact chosen account and node", async ({
	page,
}) => {
	await page.goto("/desktop-startup-bootstrap-proof.html");
	await expect(page.getByTestId("startup-account-step")).toBeVisible({
		timeout: 60_000,
	});
	await page.getByRole("radio", { name: /Second account/ }).click();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await page.getByRole("radio", { name: "Studio Mac", exact: true }).click();
	await page.evaluate(() => sessionStorage.setItem("fail-node-save", "true"));
	await page.getByRole("button", { name: "Open Ryu", exact: true }).click();
	await expect(
		page.getByText("Couldn't save startup choices", { exact: true })
	).toBeVisible();
	expect(
		await page.evaluate(() =>
			localStorage.getItem("ryu_startup_default_account")
		)
	).toBeNull();
	expect(
		await page.evaluate(() => localStorage.getItem("ryu_startup_default_node"))
	).toBeNull();
	await expect(
		page.getByRole("button", { name: "Open Ryu", exact: true })
	).toBeEnabled();
	await page.getByRole("button", { name: "Open Ryu", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("proof-default-node")))
		.toBe("Studio Mac");
	await expect(page.getByTestId("startup-account-step")).toBeVisible({
		timeout: 60_000,
	});
	expect(
		await page.evaluate(() =>
			JSON.parse(sessionStorage.getItem("startup-calls") ?? "[]").filter(
				(call: { command: string }) => call.command === "set_default_node"
			)
		)
	).toEqual([
		{ command: "set_default_node", args: { name: "Studio Mac" } },
		{ command: "set_default_node", args: { name: "Studio Mac" } },
	]);
	expect(sealedVault().activeUserId).toBe("user-two");
	expect(sealedVault().activeToken).toBe("token-two");
	await expectNoPlaintextVault(page);
	expect(
		await page.evaluate(() =>
			localStorage.getItem("ryu_startup_default_account")
		)
	).toBe("user-two");
	expect(
		await page.evaluate(() => localStorage.getItem("ryu_startup_default_node"))
	).toBe("Studio Mac");
});

test("Back preserves keyboard account selection and switches independently save opt-outs", async ({
	page,
}) => {
	await page.goto("/desktop-startup-bootstrap-proof.html");
	await expect(page.getByTestId("startup-account-step")).toBeVisible({
		timeout: 60_000,
	});
	await page.getByRole("radio", { name: /Second account/ }).focus();
	await page.keyboard.press("Enter");
	await page.getByRole("switch", { name: "Use as default" }).click();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await page.getByRole("radio", { name: "Studio Mac", exact: true }).click();
	await page.getByRole("switch", { name: "Use as default" }).focus();
	await page.keyboard.press("Space");
	await page.getByRole("button", { name: "Back", exact: true }).click();
	await expect(
		page.getByRole("radio", { name: /Second account/ })
	).toHaveAttribute("aria-checked", "true");
	await expect(
		page.getByRole("switch", { name: "Use as default" })
	).not.toBeChecked();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await expect(
		page.getByRole("radio", { name: "Studio Mac", exact: true })
	).toHaveAttribute("aria-checked", "true");
	await expect(
		page.getByRole("switch", { name: "Use as default" })
	).not.toBeChecked();
	await page.getByRole("button", { name: "Open Ryu", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("proof-default-node")))
		.toBe("Studio Mac");
	expect(
		await page.evaluate(() =>
			localStorage.getItem("ryu_startup_default_account")
		)
	).toBeNull();
	expect(
		await page.evaluate(() => localStorage.getItem("ryu_startup_default_node"))
	).toBeNull();
});
test("Add account retries real device authorization and preserves both existing accounts", async ({
	page,
}) => {
	const authRequests: {
		path: string;
		method: string;
		body: unknown;
		authorization: string | undefined;
	}[] = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (
			path.startsWith("/api/auth/device/") ||
			(path === "/api/auth/get-session" &&
				request.headers().authorization === "Bearer token-third")
		) {
			authRequests.push({
				path,
				method: request.method(),
				body: request.postDataJSON(),
				authorization: request.headers().authorization,
			});
		}
	});
	await page.goto("/desktop-startup-bootstrap-proof.html");
	await expect(page.getByTestId("startup-account-step")).toBeVisible({
		timeout: 60_000,
	});
	await page.getByRole("button", { name: "Add account", exact: true }).click();
	await expect(
		page.getByText("Couldn't add account", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Continue", exact: true })
	).toBeEnabled();
	await page.getByRole("button", { name: "Add account", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Continue", exact: true })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: /Add account$/ })
	).toBeDisabled();
	await expect(page.getByRole("radio", { name: /Third account/ })).toBeVisible({
		timeout: 15_000,
	});
	await expect
		.poll(() => sealedVault().accounts.map((a) => a.userId))
		.toEqual(["user-one", "user-two", "user-three"]);
	expect(sealedVault().activeUserId).toBe("user-three");
	expect(sealedVault().activeToken).toBe("token-third");
	await expectNoPlaintextVault(page);
	expect(authRequests).toEqual([
		{
			path: "/api/auth/device/code",
			method: "POST",
			body: { client_id: "ryu-desktop", scope: "openid profile email" },
			authorization: undefined,
		},
		{
			path: "/api/auth/device/code",
			method: "POST",
			body: { client_id: "ryu-desktop", scope: "openid profile email" },
			authorization: undefined,
		},
		{
			path: "/api/auth/device/token",
			method: "POST",
			body: {
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: "startup-device",
				client_id: "ryu-desktop",
			},
			authorization: undefined,
		},
		{
			path: "/api/auth/get-session",
			method: "GET",
			body: null,
			authorization: "Bearer token-third",
		},
	]);
	await expect(
		page.getByText("Couldn't add account", { exact: true })
	).toBeHidden({ timeout: 15_000 });
	await expect(page.getByText("Account added", { exact: true })).toBeHidden({
		timeout: 15_000,
	});
	mkdirSync(proofDir, { recursive: true });
	await page.getByTestId("desktop-startup-chooser").screenshot({
		path: resolve(proofDir, "startup-account-added.png"),
		animations: "disabled",
	});
	await expect(
		page.getByRole("radio", { name: /Third account/ })
	).toHaveAttribute("aria-checked", "true");
});

test("pending native save locks node and default edits until relaunch", async ({
	page,
}) => {
	await page.goto("/desktop-startup-bootstrap-proof.html");
	await expect(page.getByTestId("startup-account-step")).toBeVisible({
		timeout: 60_000,
	});
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await page.getByRole("radio", { name: "Studio Mac", exact: true }).click();
	await page.evaluate(() => sessionStorage.setItem("hold-node-save", "true"));
	await page.getByRole("button", { name: "Open Ryu", exact: true }).click();
	await expect(page.getByRole("button", { name: /^Open Ryu/ })).toBeDisabled();
	await expect(
		page.getByRole("radio", { name: "local", exact: true })
	).toBeDisabled();
	await expect(
		page.getByRole("switch", { name: "Use as default" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Back", exact: true })
	).toBeDisabled();
	await Promise.all([
		page.waitForEvent("load"),
		page.evaluate(() => {
			sessionStorage.removeItem("hold-node-save");
			window.dispatchEvent(new Event("release-startup-save"));
		}),
	]);
	expect(
		await page.evaluate(() => localStorage.getItem("proof-default-node"))
	).toBe("Studio Mac");
});
