import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type {
	GatewayDoctorReport,
	GatewayFirewallConfig,
	GatewayRoutingConfig,
} from "../src/lib/api/gateway.ts";

interface PostureProofSnapshot {
	config: { firewall: GatewayFirewallConfig; routing: GatewayRoutingConfig };
	doctor: GatewayDoctorReport;
	doctorReads: number;
	preferences: Record<string, string>;
	requests: {
		body: unknown;
		method: string;
		path: string;
		status: number;
	}[];
}

function screenshotPath(name: string): string {
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

async function readProofState(page: Page): Promise<PostureProofSnapshot> {
	return page.evaluate(() => {
		const proof =
			/* SAFETY: gateway-posture-card-proof.tsx installs __gatewayPostureProof before this proof page is evaluated. */ (
				window as Window & {
					__gatewayPostureProof: {
						snapshot: () => PostureProofSnapshot;
					};
				}
			).__gatewayPostureProof;
		return proof.snapshot();
	});
}

function requestsFor(
	snapshot: PostureProofSnapshot,
	method: string,
	path: string
) {
	return snapshot.requests.filter(
		(request) => request.method === method && request.path === path
	);
}

function preferenceWrites(snapshot: PostureProofSnapshot) {
	return snapshot.requests.filter(
		(request) =>
			request.method === "PUT" && request.path.startsWith("/api/preferences/")
	);
}

function configWrites(snapshot: PostureProofSnapshot) {
	return requestsFor(snapshot, "PUT", "/api/gateway/config");
}

test.describe.configure({ timeout: 60_000 });

test("retries a failed posture load and Cancel discards a pending selection without writes", async ({
	page,
}) => {
	await page.goto("/gateway-posture-card-proof.html?failRead=true");
	await expect(page.getByText("/api/gateway/config failed: 503")).toBeVisible();
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	const slider = page.getByRole("slider", {
		name: "Gateway safety posture",
	});
	await expect(slider).toHaveAttribute("aria-valuetext", "Balanced posture");
	await expect(page.getByText("PII redaction is disabled")).toBeVisible();
	const recovered = await readProofState(page);
	expect(
		requestsFor(recovered, "GET", "/api/gateway/config").map(
			(request) => request.status
		)
	).toEqual([503, 200]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-posture-load-retry"),
	});

	await slider.press("ArrowLeft");
	await expect(slider).toHaveAttribute("aria-valuetext", "Guarded posture");
	await expect(page.getByText("Apply Guarded?", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(slider).toHaveAttribute("aria-valuetext", "Balanced posture");
	const afterCancel = await readProofState(page);
	expect(configWrites(afterCancel)).toEqual([]);
	expect(preferenceWrites(afterCancel)).toEqual([]);
	expect(afterCancel.config.firewall).toEqual(recovered.config.firewall);
});

test("applies a selected posture with ordered exact config and preference writes, retaining a failed draft for retry", async ({
	page,
}) => {
	await page.goto("/gateway-posture-card-proof.html");
	const slider = page.getByRole("slider", {
		name: "Gateway safety posture",
	});
	await expect(slider).toHaveAttribute("aria-valuetext", "Balanced posture");
	const before = await readProofState(page);
	const expectedFirewall: GatewayFirewallConfig = {
		...before.config.firewall,
		enabled: true,
		scan_inbound: true,
		scan_outbound: true,
		log_detections: true,
		redact_pii: true,
		redact_secrets: true,
		wrap_untrusted_tool_results: true,
		policy: "sanitize",
	};

	await slider.press("End");
	await expect(slider).toHaveAttribute("aria-valuetext", "Autonomous posture");
	await expect(
		page.getByText("Apply Autonomous?", { exact: true })
	).toBeVisible();
	expect(configWrites(await readProofState(page))).toEqual([]);
	await page.evaluate(() => {
		/* SAFETY: gateway-posture-card-proof.tsx installs __gatewayPostureProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayPostureProof: { failNextConfigWrite: boolean };
			}
		).__gatewayPostureProof.failNextConfigWrite = true;
	});

	const apply = page.getByRole("button", {
		name: "Apply posture",
		exact: true,
	});
	await apply.click();
	await expect(page.getByText("Could not apply posture")).toBeVisible();
	await expect(slider).toHaveAttribute("aria-valuetext", "Autonomous posture");
	const failed = await readProofState(page);
	expect(failed.config.firewall).toEqual(before.config.firewall);
	expect(failed.preferences["approval-mode"]).toBe("smart");
	expect(configWrites(failed)).toEqual([
		{
			body: { firewall: expectedFirewall },
			method: "PUT",
			path: "/api/gateway/config",
			status: 503,
		},
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-posture-apply-error-retains-pending"),
	});

	await apply.click();
	await expect(page.getByText("Autonomous posture applied")).toBeVisible();
	await expect(
		page.getByText("Apply Autonomous?", { exact: true })
	).toHaveCount(0);
	const applied = await readProofState(page);
	expect(configWrites(applied)).toEqual([
		{
			body: { firewall: expectedFirewall },
			method: "PUT",
			path: "/api/gateway/config",
			status: 503,
		},
		{
			body: { firewall: expectedFirewall },
			method: "PUT",
			path: "/api/gateway/config",
			status: 200,
		},
	]);
	expect(applied.config.firewall).toEqual(expectedFirewall);
	expect(applied.preferences["exec-approval-mode"]).toBe("enforce");
	expect(applied.preferences["approval-mode"]).toBe("off");
	expect(applied.preferences["gateway-posture"]).toBe("autonomous");
	expect(
		preferenceWrites(applied).map(({ body, path, status }) => ({
			body,
			path,
			status,
		}))
	).toEqual([
		{
			body: { value: "enforce" },
			path: "/api/preferences/exec-approval-mode",
			status: 200,
		},
		{
			body: { value: "enforce" },
			path: "/api/preferences/exec-approval-mode",
			status: 200,
		},
		{
			body: { value: "off" },
			path: "/api/preferences/approval-mode",
			status: 200,
		},
		{
			body: { value: "autonomous" },
			path: "/api/preferences/gateway-posture",
			status: 200,
		},
	]);
	await page.reload();
	const persistedSlider = page.getByRole("slider", {
		name: "Gateway safety posture",
	});
	await expect(persistedSlider).toHaveAttribute(
		"aria-valuetext",
		"Autonomous posture"
	);
	await expect(persistedSlider).toHaveAttribute("aria-valuenow", "2");
	await expect(
		page
			.locator('[data-gateway-posture="true"] span.font-medium.text-sm')
			.first()
	).toHaveText("Autonomous");
	const afterReload = await readProofState(page);
	expect(afterReload.config.firewall).toEqual(expectedFirewall);
	expect(afterReload.preferences["approval-mode"]).toBe("off");
	expect(afterReload.preferences["gateway-posture"]).toBe("autonomous");
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-posture-autonomous-applied"),
	});
});

test("Gateway coverage partial-write error can be retried and persists both subscription routes", async ({
	page,
}) => {
	await page.goto("/gateway-posture-card-proof.html");
	const coverageSwitch = page.getByRole("switch").first();
	await expect(coverageSwitch).toBeVisible();
	await expect(coverageSwitch).not.toBeChecked();
	await page.evaluate(() => {
		/* SAFETY: gateway-posture-card-proof.tsx installs __gatewayPostureProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayPostureProof: { failPreferenceWriteKey: string | null };
			}
		).__gatewayPostureProof.failPreferenceWriteKey = "codex-gateway-routing";
	});

	await coverageSwitch.click();
	await expect(
		page.getByText("Could not update Gateway coverage")
	).toBeVisible();
	await expect(coverageSwitch).not.toBeChecked();
	const failed = await readProofState(page);
	expect(failed.preferences["claude-gateway-routing"]).toBe("true");
	expect(failed.preferences["codex-gateway-routing"]).toBe("false");
	const failedClaudeWrites = requestsFor(
		failed,
		"PUT",
		"/api/preferences/claude-gateway-routing"
	);
	const failedCodexWrites = requestsFor(
		failed,
		"PUT",
		"/api/preferences/codex-gateway-routing"
	);
	expect(failedClaudeWrites.map((request) => request.status)).toEqual([200]);
	expect(failedClaudeWrites.map((request) => request.body)).toEqual([
		{ value: "true" },
	]);
	expect(failedCodexWrites.map((request) => request.status)).toEqual([503]);
	expect(failedCodexWrites.map((request) => request.body)).toEqual([
		{ value: "true" },
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-posture-coverage-write-error"),
	});

	await coverageSwitch.click();
	await expect(coverageSwitch).toBeChecked();
	const saved = await readProofState(page);
	expect(saved.preferences["claude-gateway-routing"]).toBe("true");
	expect(saved.preferences["codex-gateway-routing"]).toBe("true");
	const savedClaudeWrites = requestsFor(
		saved,
		"PUT",
		"/api/preferences/claude-gateway-routing"
	);
	const savedCodexWrites = requestsFor(
		saved,
		"PUT",
		"/api/preferences/codex-gateway-routing"
	);
	expect(savedClaudeWrites.map((request) => request.status)).toEqual([
		200, 200,
	]);
	expect(savedClaudeWrites.map((request) => request.body)).toEqual([
		{ value: "true" },
		{ value: "true" },
	]);
	expect(savedCodexWrites.map((request) => request.status)).toEqual([503, 200]);
	expect(savedCodexWrites.map((request) => request.body)).toEqual([
		{ value: "true" },
		{ value: "true" },
	]);
	await page.reload();
	await expect(page.getByRole("switch").first()).toBeChecked();
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-posture-coverage-persisted"),
	});
});

test("Run audit refreshes the report, Copy report copies exact JSON, and local agent audit opens its conversation", async ({
	page,
}) => {
	await page.goto("/gateway-posture-card-proof.html");
	const initial = await readProofState(page);
	await expect(page.getByText("PII redaction is disabled")).toBeVisible();
	await page.getByRole("button", { name: "Copy report", exact: true }).click();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		JSON.stringify(initial.doctor, null, 2)
	);

	await page.evaluate(() => {
		/* SAFETY: gateway-posture-card-proof.tsx installs __gatewayPostureProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayPostureProof: { doctorHealthyOnNextRead: boolean };
			}
		).__gatewayPostureProof.doctorHealthyOnNextRead = true;
	});
	await page.getByRole("button", { name: "Run audit", exact: true }).click();
	const doctorReport = page.locator('[data-doctor-report="true"]');
	await expect(doctorReport).toContainText("Healthy");
	const refreshed = await readProofState(page);
	expect(refreshed.doctorReads).toBe(initial.doctorReads + 1);
	expect(requestsFor(refreshed, "GET", "/api/gateway/doctor")).toHaveLength(2);
	expect(refreshed.doctor.counts.warnings).toBe(0);
	expect(
		refreshed.requests.filter(
			(request) =>
				request.method === "PUT" &&
				(request.path === "/api/gateway/config" ||
					request.path.startsWith("/api/preferences/"))
		)
	).toEqual([]);

	await page.getByRole("button", { name: "Copy report", exact: true }).click();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		JSON.stringify(refreshed.doctor, null, 2)
	);
	await page
		.getByRole("button", { name: "Audit with agent", exact: true })
		.click();
	await expect(page.getByTestId("catalog-scan-result")).toContainText(
		"Local audit fixture confirmed the current Gateway posture."
	);
	const withScan = await readProofState(page);
	expect(requestsFor(withScan, "POST", "/api/catalog/scan")).toEqual([
		{
			body: {
				kind: "gateway",
				id: "gateway",
				name: "Gateway health doctor",
				metadata: { doctor: refreshed.doctor },
				scorecard: null,
				execution: "agent",
			},
			method: "POST",
			path: "/api/catalog/scan",
			status: 200,
		},
	]);
	await page.getByRole("button", { name: "Open audit conversation" }).click();
	await expect(page.getByTestId("opened-conversation")).toHaveText(
		"posture-audit-conversation"
	);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-posture-doctor-audit-copied"),
	});
});

test("Doctor safe-fix preview retries after failure, changes nothing until Apply, and Dismiss discards the plan", async ({
	page,
}) => {
	await page.goto("/gateway-posture-card-proof.html");
	const before = await readProofState(page);
	const previewButton = page.getByRole("button", {
		name: "Preview safe fixes",
		exact: true,
	});
	await expect(previewButton).toBeVisible();
	await page.evaluate(() => {
		/* SAFETY: gateway-posture-card-proof.tsx installs __gatewayPostureProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayPostureProof: { failNextDoctorFix: boolean };
			}
		).__gatewayPostureProof.failNextDoctorFix = true;
	});
	await previewButton.click();
	await expect(page.getByText("Could not preview Doctor fixes")).toBeVisible();
	const failedPreview = await readProofState(page);
	expect(failedPreview.config.firewall).toEqual(before.config.firewall);
	expect(requestsFor(failedPreview, "POST", "/api/gateway/doctor/fix")).toEqual(
		[
			{
				body: { dryRun: true },
				method: "POST",
				path: "/api/gateway/doctor/fix",
				status: 503,
			},
		]
	);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-posture-safe-fix-preview-error"),
	});

	await previewButton.click();
	await expect(page.getByText("Safe fixes ready to review")).toBeVisible();
	await expect(
		page.getByText("firewall.redact_pii", { exact: true }).first()
	).toBeVisible();
	const preview = await readProofState(page);
	expect(preview.config.firewall).toEqual(before.config.firewall);
	expect(requestsFor(preview, "POST", "/api/gateway/doctor/fix")).toEqual([
		{
			body: { dryRun: true },
			method: "POST",
			path: "/api/gateway/doctor/fix",
			status: 503,
		},
		{
			body: { dryRun: true },
			method: "POST",
			path: "/api/gateway/doctor/fix",
			status: 200,
		},
	]);
	await expect(page.getByText("Could not preview Doctor fixes")).toHaveCount(
		0,
		{
			timeout: 10_000,
		}
	);
	await expect(page.getByText("Doctor preview ready")).toHaveCount(0, {
		timeout: 10_000,
	});
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-posture-safe-fix-preview-recovered"),
	});

	await page.getByRole("button", { name: "Dismiss", exact: true }).click();
	await expect(page.getByText("Safe fixes ready to review")).toHaveCount(0);
	await expect(previewButton).toBeVisible();
	expect((await readProofState(page)).config.firewall).toEqual(
		before.config.firewall
	);

	await previewButton.click();
	await page
		.getByRole("button", { name: "Apply safe fixes", exact: true })
		.click();
	await expect(page.locator('[data-doctor-report="true"]')).toContainText(
		"Healthy"
	);
	await expect(page.getByText("Applied 1 safe fix")).toBeVisible();
	const applied = await readProofState(page);
	expect(applied.config.firewall.redact_pii).toBe(true);
	expect(applied.doctor.counts.warnings).toBe(0);
	expect(
		requestsFor(applied, "POST", "/api/gateway/doctor/fix").map(
			(request) => request.body
		)
	).toEqual([
		{ dryRun: true },
		{ dryRun: true },
		{ dryRun: true },
		{ dryRun: false },
	]);
	await page.reload();
	expect((await readProofState(page)).config.firewall.redact_pii).toBe(true);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-posture-safe-fix-applied"),
	});
});

test("read-only posture disables write controls but permits audit, copy, and Continue", async ({
	page,
}) => {
	await page.goto("/gateway-posture-card-proof.html?readOnly=true");
	const initial = await readProofState(page);
	await expect(
		page.getByRole("slider", { name: "Gateway safety posture" })
	).toBeDisabled();
	await expect(page.getByRole("switch").first()).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Preview safe fixes", exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Apply safe fixes", exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Run audit", exact: true })
	).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "Copy report", exact: true })
	).toBeEnabled();
	await page.getByRole("button", { name: "Copy report", exact: true }).click();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		JSON.stringify(initial.doctor, null, 2)
	);
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await expect(page.getByTestId("continue-count")).toHaveText("1");
	await page.getByRole("button", { name: "Run audit", exact: true }).click();
	await expect(page.locator('[data-doctor-report="true"]')).toBeVisible();
	const state = await readProofState(page);
	expect(
		state.requests.filter(
			(request) =>
				request.method === "PUT" &&
				(request.path === "/api/gateway/config" ||
					request.path.startsWith("/api/preferences/"))
		)
	).toEqual([]);
	expect(requestsFor(state, "POST", "/api/gateway/doctor/fix")).toEqual([]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-posture-read-only-controls"),
	});
});
