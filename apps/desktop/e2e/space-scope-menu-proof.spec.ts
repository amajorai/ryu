import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { type ProofJsonRecord, parseProofJsonRecord } from "./fixture-json.ts";

const PROOF_URL = "/space-scope-menu-proof.html";
const SPACE_ID = "space-scope-proof";
const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

async function openFreshProof(page: Page, scenario?: "restricted" | "system") {
	const query = scenario ? `?scenario=${scenario}` : "";
	await page.goto(`${PROOF_URL}${query}`);
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await expect(page.getByTestId("space-name")).toHaveText("Synthetic Space");
}

async function openSpaceMenu(page: Page) {
	await page.getByRole("button", { name: "Synthetic Space options" }).click();
	await expect(
		page.getByRole("menuitem", { name: "Add files to this space…" })
	).toBeVisible();
}

test.describe("Desktop Space scope menu", () => {
	test("opens the add-files dialog for the selected Space and uploads a picked file through the Core client with retry and reload", async ({
		page,
	}) => {
		await openFreshProof(page);
		const uploadBodies: ProofJsonRecord[] = [];
		let attempt = 0;
		await page.route(`**/api/spaces/${SPACE_ID}/files`, async (route) => {
			attempt += 1;
			uploadBodies.push(
				parseProofJsonRecord(route.request().postData() ?? "{}")
			);
			if (attempt === 1) {
				await route.fulfill({
					body: JSON.stringify({ error: "fixture upload paused" }),
					contentType: "application/json",
					status: 503,
				});
				return;
			}
			await route.fulfill({
				body: JSON.stringify({
					byte_size: Buffer.byteLength("synthetic space note"),
					id: "document-proof-1",
					index: { state: "indexed", warnings: [] },
					mime: "text/plain",
				}),
				contentType: "application/json",
				status: 200,
			});
		});

		await openSpaceMenu(page);
		await page
			.getByRole("menuitem", { name: "Add files to this space…" })
			.click();
		const dialog = page.getByRole("dialog", { name: "Add to Synthetic Space" });
		await expect(dialog).toBeVisible();
		await dialog.locator('input[type="file"]').setInputFiles({
			buffer: Buffer.from("synthetic space note"),
			mimeType: "text/plain",
			name: "space-note.txt",
		});
		await expect(dialog.getByText("fixture upload paused")).toBeVisible();
		await dialog.getByRole("button", { name: "Retry space-note.txt" }).click();
		await expect(dialog.getByText("Stored and searchable")).toBeVisible();
		await expect(page.getByTestId("document-count")).toHaveText("1");
		await expect(page.getByTestId("reload-count")).toHaveText("2");
		expect(uploadBodies).toEqual([
			{
				data_base64: Buffer.from("synthetic space note").toString("base64"),
				mime: "text/plain",
				title: "space-note.txt",
			},
			{
				data_base64: Buffer.from("synthetic space note").toString("base64"),
				mime: "text/plain",
				title: "space-note.txt",
			},
		]);
		await page.screenshot({
			animations: "disabled",
			fullPage: true,
			path: path.join(EVIDENCE_DIR, "desktop-space-scope-upload-indexed.png"),
		});

		await page.reload();
		await expect(page.getByTestId("document-count")).toHaveText("1");
		await expect(page.getByTestId("reload-count")).toHaveText("2");
	});

	test("opens the Space in the current tab, a new tab, and a native window using the exact route and IPC payload", async ({
		page,
	}) => {
		await openFreshProof(page);
		await openSpaceMenu(page);
		await page.screenshot({
			animations: "disabled",
			fullPage: true,
			path: path.join(EVIDENCE_DIR, "desktop-space-scope-menu-open.png"),
		});
		await page.getByRole("menuitem", { name: "Open space page" }).click();
		await expect(page.getByTestId("navigation-path")).toHaveText(
			`/spaces/${SPACE_ID}`
		);
		await expect(page.getByTestId("tabs-state")).toContainText(
			`"title":"Synthetic Space"`
		);

		await openSpaceMenu(page);
		await page.getByRole("menuitem", { name: "Open in new tab" }).click();
		const tabs = z
			.array(z.object({ id: z.string(), path: z.string(), title: z.string() }))
			.parse(
				JSON.parse((await page.getByTestId("tabs-state").textContent()) ?? "[]")
			);
		expect(tabs).toHaveLength(2);
		expect(tabs[1]).toMatchObject({
			id: "proof-tab-2",
			path: `/spaces/${SPACE_ID}`,
			title: "Synthetic Space",
		});

		await openSpaceMenu(page);
		await page.getByRole("menuitem", { name: "Open in new window" }).click();
		const calls = await page.evaluate(() => {
			const host =
				/* SAFETY: This fixture initialization defines __SPACE_SCOPE_TAURI_CALLS__ on its own browser window. */ window as Window & {
					__SPACE_SCOPE_TAURI_CALLS__?: unknown[][];
				};
			return host.__SPACE_SCOPE_TAURI_CALLS__ ?? [];
		});
		const openWindowCalls = calls.filter(
			(call) => call[0] === "open_tab_window"
		);
		expect(openWindowCalls).toHaveLength(1);
		expect(openWindowCalls[0]?.[1]).toEqual({
			conversationId: null,
			entityKey: null,
			node: null,
			path: `/spaces/${SPACE_ID}`,
			title: "Synthetic Space",
		});
		await page.reload();
		await expect(page.getByTestId("navigation-path")).toHaveText(
			`/spaces/${SPACE_ID}`
		);
		await expect(page.getByTestId("tabs-state")).toContainText(
			`"id":"proof-tab-2"`
		);
	});

	test("changes the Space icon through the production picker and persists the exact icon request", async ({
		page,
	}) => {
		await openFreshProof(page);
		const iconBodies: ProofJsonRecord[] = [];
		await page.route("https://api.iconify.design/**", async (route) => {
			const url = new URL(route.request().url());
			if (url.pathname === "/search") {
				await route.fulfill({
					json: { icons: ["lucide:house"] },
					status: 200,
				});
				return;
			}
			if (url.pathname.endsWith(".svg")) {
				await route.fulfill({
					body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 10 12 3l9 7v10h-6v-6H9v6H3z"/></svg>',
					contentType: "image/svg+xml",
					status: 200,
				});
				return;
			}
			await route.fulfill({
				json: { categories: { starter: ["house"] } },
				status: 200,
			});
		});
		await page.route(`**/api/spaces/${SPACE_ID}/icon`, async (route) => {
			iconBodies.push(parseProofJsonRecord(route.request().postData() ?? "{}"));
			await route.fulfill({ status: 204, body: "" });
		});

		await openSpaceMenu(page);
		await page.getByRole("menuitem", { name: "Change icon…" }).click();
		const dialog = page.getByRole("dialog", { name: "Space icon" });
		await expect(dialog).toBeVisible();
		await dialog.getByRole("tab", { name: "Icon" }).click();
		await dialog.getByRole("textbox", { name: "Search icons" }).fill("house");
		await dialog.getByRole("button", { name: "lucide:house" }).click();
		await dialog.getByRole("button", { name: "Use icon" }).click();
		await expect(page.getByTestId("space-icon")).toHaveText(
			'{"kind":"icon","id":"lucide:house"}'
		);
		expect(iconBodies).toEqual([
			{ icon: { kind: "icon", id: "lucide:house" } },
		]);
		await page.screenshot({
			animations: "disabled",
			fullPage: true,
			path: path.join(EVIDENCE_DIR, "desktop-space-scope-icon-saved.png"),
		});
		await page.reload();
		await expect(page.getByTestId("space-icon")).toHaveText(
			'{"kind":"icon","id":"lucide:house"}'
		);
	});

	test("validates and renames with trimmed input, keeps the dialog open on server error, then saves and restores", async ({
		page,
	}) => {
		await openFreshProof(page);
		const renameBodies: ProofJsonRecord[] = [];
		let failFirstRename = true;
		await page.route(`**/api/spaces/${SPACE_ID}/name`, async (route) => {
			renameBodies.push(
				parseProofJsonRecord(route.request().postData() ?? "{}")
			);
			if (failFirstRename) {
				failFirstRename = false;
				await route.fulfill({
					body: JSON.stringify({ error: "fixture name conflict" }),
					contentType: "application/json",
					status: 409,
				});
				return;
			}
			await route.fulfill({ status: 204, body: "" });
		});

		await openSpaceMenu(page);
		await page.getByRole("menuitem", { name: "Rename space" }).click();
		const dialog = page.getByRole("dialog", { name: "Rename space" });
		const nameInput = dialog.getByRole("textbox", { name: "Name" });
		await nameInput.fill("   ");
		await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
		await expect(dialog.getByText("Enter a name for this space.")).toHaveCount(
			0
		);

		await nameInput.fill("  Updated Research  ");
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(
			dialog.getByText("/api/spaces/space-scope-proof/name failed: 409")
		).toBeVisible();
		await expect(nameInput).toHaveValue("  Updated Research  ");
		await nameInput.fill("  Updated Research  ");
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByTestId("space-name")).toHaveText("Updated Research");
		expect(renameBodies).toEqual([
			{ name: "Updated Research" },
			{ name: "Updated Research" },
		]);
		await page.screenshot({
			animations: "disabled",
			fullPage: true,
			path: path.join(EVIDENCE_DIR, "desktop-space-scope-renamed.png"),
		});
		await page.reload();
		await expect(page.getByTestId("space-name")).toHaveText("Updated Research");
	});

	test("requests team visibility changes with exact resource identity, confirms them, and restores them after reload", async ({
		page,
	}) => {
		await openFreshProof(page);
		const visibilityBodies: ProofJsonRecord[] = [];
		await page.route(`**/api/spaces/${SPACE_ID}/visibility`, async (route) => {
			visibilityBodies.push(
				parseProofJsonRecord(route.request().postData() ?? "{}")
			);
			await route.fulfill({ status: 204, body: "" });
		});

		await openSpaceMenu(page);
		await page.getByRole("menuitem", { name: "Share with team" }).click();
		const shareDialog = page.getByRole("alertdialog", {
			name: "Share with your team?",
		});
		await expect(shareDialog).toContainText(
			'"Synthetic Space" will become visible'
		);
		await shareDialog.getByRole("button", { name: "Share with team" }).click();
		await expect(shareDialog).toBeHidden();
		await expect(page.getByTestId("space-visibility")).toHaveText("org");

		await openSpaceMenu(page);
		await page.getByRole("menuitem", { name: "Make private" }).click();
		const privateDialog = page.getByRole("alertdialog", {
			name: "Make this private?",
		});
		await privateDialog.getByRole("button", { name: "Make private" }).click();
		await expect(privateDialog).toBeHidden();
		await expect(page.getByTestId("space-visibility")).toHaveText("private");
		expect(visibilityBodies).toEqual([
			{ visibility: "org" },
			{ visibility: "private" },
		]);
		await page.reload();
		await expect(page.getByTestId("space-visibility")).toHaveText("private");
	});

	test("dispatches contributed Space actions and accurately disables deletion and privacy controls for restricted members", async ({
		page,
	}) => {
		await openFreshProof(page, "restricted");
		await openSpaceMenu(page);
		await page
			.getByRole("menuitem", { name: "Open fixture collection" })
			.click();
		await expect(page.getByTestId("plugin-action")).toHaveText(
			`space:${SPACE_ID}:open-collection`
		);

		await openSpaceMenu(page);
		const privateAction = page.getByRole("menuitem", {
			name: "Make private (admins only)",
		});
		await expect(privateAction).toBeDisabled();
		const deleteAction = page.getByRole("menuitem", {
			name: "Delete space",
		});
		await expect(deleteAction).toBeDisabled();
		await deleteAction.locator("xpath=..").hover();
		await expect(
			page.getByText(
				"Only organization members with Space delete permission can delete Spaces."
			)
		).toBeVisible();
		await expect(
			page.getByRole("menuitem", { name: "Rename space" })
		).toBeVisible();
	});

	test("keeps system Spaces non-renamable and non-deletable, then supports delete cancel, retry, confirm, and reload", async ({
		page,
	}) => {
		await openFreshProof(page, "system");
		await openSpaceMenu(page);
		await expect(
			page.getByRole("menuitem", { name: "Rename space" })
		).toHaveCount(0);
		const protectedDelete = page.getByRole("menuitem", {
			name: "Delete space",
		});
		await expect(protectedDelete).toBeDisabled();
		await protectedDelete.locator("xpath=..").hover();
		await expect(
			page.getByText(
				"System spaces can't be deleted — Ryu creates and maintains this one."
			)
		).toBeVisible();
		await page.keyboard.press("Escape");

		await openFreshProof(page);
		await page.emulateMedia({ reducedMotion: "reduce" });
		const deleteRequests: Array<{ method: string; body: string | null }> = [];
		let failFirstDelete = true;
		await page.route(`**/api/spaces/${SPACE_ID}`, async (route) => {
			deleteRequests.push({
				body: route.request().postData(),
				method: route.request().method(),
			});
			if (failFirstDelete) {
				failFirstDelete = false;
				await route.fulfill({
					body: JSON.stringify({ error: "fixture delete unavailable" }),
					contentType: "application/json",
					status: 503,
				});
				return;
			}
			await route.fulfill({
				body: JSON.stringify({ removed: true }),
				contentType: "application/json",
				status: 200,
			});
		});

		await openSpaceMenu(page);
		await page.getByRole("menuitem", { name: "Delete space" }).click();
		const dialog = page.getByRole("alertdialog", {
			name: "Delete this Space?",
		});
		await expect(dialog).toContainText(
			'"Synthetic Space" and all its documents'
		);
		await page.screenshot({
			animations: "disabled",
			fullPage: true,
			path: path.join(
				EVIDENCE_DIR,
				"desktop-space-scope-delete-confirmation.png"
			),
		});
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog).toBeHidden();
		expect(deleteRequests).toHaveLength(0);
		await expect(page.getByTestId("space-name")).toHaveText("Synthetic Space");

		await openSpaceMenu(page);
		await page.getByRole("menuitem", { name: "Delete space" }).click();
		const confirmDialog = page.getByRole("alertdialog", {
			name: "Delete this Space?",
		});
		const blade = confirmDialog.getByRole("slider", {
			name: "Delete Synthetic Space",
		});
		await blade.focus();
		for (let step = 0; step < 5; step += 1) {
			await blade.press("ArrowRight");
		}
		await expect(page.getByTestId("last-error")).toContainText(
			"/api/spaces/space-scope-proof failed: 503"
		);
		await expect(blade).toHaveAttribute("aria-valuenow", "0");
		await expect(confirmDialog).toBeVisible();
		await blade.focus();
		for (let step = 0; step < 5; step += 1) {
			await blade.press("ArrowRight");
		}
		await expect(confirmDialog).toBeHidden();
		await expect(page.getByTestId("space-name")).toHaveText("deleted");
		expect(deleteRequests).toEqual([
			{ body: null, method: "DELETE" },
			{ body: null, method: "DELETE" },
		]);
		await page.reload();
		await expect(page.getByTestId("space-deleted")).toBeVisible();
	});
});
