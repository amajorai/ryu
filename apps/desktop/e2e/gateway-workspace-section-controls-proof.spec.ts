import { expect, test } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { type ProofJsonValue, parseProofJson } from "./fixture-json.ts";

interface WorkspaceRoleSnapshot {
	requests: Array<{
		body: unknown;
		method: string;
		path: string;
	}>;
	server: {
		roles: Array<{
			builtin: boolean;
			key: string;
			name: string;
			permissions: string[];
		}>;
	};
	stepUpScopes: string[];
}

declare global {
	interface Window {
		__GATEWAY_WORKSPACE_PROOF__?: {
			snapshot: () => WorkspaceRoleSnapshot;
		};
		__RELEASE_WORKSPACE_ROLE_WRITE__?: () => void;
		__WORKSPACE_ROLE_WRITE_ATTEMPTS__?: Array<{
			body: unknown;
			method: string;
			path: string;
		}>;
	}
}

const browserIssues = new WeakMap<import("@playwright/test").Page, string[]>();

test.beforeEach(async ({ page }) => {
	const issues: string[] = [];
	browserIssues.set(page, issues);
	page.on("console", (message) => {
		if (message.type() === "warning" || message.type() === "error") {
			issues.push(`${message.type()}: ${message.text()}`);
		}
	});
	page.on("pageerror", (error) => issues.push(`pageerror: ${error.message}`));
});

test.afterEach(async ({ page }) => {
	expect(browserIssues.get(page) ?? []).toEqual([]);
});

async function screenshot(
	page: import("@playwright/test").Page,
	name: string,
	fullPage = false
): Promise<void> {
	await page.screenshot({
		fullPage,
		path: test.info().outputPath(`${name}.png`),
	});
}

async function openWorkspace(
	page: import("@playwright/test").Page,
	query = ""
): Promise<void> {
	await page.goto(`/gateway-workspace-members-proof.html${query}`);
	await expect(page).toHaveURL(/\/gateway-workspace-members-proof\.html/);
	await expect(page).toHaveTitle("Ryu Gateway workspace members proof");
	await expect(page.locator("vite-error-overlay")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "New role" })).toBeVisible();
}

async function readProof(
	page: import("@playwright/test").Page
): Promise<WorkspaceRoleSnapshot> {
	return page.evaluate(() => {
		const proof = window.__GATEWAY_WORKSPACE_PROOF__;
		if (!proof) {
			throw new Error("Workspace proof fixture is missing.");
		}
		return proof.snapshot();
	});
}

test.describe.configure({ timeout: 90_000 });

test("role form validates drafts, and Cancel closes and resets them without a write", async ({
	page,
}) => {
	await openWorkspace(page);
	await page.getByRole("button", { name: "New role" }).click();
	const dialog = page.getByRole("dialog");
	const nameInput = dialog.getByLabel("Name");
	const keyInput = dialog.getByLabel("Key");

	await dialog.getByRole("button", { name: "Create role" }).click();
	await expect(dialog.getByText("Name is required.")).toBeVisible();
	await nameInput.fill("Draft role");
	await keyInput.fill("Draft Role");
	await dialog.getByRole("checkbox", { name: "workflow.run" }).check();
	await dialog.getByRole("button", { name: "Create role" }).click();
	await expect(
		dialog.getByText("Key must be kebab-case (letters, digits, single dashes).")
	).toBeVisible();
	await expect(nameInput).toHaveValue("Draft role");
	await expect(keyInput).toHaveValue("Draft Role");
	await expect(
		dialog.getByRole("checkbox", { name: "workflow.run" })
	).toBeChecked();
	await screenshot(page, "workspace-role-form-validation");

	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	await page.getByRole("button", { name: "New role" }).click();
	const reopenedDialog = page.getByRole("dialog");
	await expect(reopenedDialog.getByLabel("Name")).toHaveValue("");
	await expect(reopenedDialog.getByLabel("Key")).toHaveValue("");
	await expect(
		reopenedDialog.getByRole("checkbox", { name: "workflow.run" })
	).not.toBeChecked();
	await expect(reopenedDialog.getByText("Name is required.")).toHaveCount(0);

	const writes = (await readProof(page)).requests.filter(
		(request) =>
			request.method === "POST" &&
			request.path === "/api/control-plane/orgs/org-atlas/roles"
	);
	expect(writes).toEqual([]);
});

test("role save locks the draft while pending, preserves it after failure, and reads back on retry", async ({
	page,
}) => {
	await openWorkspace(page);
	await page.evaluate(() => {
		const originalFetch = window.fetch.bind(window);
		let failFirstWrite = true;
		window.__WORKSPACE_ROLE_WRITE_ATTEMPTS__ = [];
		window.fetch = async (input, init) => {
			const rawUrl = input instanceof Request ? input.url : String(input);
			const url = new URL(rawUrl, window.location.href);
			const method = (
				init?.method ?? (input instanceof Request ? input.method : "GET")
			).toUpperCase();
			if (
				method === "POST" &&
				url.pathname === "/api/control-plane/orgs/org-atlas/roles"
			) {
				let body: ProofJsonValue = null;
				if (isNativeText(init?.body)) {
					body = parseProofJson(init.body);
				}
				window.__WORKSPACE_ROLE_WRITE_ATTEMPTS__?.push({
					body,
					method,
					path: `${url.pathname}${url.search}`,
				});
				if (failFirstWrite) {
					failFirstWrite = false;
					await new Promise<void>((resolve) => {
						window.__RELEASE_WORKSPACE_ROLE_WRITE__ = resolve;
					});
					return new Response(
						JSON.stringify({ message: "role service temporarily unavailable" }),
						{
							headers: { "content-type": "application/json" },
							status: 503,
						}
					);
				}
			}
			return originalFetch(input, init);
		};
	});

	await page.getByRole("button", { name: "New role" }).click();
	const dialog = page.getByRole("dialog");
	const nameInput = dialog.getByLabel("Name");
	const keyInput = dialog.getByLabel("Key");
	const permissionCheckbox = dialog.getByRole("checkbox", {
		name: "workflow.run",
	});
	await nameInput.fill("Case reviewer");
	await keyInput.fill("case-reviewer");
	await permissionCheckbox.check();

	const submit = dialog.getByRole("button", { name: "Create role" });
	await submit.click();
	await expect
		.poll(async () =>
			page.evaluate(() => window.__WORKSPACE_ROLE_WRITE_ATTEMPTS__?.length ?? 0)
		)
		.toBe(1);
	try {
		await expect(submit).toBeDisabled();
		await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);
		await expect(nameInput).toBeDisabled();
		await expect(keyInput).toBeDisabled();
		await expect(permissionCheckbox).toBeDisabled();
		await page.keyboard.press("Escape");
		await expect(dialog).toBeVisible();
		await screenshot(page, "workspace-role-save-pending");
	} finally {
		await page.evaluate(() => window.__RELEASE_WORKSPACE_ROLE_WRITE__?.());
	}

	await expect(dialog.getByText("Request failed: 503")).toBeVisible();
	await expect(dialog).toBeVisible();
	await expect(nameInput).toHaveValue("Case reviewer");
	await expect(keyInput).toHaveValue("case-reviewer");
	await expect(permissionCheckbox).toBeChecked();
	await expect(submit).toBeEnabled();
	await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
	await screenshot(page, "workspace-role-save-error");

	await submit.click();
	await expect(
		page.getByRole("columnheader", { name: /Case reviewer/ })
	).toBeVisible();
	await expect(dialog).toHaveCount(0);

	const attempts = await page.evaluate(
		() => window.__WORKSPACE_ROLE_WRITE_ATTEMPTS__ ?? []
	);
	expect(attempts).toEqual([
		{
			body: {
				key: "case-reviewer",
				name: "Case reviewer",
				permissions: ["workflow.run"],
			},
			method: "POST",
			path: "/api/control-plane/orgs/org-atlas/roles",
		},
		{
			body: {
				key: "case-reviewer",
				name: "Case reviewer",
				permissions: ["workflow.run"],
			},
			method: "POST",
			path: "/api/control-plane/orgs/org-atlas/roles",
		},
	]);

	const proof = await readProof(page);
	expect(
		proof.server.roles.find((role) => role.key === "case-reviewer")
	).toEqual({
		builtin: false,
		key: "case-reviewer",
		name: "Case reviewer",
		permissions: ["workflow.run"],
	});
	expect(proof.stepUpScopes).toEqual(["org.members", "org.members"]);
	await page.reload();
	await expect(
		page.getByRole("columnheader", { name: /Case reviewer/ })
	).toBeVisible();
	const readback = await readProof(page);
	expect(
		readback.server.roles.find((role) => role.key === "case-reviewer")
	).toEqual({
		builtin: false,
		key: "case-reviewer",
		name: "Case reviewer",
		permissions: ["workflow.run"],
	});
	await screenshot(page, "workspace-role-save-readback", true);
});

test("permission matrix remains read-only while role editing is permission-gated", async ({
	page,
}) => {
	await page.goto("/gateway-workspace-members-proof.html?readOnly=1");
	await expect(page).toHaveURL(
		/\/gateway-workspace-members-proof\.html\?readOnly=1/
	);
	await expect(page).toHaveTitle("Ryu Gateway workspace members proof");
	await expect(page.locator("vite-error-overlay")).toHaveCount(0);
	const matrix = page.getByRole("table");
	await expect(matrix).toBeVisible();
	const cells = matrix.getByRole("checkbox");
	await expect(cells.first()).toBeDisabled();
	await expect(cells.last()).toBeDisabled();
	await expect(page.getByRole("button", { name: "New role" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /^Edit / })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /^Delete / })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Roles" })).toHaveCount(0);
	await screenshot(page, "workspace-role-permission-matrix-read-only", true);
});
