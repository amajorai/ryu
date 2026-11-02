import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
	APP_HTML,
	calls,
	capture,
	clearCalls,
	detailStatus,
	fixturePaths,
	mountSecurity,
	requests,
} from "./security-companion-proof.helpers.ts";

test("Security skip control moves focus into content without navigating the embedded app", async ({
	page,
}) => {
	const { companion } = await mountSecurity(page);
	const skipControl = companion.getByRole("button", {
		name: "Skip to Security content",
	});
	const main = companion.locator("#security-content");
	await expect(skipControl).toHaveAttribute(
		"aria-controls",
		"security-content"
	);
	await skipControl.focus();
	await expect(skipControl).toBeVisible();
	await skipControl.press("Enter");
	await expect(main).toHaveAttribute("tabindex", "-1");
	await expect(main).toBeFocused();
	await expect(main).toBeVisible();
	await expect(
		companion.getByRole("heading", { name: "Security" })
	).toBeVisible();
	await expect
		.poll(() =>
			companion
				.locator("html")
				.evaluate((node) => node.ownerDocument.location.hash)
		)
		.toBe("");
	await capture(companion, "security-companion-skip-link-content-focus.png");
});

test("Security sections, empty-state add, and scan validation work", async ({
	page,
}) => {
	const { companion } = await mountSecurity(page);
	await expect(companion.getByText("No scans yet")).toBeVisible();

	await companion.getByRole("tab", { name: "Findings" }).click();
	await expect(companion.getByText("No findings yet")).toBeVisible();
	await companion.getByRole("tab", { name: "Repositories" }).click();
	await expect(companion.getByText("No repositories yet")).toBeVisible();
	await companion.getByRole("button", { name: "Add repository" }).click();
	let dialog = companion.getByRole("dialog");
	await expect(dialog.getByRole("heading", { name: "New scan" })).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();

	await companion.getByRole("tab", { name: "Scans" }).click();
	await companion
		.getByRole("banner")
		.getByRole("button", { name: "New scan" })
		.click();
	dialog = companion.getByRole("dialog");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();
	await companion.getByRole("button", { name: "Start a scan" }).click();
	dialog = companion.getByRole("dialog");
	await dialog.getByRole("button", { name: "Start scan" }).click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Enter an absolute path to an authorized repository."
	);
	await expect(
		requests(await calls(page), "POST", "/repositories")
	).toHaveLength(0);
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await capture(companion, "security-companion-empty-state.png");
});

test("a codebase scan retries writes, scopes real results, supports triage, and persists", async ({
	page,
}) => {
	const { companion, tenantUserId } = await mountSecurity(page);
	const fixture = await fixturePaths(page);
	await expect(companion.getByText("No scans yet")).toBeVisible();
	await page.evaluate(() => {
		window.__securityProof.failNext({
			message: "Local proof sidecar is temporarily unavailable.",
			method: "GET",
			path: "/bootstrap",
			status: 503,
		});
	});
	await page.evaluate(
		({ appHtml, userId }) =>
			window.__securityProof.mount({
				appHtml,
				orgId: "security-proof-org",
				screen: "scans",
				tenantUserId: userId,
			}),
		{ appHtml: readFileSync(APP_HTML, "utf8"), userId: tenantUserId }
	);
	await expect(companion.getByRole("alert")).toContainText(
		"Security is unavailable"
	);
	await companion.getByRole("button", { name: "Retry" }).click();
	await expect(companion.getByText("No scans yet")).toBeVisible();

	await companion.getByRole("button", { name: "Start a scan" }).click();
	const dialog = companion.getByRole("dialog");
	await dialog
		.getByRole("textbox", { name: "Absolute repository path" })
		.fill(fixture.codebaseRepository);
	await dialog.getByLabel("Scan area").selectOption("folder");
	const scopePath = path.join(fixture.codebaseRepository, "src");
	await dialog
		.getByRole("textbox", { name: "Absolute folder path" })
		.fill(scopePath);
	await dialog.getByRole("switch", { name: "Deep scan" }).check();
	await dialog.getByLabel("Reasoning effort").selectOption("thorough");
	await dialog.getByRole("switch", { name: "Additional context" }).check();
	await dialog
		.getByLabel("Attack vectors")
		.fill("Auth bypass and session fixation");
	await dialog.getByLabel("Focus areas").fill("Authorization and uploads");
	await dialog
		.getByLabel("Additional security context")
		.fill("Only review the selected local source folder.");
	const model = dialog.locator("#security-model");
	await model.click();
	await companion
		.getByRole("option", { name: "Ryu local static pass" })
		.click();

	await clearCalls(page);
	await page.evaluate(() => {
		window.__securityProof.failNext({
			message: "Fixture rejected the first scan request.",
			method: "POST",
			path: "/scans",
			status: 503,
		});
	});
	await dialog.getByRole("button", { name: "Start scan" }).click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Fixture rejected the first scan request."
	);
	await expect(
		dialog.getByRole("textbox", { name: "Absolute repository path" })
	).toHaveValue(fixture.codebaseRepository);
	const failedCalls = await calls(page);
	const failedCreate = requests(failedCalls, "POST", "/scans");
	const repositoryWrites = requests(failedCalls, "POST", "/repositories");
	await expect.poll(() => failedCreate.length).toBe(1);
	await expect.poll(() => failedCreate[0]?.status).toBe(503);
	await expect.poll(() => repositoryWrites[0]?.status).toBe(200);
	await expect.poll(() => repositoryWrites[0]?.tenantUserId).toBe(tenantUserId);
	await expect
		.poll(() => repositoryWrites[0]?.orgId)
		.toBe("security-proof-org");

	await dialog.getByRole("button", { name: "Start scan" }).click();
	await expect(dialog).toBeHidden();
	const startCalls = await calls(page);
	const successfulScanCall = requests(startCalls, "POST", "/scans").at(-1);
	const repositoryId = successfulScanCall?.body?.repositoryId;
	const retriedRepositoryWrites = requests(startCalls, "POST", "/repositories");
	expect(retriedRepositoryWrites).toHaveLength(2);
	expect(retriedRepositoryWrites.map((call) => call.body?.path)).toEqual([
		fixture.codebaseRepository,
		fixture.codebaseRepository,
	]);
	expect(retriedRepositoryWrites[0]?.result).toEqual(
		retriedRepositoryWrites[1]?.result
	);
	expect(successfulScanCall?.body).toEqual({
		additionalContext: {
			attackVectors: "Auth bypass and session fixation",
			focusAreas: "Authorization and uploads",
			securityContext: "Only review the selected local source folder.",
		},
		deep: true,
		kind: "codebase",
		model: "Ryu local static pass",
		name: "",
		reasoningEffort: "thorough",
		repositoryId,
		scope: "folder",
		scopePath,
	});
	expect(successfulScanCall?.status).toBe(200);
	expect(successfulScanCall?.tenantUserId).toBe(tenantUserId);
	await expect(
		companion.getByRole("heading", { name: /codebase-repository · Deep scan/i })
	).toBeVisible();
	await companion.getByRole("button", { name: "View activity" }).click();
	await expect(companion.locator("#scan-activity")).toBeVisible();
	await expect(detailStatus(companion)).toHaveText("Completed", {
		timeout: 15_000,
	});
	await expect(
		companion.getByText("static-local", { exact: true }).first()
	).toBeVisible();
	await expect(
		companion.getByText("2 candidates retained from this scan.")
	).toBeVisible();
	await expect(companion.getByText("security.ts:1")).toBeVisible();
	await expect(companion.getByText("deserialization.py:1")).toBeVisible();
	await expect(companion.getByText("out-of-scope.ts:1")).toHaveCount(0);
	await expect(companion.getByText("ignored.ts:1")).toHaveCount(0);

	const scanSearch = companion.getByRole("textbox", { name: "Search scans" });
	await scanSearch.fill("does not exist");
	await expect(companion.getByText("No scans found")).toBeVisible();
	await scanSearch.fill("codebase-repository");
	const scanRow = companion.getByRole("button", {
		name: /codebase-repository · Deep scan/,
	});
	await scanRow.click();
	await expect(scanRow).toHaveAttribute("aria-current", "true");

	await companion.getByRole("tab", { name: "Findings" }).click();
	const highFindingRow = companion.getByRole("button", {
		name: /Potential dynamic code execution/,
	});
	await expect(highFindingRow).toBeVisible();
	await companion
		.getByLabel("Filter findings by severity")
		.selectOption("medium");
	await expect(
		companion.getByText("Unsafe deserialization or configuration load")
	).toBeVisible();
	await expect(
		companion.getByText("Potential dynamic code execution")
	).toHaveCount(0);
	await companion.getByLabel("Filter findings by severity").selectOption("all");
	await companion.getByLabel("Search findings").fill("not a finding");
	await expect(companion.getByText("No findings found")).toBeVisible();
	await companion
		.getByLabel("Search findings")
		.fill("Potential dynamic code execution");
	await expect(
		companion.getByRole("button", { name: /Potential dynamic code execution/ })
	).toBeVisible();
	await companion
		.getByRole("button", { name: /Potential dynamic code execution/ })
		.click();
	await expect(
		companion.getByRole("heading", { name: "Potential dynamic code execution" })
	).toBeVisible();
	await expect(
		companion.getByText("security.ts:1", { exact: true })
	).toBeVisible();
	await expect(
		companion.getByText("Static signal matched at security.ts:1.")
	).toBeVisible();

	await companion.getByRole("tab", { name: "Patch" }).click();
	await expect(companion.getByText("Read-only proposal")).toBeVisible();
	const findingSnapshot = (await calls(page))
		.map((call) =>
			z
				.object({
					findings: z
						.array(z.object({ id: z.string(), title: z.string() }))
						.optional(),
				})
				.parse(call.result ?? {})
		)
		.find((result) =>
			result?.findings?.some(
				(finding) => finding.title === "Potential dynamic code execution"
			)
		);
	const findingId = findingSnapshot?.findings?.find(
		(finding) => finding.title === "Potential dynamic code execution"
	)?.id;
	if (!findingId) {
		throw new Error("The local scanner did not persist the expected finding.");
	}
	await page.evaluate((id) => {
		window.__securityProof.failNext({
			message: "Fixture rejected the first remediation proposal.",
			method: "POST",
			path: `/findings/${id}/patch`,
			status: 503,
		});
	}, findingId);
	await companion
		.getByRole("button", { name: "Generate patch proposal" })
		.click();
	await expect(
		companion.getByText("Fixture rejected the first remediation proposal.")
	).toBeVisible();
	await expect(
		companion.getByRole("button", { name: "Generate patch proposal" })
	).toBeVisible();
	const failedPatch = (await calls(page)).find(
		(call) => call.method === "POST" && call.path.endsWith("/patch")
	);
	expect(failedPatch?.status).toBe(503);
	await companion
		.getByRole("button", { name: "Generate patch proposal" })
		.click();
	await expect(
		companion.getByRole("button", { name: "Generate patch proposal" })
	).toHaveCount(0);
	await expect(companion.locator(".security-code-block")).toContainText(
		"# Proposal only; Ryu Security did not modify the checkout."
	);
	await expect(companion.locator(".security-code-block")).toContainText(
		"# Location: security.ts:1"
	);
	await expect(
		companion.getByRole("button", { name: "Generate patch proposal" })
	).toHaveCount(0);
	await companion.getByRole("tab", { name: "Summary" }).click();
	await clearCalls(page);
	await page.evaluate((id) => {
		window.__securityProof.failNext({
			message: "Fixture rejected the first status update.",
			method: "POST",
			path: `/findings/${id}/status`,
			status: 503,
		});
	}, findingId);
	await companion.getByRole("button", { name: "Close finding" }).click();
	await expect(
		companion.getByText("Fixture rejected the first status update.")
	).toBeVisible();
	await expect(
		companion.getByRole("button", { name: "Close finding" })
	).toBeVisible();
	const statusCalls = (await calls(page)).filter(
		(call) => call.method === "POST" && call.path.endsWith("/status")
	);
	await expect.poll(() => statusCalls[0]?.body?.status).toBe("closed");
	await companion.getByRole("button", { name: "Close finding" }).click();
	await expect(
		companion.getByRole("button", { name: "Reopen finding" })
	).toBeVisible();
	const successStatus = (await calls(page))
		.filter((call) => call.method === "POST" && call.path.endsWith("/status"))
		.at(-1);
	expect(successStatus?.body).toEqual({ status: "closed" });
	expect(successStatus?.status).toBe(200);

	await companion.getByRole("tab", { name: "Repositories" }).click();
	const repoSearch = companion.getByRole("textbox", {
		name: "Search repositories",
	});
	await repoSearch.fill("missing repository");
	await expect(companion.getByText("No repositories found")).toBeVisible();
	await repoSearch.fill("codebase-repository");
	const repositoryRow = companion.getByRole("button", {
		name: /codebase-repository/,
	});
	await repositoryRow.click();
	await expect(repositoryRow).toHaveAttribute("aria-current", "true");
	await expect(
		companion.getByRole("heading", { name: "codebase-repository" })
	).toBeVisible();
	await companion
		.getByRole("region", { name: "Repository details" })
		.getByRole("button", { name: "New scan" })
		.click();
	const followupDialog = companion.getByRole("dialog");
	await expect(followupDialog.getByLabel("Repository")).toHaveValue(
		String(repositoryId)
	);
	await followupDialog.getByLabel("Repository").selectOption("new");
	await followupDialog
		.getByRole("textbox", { name: "Absolute repository path" })
		.fill(fixture.changesRepository);
	await followupDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(followupDialog).toBeHidden();

	await page.reload();
	await page.waitForSelector("body[data-harness-ready='1']");
	await page.evaluate(
		({ appHtml, userId }) =>
			window.__securityProof.mount({
				appHtml,
				orgId: "security-proof-org",
				screen: "findings",
				tenantUserId: userId,
			}),
		{ appHtml: readFileSync(APP_HTML, "utf8"), userId: tenantUserId }
	);
	await expect
		.poll(() => page.evaluate(() => window.__securityProof.connected()))
		.toBe(true);
	const afterReload = page.frameLocator("iframe");
	// Open findings list first after a reload; the persisted closed finding
	// keeps its Closed status and opens from the saved list.
	await afterReload
		.getByRole("region", { name: "Saved findings" })
		.getByRole("button", {
			name: /^Potential dynamic code execution .* High Closed$/,
		})
		.click();
	await expect(
		afterReload.getByRole("heading", {
			name: "Potential dynamic code execution",
		})
	).toBeVisible();
	await expect(
		afterReload.getByRole("button", { name: "Reopen finding" })
	).toBeVisible();
	await afterReload.getByRole("tab", { name: "Patch" }).click();
	await expect(afterReload.locator(".security-code-block")).toContainText(
		"# Location: security.ts:1"
	);
	await capture(
		afterReload,
		"security-companion-codebase-triage-persisted.png"
	);
	await clearCalls(page);
	await afterReload.getByRole("button", { name: "Reopen finding" }).click();
	await expect(
		afterReload.getByRole("button", { name: "Close finding" })
	).toBeVisible();
	const reopenedStatus = (await calls(page)).find(
		(call) => call.method === "POST" && call.path.endsWith("/status")
	);
	expect(reopenedStatus?.body).toEqual({ status: "open" });
	expect(reopenedStatus?.status).toBe(200);
	const unchangedSource = await readFile(
		path.join(fixture.codebaseRepository, "src/security.ts"),
		"utf8"
	);
	expect(unchangedSource).toBe("export const result = eval(input);\n");
});
