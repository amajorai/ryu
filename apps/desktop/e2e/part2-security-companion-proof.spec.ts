// Continues security-companion-proof.spec.ts (split under the file token limit); helpers live in security-companion-proof.helpers.ts.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
	APP_HTML,
	calls,
	capture,
	detailStatus,
	fixturePaths,
	mountSecurity,
	requests,
} from "./security-companion-proof.helpers.ts";

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
