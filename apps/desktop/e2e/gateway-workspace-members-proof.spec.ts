import path from "node:path";
import { expect, test } from "@playwright/test";

interface WorkspaceProofSnapshot {
	assignmentWriteResults: Array<"failed" | "saved">;
	requests: Array<{
		body: unknown;
		headers: Record<string, string>;
		method: string;
		path: string;
	}>;
	server: {
		activeOrganizationId: string;
		activeTeamId: string | null;
		assignments: Record<string, string[]>;
		members: Array<{ role: string; userId: string }>;
		organizations: Array<{ id: string; name: string; role: string }>;
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
		__GATEWAY_WORKSPACE_EXTERNAL_URLS__?: string[];
		__GATEWAY_WORKSPACE_PROOF__?: {
			snapshot: () => WorkspaceProofSnapshot;
		};
	}
}

function evidencePath(name: string): string {
	// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
	// the tracked proof ledger; without it the committed evidence is refreshed.
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	if (override) {
		return path.join(override, `${name}.png`);
	}
	return path.resolve(
		import.meta.dirname,
		`../../../docs/proof/test-coverage-sweep-20260924/evidence/${name}.png`
	);
}

async function readProof(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const proof = window.__GATEWAY_WORKSPACE_PROOF__;
		if (!proof) {
			throw new Error("Workspace proof fixture is missing.");
		}
		return proof.snapshot();
	});
}

async function openWorkspace(
	page: import("@playwright/test").Page,
	query = ""
): Promise<void> {
	await page.goto(`/gateway-workspace-members-proof.html${query}`);
	await expect(
		page.getByRole("heading", { exact: true, name: "Workspace" })
	).toBeVisible();
}

test.describe.configure({ timeout: 90_000 });

test("uses the session workspace and persists team, custom role, and member assignment changes", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await openWorkspace(page);

	await expect(
		page.getByText("Atlas Research", { exact: false })
	).toBeVisible();
	await expect(
		page.getByText("Mira’s personal workspace", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("user-owner", { exact: true }).first()
	).toBeVisible();
	await expect(
		page.getByText("user-collab", { exact: true }).first()
	).toBeVisible();
	await expect(
		page.getByText("user-viewer", { exact: true }).first()
	).toBeVisible();
	await expect(
		page
			.locator('[data-slot="item"]')
			.filter({ hasText: "user-collab" })
			.getByText("Workflow editor", { exact: true })
	).toBeVisible();
	const firstReads = await readProof(page);
	expect(
		firstReads.requests.some(
			(request) =>
				request.method === "GET" &&
				request.path === "/api/control-plane/orgs/org-atlas/members"
		),
		"the active session organization, not the first listed organization, scopes the roster"
	).toBe(true);
	expect(
		firstReads.requests.some(
			(request) =>
				request.method === "GET" &&
				request.path === "/api/control-plane/orgs/org-personal/members"
		)
	).toBe(false);

	const memberRow = page
		.locator('[data-slot="item"]')
		.filter({ hasText: "user-collab" });
	await memberRow.getByRole("button", { name: "Roles" }).click();
	await expect(
		page.getByRole("checkbox", { name: "Workflow editor" })
	).toBeChecked();

	const teamSelect = page.getByRole("combobox", { name: "Active team" });
	await teamSelect.click();
	await page.getByRole("option", { name: "Design" }).click();
	await expect(teamSelect).toContainText("Design");
	let saved = await readProof(page);
	expect(saved.server.activeTeamId).toBe("team-design");
	expect(
		saved.requests.some(
			(request) =>
				request.method === "POST" &&
				request.path === "/api/auth/organization/set-active-team" &&
				JSON.stringify(request.body) ===
					JSON.stringify({ teamId: "team-design" })
		),
		"team selection sends the Better Auth set-active-team payload"
	).toBe(true);

	await page.getByRole("button", { name: "New role" }).click();
	const createDialog = page.getByRole("dialog");
	await createDialog.getByLabel("Name").fill("Case reviewer");
	await createDialog.getByLabel("Key").fill("case-reviewer");
	await createDialog.getByRole("checkbox", { name: "workflow.run" }).check();
	await createDialog.getByRole("button", { name: "Create role" }).click();
	await expect(
		page.getByRole("columnheader", { name: /Case reviewer/ })
	).toBeVisible();

	saved = await readProof(page);
	const createRequest = saved.requests.find(
		(request) =>
			request.method === "POST" &&
			request.path === "/api/control-plane/orgs/org-atlas/roles"
	);
	expect(createRequest?.body).toEqual({
		key: "case-reviewer",
		name: "Case reviewer",
		permissions: ["workflow.run"],
	});
	expect(
		saved.server.roles.find((role) => role.key === "case-reviewer")
	).toEqual({
		builtin: false,
		key: "case-reviewer",
		name: "Case reviewer",
		permissions: ["workflow.run"],
	});

	await page.getByRole("button", { name: "Edit Case reviewer" }).click();
	const editDialog = page.getByRole("dialog");
	await editDialog.getByLabel("Name").fill("Case operations");
	await editDialog.getByRole("checkbox", { name: "gateway.configure" }).check();
	await editDialog.getByRole("button", { name: "Save" }).click();
	await expect(
		page.getByRole("columnheader", { name: /Case operations/ })
	).toBeVisible();

	const updated = await readProof(page);
	const updateRequest = updated.requests.find(
		(request) =>
			request.method === "PUT" &&
			request.path === "/api/control-plane/orgs/org-atlas/roles/case-reviewer"
	);
	expect(updateRequest?.body).toEqual({
		name: "Case operations",
		permissions: ["workflow.run", "gateway.configure"],
	});
	expect(
		updated.server.roles.find((role) => role.key === "case-reviewer")?.name
	).toBe("Case operations");

	await memberRow.getByRole("button", { name: "Roles" }).click();
	await page.getByRole("checkbox", { name: "Case operations" }).click();
	await expect(
		memberRow.getByText("Case operations", { exact: true })
	).toBeVisible();
	saved = await readProof(page);
	expect(saved.server.assignments["user-collab"]).toEqual([
		"workflow-editor",
		"case-reviewer",
	]);
	expect(
		saved.requests.find(
			(request) =>
				request.method === "PUT" &&
				request.path ===
					"/api/control-plane/orgs/org-atlas/members/user-collab/roles"
		)?.body
	).toEqual({ roleKeys: ["workflow-editor", "case-reviewer"] });
	expect(saved.stepUpScopes).toEqual([
		"org.members",
		"org.members",
		"org.members",
	]);

	await page.reload();
	await expect(
		page.getByRole("combobox", { name: "Active team" })
	).toContainText("Design");
	await expect(
		page.getByRole("columnheader", { name: /Case operations/ })
	).toBeVisible();
	const reloadedMemberRow = page
		.locator('[data-slot="item"]')
		.filter({ hasText: "user-collab" });
	await expect(
		reloadedMemberRow.getByText("Workflow editor", { exact: true })
	).toBeVisible();
	await expect(
		reloadedMemberRow.getByText("Case operations", { exact: true })
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: evidencePath("gateway-workspace-members-persisted"),
	});

	await page.getByRole("button", { name: "Delete Case operations" }).click();
	await expect(
		page.getByRole("columnheader", { name: /Case operations/ })
	).toHaveCount(0);
	saved = await readProof(page);
	expect(
		saved.requests.some(
			(request) =>
				request.method === "DELETE" &&
				request.path === "/api/control-plane/orgs/org-atlas/roles/case-reviewer"
		)
	).toBe(true);
	expect(saved.server.assignments["user-collab"]).toEqual(["workflow-editor"]);
	expect(saved.stepUpScopes).toContain("org.members");

	await page.getByRole("button", { name: "Manage members" }).click();
	const externalUrls = await page.evaluate(
		() => window.__GATEWAY_WORKSPACE_EXTERNAL_URLS__ ?? []
	);
	const origin = await page.evaluate(() => window.location.origin);
	expect(externalUrls).toEqual([`${origin}/organizations`]);

	expect(errors).toEqual([]);
});

test("shows persisted roles as read-only without roles.manage", async ({
	page,
}) => {
	await openWorkspace(page, "?readOnly=1");
	const currentUserRow = page
		.locator('[data-slot="item"]')
		.filter({ hasText: "user-owner" });
	await expect(
		currentUserRow.getByText("viewer", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Workflow editor", { exact: true }).first()
	).toBeVisible();
	await expect(page.getByRole("button", { name: "New role" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /^Edit / })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /^Delete / })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Roles" })).toHaveCount(0);
	const proof = await readProof(page);
	expect(
		proof.requests.some(
			(request) =>
				request.path === "/api/control-plane/me/permissions?orgId=org-atlas"
		)
	).toBe(true);
	await page.screenshot({
		fullPage: true,
		path: evidencePath("gateway-workspace-members-read-only"),
	});
});

test("renders organization and roster loading states before showing their fetched values", async ({
	page,
}) => {
	await page.goto("/gateway-workspace-members-proof.html?delayOrgs=1");
	await expect(
		page.getByRole("heading", { exact: true, name: "Workspace" })
	).toBeVisible();
	await expect(
		page.getByRole("status", { exact: true, name: "Loading" })
	).toHaveCount(1);
	await expect(
		page.getByText("Atlas Research", { exact: false })
	).toBeVisible();

	await page.goto("/gateway-workspace-members-proof.html?delayMembers=1");
	await expect(
		page.getByRole("heading", { exact: true, name: "Members" })
	).toBeVisible();
	await expect(
		page.getByRole("status", { exact: true, name: "Loading" })
	).toHaveCount(1);
	await expect(
		page.getByText("user-collab", { exact: true }).first()
	).toBeVisible();
});

test("renders a real personal-workspace empty state when there are no organizations", async ({
	page,
}) => {
	await openWorkspace(page, "?emptyOrgs=1");
	await expect(page.getByText("Personal", { exact: true })).toBeVisible();
	await expect(
		page.getByText("You are not in an organization yet.", { exact: false })
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Members" })).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Roles" })).toHaveCount(0);
});

test("renders the actual no-member state while keeping web member management available", async ({
	page,
}) => {
	await openWorkspace(page, "?emptyMembers=1");
	await expect(
		page.getByText("No members yet.", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Manage members" })
	).toBeVisible();
	await page.getByRole("button", { name: "Manage members" }).click();
	const externalUrls = await page.evaluate(
		() => window.__GATEWAY_WORKSPACE_EXTERNAL_URLS__ ?? []
	);
	const origin = await page.evaluate(() => window.location.origin);
	expect(externalUrls).toEqual([`${origin}/organizations`]);
});

test("keeps a saved role assignment after a write failure and retries the exact replacement", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openWorkspace(page, "?failAssignmentOnce=1");
	const memberRow = page
		.locator('[data-slot="item"]')
		.filter({ hasText: "user-collab" });
	await memberRow.getByRole("button", { name: "Roles" }).click();
	const assignment = page.getByRole("checkbox", { name: "Workflow editor" });
	await expect(assignment).toBeChecked();
	await assignment.click();
	await expect
		.poll(async () => (await readProof(page)).assignmentWriteResults.length)
		.toBe(1);
	await expect(assignment).toBeChecked();
	let saved = await readProof(page);
	expect(saved.assignmentWriteResults).toEqual(["failed"]);
	expect(saved.server.assignments["user-collab"]).toEqual(["workflow-editor"]);
	expect(
		saved.requests
			.filter(
				(request) =>
					request.method === "PUT" &&
					request.path ===
						"/api/control-plane/orgs/org-atlas/members/user-collab/roles"
			)
			.map((request) => request.body)
	).toEqual([{ roleKeys: [] }]);

	await assignment.click();
	await expect
		.poll(async () => (await readProof(page)).assignmentWriteResults.length)
		.toBe(2);
	await expect(assignment).not.toBeChecked();
	saved = await readProof(page);
	expect(saved.assignmentWriteResults).toEqual(["failed", "saved"]);
	expect(saved.server.assignments["user-collab"]).toEqual([]);
	expect(
		saved.requests
			.filter(
				(request) =>
					request.method === "PUT" &&
					request.path ===
						"/api/control-plane/orgs/org-atlas/members/user-collab/roles"
			)
			.map((request) => request.body)
	).toEqual([{ roleKeys: [] }, { roleKeys: [] }]);
	expect(saved.stepUpScopes).toEqual(["org.members", "org.members"]);
	expect(pageErrors).toEqual([]);
});

test("shows and recovers from organization, member, role, permission, team, and assignment read failures", async ({
	page,
}) => {
	await openWorkspace(page, "?failOrgsOnce=1");
	await expect(page.getByRole("alert")).toContainText(
		"Couldn’t load your organizations"
	);
	await page.getByRole("button", { name: "Retry organization list" }).click();
	await expect(
		page.getByText("Atlas Research", { exact: false })
	).toBeVisible();

	await page.goto(
		"/gateway-workspace-members-proof.html?failMembersOnce=1&failRolesOnce=1&failPermissionsOnce=1&failTeamsOnce=1&failAssignedOnce=1"
	);
	await expect(
		page.getByRole("heading", { exact: true, name: "Workspace" })
	).toBeVisible();
	await expect(
		page.getByRole("alert").filter({
			hasText: "Couldn’t load workspace members",
		})
	).toBeVisible();
	await expect(
		page.getByRole("alert").filter({
			hasText: "Couldn’t load workspace roles",
		})
	).toBeVisible();
	await page.getByRole("button", { name: "Retry member list" }).click();
	await expect(
		page.getByText("user-collab", { exact: true }).first()
	).toBeVisible();
	await expect(
		page.getByRole("alert").filter({
			hasText: "Couldn’t load workspace permissions",
		})
	).toBeVisible();
	await page.getByRole("button", { name: "Retry roles" }).click();
	await expect(
		page.getByRole("columnheader", { name: "Owner built-in" })
	).toBeVisible();
	await page.getByRole("button", { name: "Retry permissions" }).click();
	await expect(page.getByRole("button", { name: "New role" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Retry teams" })).toBeVisible();
	await page.getByRole("button", { name: "Retry teams" }).click();
	await expect(
		page.getByRole("combobox", { name: "Active team" })
	).toBeEnabled();
	const memberRow = page
		.locator('[data-slot="item"]')
		.filter({ hasText: "user-collab" });
	await memberRow.getByRole("button", { name: "Roles" }).click();
	await expect(
		page.getByRole("alert").filter({
			hasText: "Couldn’t load this member’s custom roles",
		})
	).toBeVisible();
	await page.getByRole("button", { name: "Retry assigned roles" }).click();
	await expect(
		page.getByRole("checkbox", { name: "Workflow editor" })
	).toBeChecked();
});

test("copies the active organization and account IDs to the clipboard", async ({
	page,
}) => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await openWorkspace(page);

	const activeOrganization = page
		.getByRole("list")
		.filter({ hasText: "Organization IDorg-atlas" });
	await expect(
		activeOrganization.getByRole("button", { name: "Copy organization ID" })
	).toHaveCount(1);
	await activeOrganization
		.getByRole("button", { name: "Copy organization ID" })
		.click();
	await expect(page.getByText("Copied organization ID")).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("org-atlas");

	await page.getByRole("button", { name: "Copy user ID" }).click();
	await expect(page.getByText("Copied user ID")).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("user-owner");
	await page.screenshot({
		fullPage: true,
		path: evidencePath("gateway-workspace-members-ids-copied"),
	});
});
