import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { z } from "zod";
import type { ProofJsonRecord } from "./fixture-json.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML = `${tmpdir()}/ryu-security-companion-ui-build/index.html`;
const EVIDENCE = path.resolve(
	HERE,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface SecurityCall {
	body?: ProofJsonRecord;
	method: string;
	orgId: string;
	path: string;
	result?: unknown;
	status: number;
	tenantUserId: string;
}

interface SecurityFixturePaths {
	changesRepository: string;
	codebaseRepository: string;
}

declare global {
	interface Window {
		__securityProof: {
			calls: () => SecurityCall[];
			clearCalls: () => void;
			connected: () => boolean;
			failNext: (failure: {
				message: string;
				method: string;
				path: string;
				status: number;
			}) => void;
			mount: (input: {
				appHtml: string;
				orgId: string;
				screen: "findings" | "repositories" | "scans";
				tenantUserId: string;
			}) => void;
		};
	}
}

async function mountSecurity(
	page: Page,
	screen: "findings" | "repositories" | "scans" = "scans",
	tenantUserId = `security-proof-${randomUUID()}`
): Promise<{ companion: FrameLocator; tenantUserId: string }> {
	await page.goto("/security-companion-proof.html");
	await page.waitForSelector("body[data-harness-ready='1']");
	await page.evaluate(
		({ appHtml, mountScreen, userId }) =>
			window.__securityProof.mount({
				appHtml,
				orgId: "security-proof-org",
				screen: mountScreen,
				tenantUserId: userId,
			}),
		{
			appHtml: readFileSync(APP_HTML, "utf8"),
			mountScreen: screen,
			userId: tenantUserId,
		}
	);
	await expect
		.poll(() => page.evaluate(() => window.__securityProof.connected()), {
			timeout: 15_000,
		})
		.toBe(true);
	return { companion: page.frameLocator("iframe"), tenantUserId };
}

async function fixturePaths(page: Page): Promise<SecurityFixturePaths> {
	// SAFETY: This proof host owns /__proof/fixtures and serializes both repository paths directly from its native path.join string values.
	return (await page.request
		.get("/__proof/fixtures")
		.then((response) => response.json())) as SecurityFixturePaths;
}

async function calls(page: Page): Promise<SecurityCall[]> {
	return await page.evaluate(() => window.__securityProof.calls());
}

async function clearCalls(page: Page): Promise<void> {
	await page.evaluate(() => window.__securityProof.clearCalls());
}

async function capture(
	companion: FrameLocator,
	filename: string
): Promise<void> {
	await mkdir(EVIDENCE, { recursive: true });
	await companion.locator("body").screenshot({
		animations: "disabled",
		path: path.join(EVIDENCE, filename),
	});
}

function requests(
	allCalls: SecurityCall[],
	method: string,
	pathName: string
): SecurityCall[] {
	return allCalls.filter(
		(call) => call.method === method && call.path === pathName
	);
}

function detailStatus(companion: FrameLocator) {
	return companion
		.locator(".security-meta-item")
		.filter({ hasText: "Status" })
		.locator(".security-meta-value");
}

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

test("changes reviews use the modified tracked file and disable codebase-only options", async ({
	page,
}) => {
	const { companion } = await mountSecurity(page);
	const fixture = await fixturePaths(page);
	await companion.getByRole("button", { name: "Start a scan" }).click();
	const dialog = companion.getByRole("dialog");
	await dialog
		.getByRole("textbox", { name: "Absolute repository path" })
		.fill(fixture.changesRepository);
	// The two-column scan-type grid holds both tabs, so neither collapses into
	// "N more", including while the dialog is still zooming in.
	await expect(
		dialog.getByRole("button", { name: /Show \d+ more tabs/ })
	).toHaveCount(0);
	await dialog.getByRole("tab", { name: /Changes/ }).click();
	await expect(dialog.getByLabel("Scan area")).toBeDisabled();
	await expect(
		dialog.getByRole("switch", { name: "Deep scan" })
	).toBeDisabled();
	await dialog.getByRole("tab", { name: /Codebase/ }).click();
	await expect(dialog.getByLabel("Scan area")).toBeEnabled();
	await expect(dialog.getByRole("switch", { name: "Deep scan" })).toBeEnabled();
	await expect(
		dialog.getByRole("button", { name: /Show \d+ more tabs/ })
	).toHaveCount(0);
	await dialog.getByRole("tab", { name: /Changes/ }).click();
	await expect(
		dialog.getByRole("switch", { name: "Deep scan" })
	).toBeDisabled();
	await dialog.getByRole("button", { name: "Start scan" }).click();
	await expect(dialog).toBeHidden();
	await expect(companion.getByText("src/route.ts:1")).toBeVisible({
		timeout: 15_000,
	});
	await expect(detailStatus(companion)).toHaveText("Completed");
	const scanWrite = requests(await calls(page), "POST", "/scans").at(-1);
	const repositoryWrite = requests(
		await calls(page),
		"POST",
		"/repositories"
	).at(-1);
	const createdRepository = z
		.object({ id: z.string() })
		.optional()
		.parse(repositoryWrite?.result);
	expect(scanWrite?.body).toEqual({
		additionalContext: {
			attackVectors: "",
			focusAreas: "",
			securityContext: "",
		},
		deep: false,
		kind: "changes",
		model: "Ryu local static pass",
		name: "",
		reasoningEffort: "balanced",
		repositoryId: createdRepository?.id,
		scope: "entire",
	});
	expect(scanWrite?.status).toBe(200);
	await expect(
		companion.getByText("1 candidate retained from this scan.")
	).toBeVisible();
	await expect(companion.getByText("static-local").first()).toBeVisible();
	await expect(
		companion.getByText(
			"Scan queued. The sidecar is preparing the selected scope."
		)
	).toBeHidden();
	await capture(companion, "security-companion-changes-scan-complete.png");
});

test("stopping a scan stays read-only and reports a completion race accurately", async ({
	page,
}) => {
	const { companion, tenantUserId } = await mountSecurity(page);
	const fixture = await fixturePaths(page);
	await companion.getByRole("button", { name: "Start a scan" }).click();
	const dialog = companion.getByRole("dialog");
	await dialog
		.getByRole("textbox", { name: "Absolute repository path" })
		.fill(fixture.codebaseRepository);
	const sourceBefore = await readFile(
		path.join(fixture.codebaseRepository, "src/security.ts"),
		"utf8"
	);
	// The fixture scan finishes in under a second, so on a busy host a status
	// poll could remove Stop before the click lands. Hold only the selected
	// scan's status reads until Stop is pressed: the control stays reachable,
	// and the cancel response still reports whichever terminal state the
	// sidecar reached, which the assertions below accept explicitly.
	let releaseStatusReads: () => void = () => undefined;
	const statusReadsReleased = new Promise<void>((resolve) => {
		releaseStatusReads = resolve;
	});
	await page.route(/\/__proof\/security\/scans\/[^/?]+$/u, async (route) => {
		if (route.request().method() === "GET") {
			await statusReadsReleased;
		}
		await route.continue();
	});
	await dialog.getByRole("button", { name: "Start scan" }).click();
	await expect(dialog).toBeHidden();
	const stop = companion.getByRole("button", { name: "Stop scan" });
	await stop.click();
	releaseStatusReads();
	await expect
		.poll(async () => (await detailStatus(companion).textContent())?.trim())
		.toMatch(/^(Canceled|Completed)$/);
	const cancelCall = (await calls(page)).find((call) =>
		call.path.endsWith("/cancel")
	);
	expect(cancelCall?.method).toBe("POST");
	expect(cancelCall?.status).toBe(200);
	// SAFETY: The POST success checked above is the local cancel_scan ApiResult<Scan>; camelCase serde publishes string id/status and numeric findingCount, and this host forwards its JSON unchanged. A missing captured call remains undefined.
	const stopResult = cancelCall?.result as
		| { findingCount: number; id: string; status: string }
		| undefined;
	expect(stopResult).toBeDefined();
	expect(["canceled", "completed"]).toContain(stopResult?.status);
	const sourceAfter = await readFile(
		path.join(fixture.codebaseRepository, "src/security.ts"),
		"utf8"
	);
	expect(sourceAfter).toBe(sourceBefore);
	if (stopResult?.status === "completed") {
		await expect(detailStatus(companion)).toHaveText("Completed");
		await expect(
			companion.getByText("The scan ended before it could be stopped.", {
				exact: true,
			})
		).toBeVisible();
		expect(stopResult.findingCount).toBeGreaterThan(0);
		await expect(
			companion.getByText(
				`${stopResult.findingCount} candidate${stopResult.findingCount === 1 ? "" : "s"} retained from this scan.`
			)
		).toBeVisible();
		await expect(companion.locator(".security-inline-finding")).toHaveCount(
			Math.min(stopResult.findingCount, 8)
		);
		await capture(
			companion,
			"security-companion-stop-finished-before-cancel.png"
		);
		return;
	}
	await expect(detailStatus(companion)).toHaveText("Canceled");
	await expect(
		companion.getByText("Scan canceled. No files were changed.", {
			exact: true,
		})
	).toBeVisible();
	if (stopResult?.findingCount === 0) {
		await expect(companion.getByText("Waiting for results")).toHaveCount(0);
		await expect(
			companion.getByText("No findings before cancellation")
		).toBeVisible();
		await expect(
			companion.getByText("0 candidates retained before cancellation.")
		).toBeVisible();
	} else if (stopResult && stopResult.findingCount > 0) {
		const persistedResponse = await page.evaluate(
			async ({ scanId, tenantUserId }) => {
				const response = await fetch(`/__proof/security/scans/${scanId}`, {
					headers: {
						"x-ryu-caller-user-id": tenantUserId,
						"x-ryu-caller-org-id": "security-proof-org",
					},
				});
				return {
					status: response.status,
					value: await response.json(),
				};
			},
			{ scanId: stopResult.id, tenantUserId }
		);
		expect(persistedResponse.status).toBe(200);
		const persistedScan = persistedResponse.value;
		expect(persistedScan.scan.status).toBe("canceled");
		expect(persistedScan.findings).toHaveLength(stopResult.findingCount);
		await expect(
			companion.getByText(
				`${stopResult.findingCount} candidate${stopResult.findingCount === 1 ? "" : "s"} retained before cancellation.`
			)
		).toBeVisible();
		await expect(companion.locator(".security-inline-finding")).toHaveCount(
			stopResult.findingCount
		);
	}
	await capture(companion, "security-companion-canceled-scan-ui-state.png");
});

test("canceling after candidates are saved keeps the partial findings visible", async ({
	page,
}) => {
	const { companion, tenantUserId } = await mountSecurity(page);
	const fixture = await fixturePaths(page);
	// The fixture scan saves candidates ~450ms after it starts and completes
	// ~340ms later. Every locator call re-describes the host iframe, whose
	// srcdoc is the ~2 MB Security build, so on a busy runner a few of them
	// between Start and Stop outlast that window. Resolve the Companion frame
	// up front, start polling as soon as the scan exists, and check the closed
	// dialog only after the Stop click.
	const companionFrame = await (
		await page.locator("iframe").elementHandle()
	)?.contentFrame();
	if (!companionFrame) {
		throw new Error("The Security Companion frame is not attached.");
	}
	await companion.getByRole("button", { name: "Start a scan" }).click();
	const dialog = companion.getByRole("dialog");
	await dialog
		.getByRole("textbox", { name: "Absolute repository path" })
		.fill(fixture.codebaseRepository);
	await dialog.getByRole("button", { name: "Start scan" }).click();

	let scanId: string | undefined;
	for (let attempt = 0; attempt < 500 && !scanId; attempt += 1) {
		const createdScanCall = requests(await calls(page), "POST", "/scans").at(
			-1
		);
		scanId = z
			.object({ id: z.string().optional() })
			.optional()
			.parse(createdScanCall?.result)?.id;
		if (!scanId) {
			await page.waitForTimeout(10);
		}
	}
	expect(scanId).toBeTruthy();
	if (!scanId) {
		throw new Error("The Security proof did not create a scan.");
	}
	let canceledBeforeCompletion = false;
	let cancellationRequested = false;
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const response = await page.request.get(
			`/__proof/security/scans/${scanId}`,
			{
				headers: {
					"x-ryu-caller-user-id": tenantUserId,
					"x-ryu-caller-org-id": "security-proof-org",
				},
			}
		);
		if (response.ok()) {
			const snapshot = await response.json();
			if (
				snapshot.scan.status === "running" &&
				snapshot.scan.findingCount > 0 &&
				!cancellationRequested
			) {
				// Clicks the one visible Stop scan control, as the strict role
				// locator did, without re-describing the iframe on every poll.
				cancellationRequested = await companionFrame.evaluate(() => {
					const stopControls = Array.from(
						document.querySelectorAll("button")
					).filter(
						(button) =>
							button.textContent?.trim() === "Stop scan" &&
							button.checkVisibility()
					);
					if (stopControls.length > 1) {
						throw new Error(
							`Expected one Stop scan control, found ${stopControls.length}.`
						);
					}
					const [stop] = stopControls;
					stop?.click();
					return stop !== undefined;
				});
			}
			if (snapshot.scan.status === "canceled") {
				canceledBeforeCompletion = cancellationRequested;
				break;
			}
		}
		await page.waitForTimeout(10);
	}
	expect(canceledBeforeCompletion).toBe(true);
	await expect(dialog).toBeHidden();
	await expect(detailStatus(companion)).toHaveText("Canceled");
	const persistedResponse = await page.request.get(
		`/__proof/security/scans/${scanId}`,
		{
			headers: {
				"x-ryu-caller-user-id": tenantUserId,
				"x-ryu-caller-org-id": "security-proof-org",
			},
		}
	);
	expect(persistedResponse.status()).toBe(200);
	const persistedScan = await persistedResponse.json();
	expect(persistedScan.scan.status).toBe("canceled");
	expect(persistedScan.findings.length).toBeGreaterThan(0);
	expect(persistedScan.findings).toHaveLength(persistedScan.scan.findingCount);
	await expect(
		companion.getByText(
			`${persistedScan.scan.findingCount} candidate${persistedScan.scan.findingCount === 1 ? "" : "s"} retained before cancellation.`
		)
	).toBeVisible();
	await expect(companion.locator(".security-inline-finding")).toHaveCount(
		persistedScan.findings.length
	);
	await expect(companion.getByText("Waiting for results")).toHaveCount(0);
	await capture(
		companion,
		"security-companion-canceled-scan-partial-results.png"
	);
});

test("Security filters and local tenant isolation do not cross repository data", async ({
	page,
}) => {
	const { companion, tenantUserId } = await mountSecurity(page, "scans");
	const fixture = await fixturePaths(page);
	await companion.getByRole("button", { name: "Start a scan" }).click();
	const dialog = companion.getByRole("dialog");
	await dialog
		.getByRole("textbox", { name: "Absolute repository path" })
		.fill(fixture.codebaseRepository);
	await dialog.getByRole("button", { name: "Start scan" }).click();
	await expect(dialog).toBeHidden();
	await expect(detailStatus(companion)).toHaveText("Completed", {
		timeout: 15_000,
	});
	await page.evaluate(
		({ appHtml }) =>
			window.__securityProof.mount({
				appHtml,
				orgId: "another-proof-org",
				screen: "repositories",
				tenantUserId: "different-security-proof-user",
			}),
		{ appHtml: readFileSync(APP_HTML, "utf8") }
	);
	await expect
		.poll(() => page.evaluate(() => window.__securityProof.connected()))
		.toBe(true);
	const isolatedCompanion = page.frameLocator("iframe");
	await expect(
		isolatedCompanion.getByText("No repositories yet")
	).toBeVisible();
	await expect(isolatedCompanion.getByText("No scans yet")).toHaveCount(0);
	const bootstrapCall = (await calls(page)).find(
		(call) => call.path === "/bootstrap"
	);
	expect(bootstrapCall?.tenantUserId).toBe("different-security-proof-user");
	expect(bootstrapCall?.orgId).toBe("another-proof-org");
	expect(tenantUserId).not.toBe("different-security-proof-user");
	await capture(isolatedCompanion, "security-companion-tenant-isolation.png");
});
