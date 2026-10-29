import path from "node:path";
import { expect, test } from "@playwright/test";
import type { ProofJsonRecord } from "./fixture-json.ts";

interface CapturedCall {
	args?: ProofJsonRecord;
	body: unknown;
	method: string;
	path: string;
}

interface ProofSnapshot {
	coreStatus: string;
	evalAuthorization: Array<string | null>;
	evalRequests: CapturedCall[];
	requests: CapturedCall[];
	tauriCalls: Array<{ args?: ProofJsonRecord; command: string }>;
}

interface GatewayEvalsHealthWindow extends Window {
	__gatewayEvalsHealthProof: {
		armEvalFailure: () => void;
		setCoreStatus: (status: string) => void;
		snapshot: () => ProofSnapshot;
	};
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

async function openEvals(page: import("@playwright/test").Page): Promise<void> {
	await page.goto("/gateway-evals-health-proof.html?surface=evals&reset=true");
	await expect(page.getByRole("heading", { name: "Run evals" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Run", exact: true })
	).toBeVisible();
}

async function snapshot(page: import("@playwright/test").Page) {
	return page.evaluate(() =>
		/* SAFETY: gateway-evals-health-proof.mock.ts installs __gatewayEvalsHealthProof before this proof page is evaluated. */ (
			window as GatewayEvalsHealthWindow
		).__gatewayEvalsHealthProof.snapshot()
	);
}

test.describe.configure({ timeout: 90_000 });

test("runs built-in quality cases with the selected model and renders returned scores", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openEvals(page);
	await page.getByLabel("Model").fill("  coverage-model  ");
	await page.getByRole("button", { name: "Run", exact: true }).click();

	await expect(page.getByRole("heading", { name: "Aggregate" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Cases" })).toBeVisible();
	await expect(
		page.getByRole("cell", { name: "What is 2 + 2?" })
	).toBeVisible();
	await expect(
		page.getByRole("row", { name: /What is 2 \+ 2\?/ })
	).toContainText("90%");
	await expect(
		page.getByRole("row", { name: /What is 2 \+ 2\?/ })
	).toContainText("pass");
	await expect(
		page
			.getByText("Substring match", { exact: true })
			.locator("..")
			.getByText("60%", {
				exact: true,
			})
	).toBeVisible();

	const result = await snapshot(page);
	expect(result.evalAuthorization).toEqual([
		"Bearer gateway-evals-health-proof-token",
	]);
	expect(result.evalRequests).toEqual([
		{
			args: undefined,
			body: { dataset: [], model: "coverage-model" },
			method: "POST",
			path: "/api/gateway/evals/run",
		},
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-evals-scorecard-rendered"),
	});
	expect(pageErrors).toEqual([]);
});

test("shows a failed run and permits a successful retry without retaining stale results", async ({
	page,
}) => {
	await page.goto(
		"/gateway-evals-health-proof.html?surface=evals&failFirstEval=true"
	);
	await expect(page.getByRole("heading", { name: "Run evals" })).toBeVisible();
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(
		page.getByText("Provider unavailable for this run.")
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Aggregate" })).toHaveCount(0);

	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Aggregate" })).toBeVisible();
	await expect(
		page.getByText("Provider unavailable for this run.")
	).toHaveCount(0);
	const result = await snapshot(page);
	expect(result.evalRequests).toHaveLength(2);
	expect(result.evalRequests[0]?.body).toEqual({
		dataset: [],
		model: "gpt-4o-mini",
	});
	expect(result.evalRequests[1]?.body).toEqual({
		dataset: [],
		model: "gpt-4o-mini",
	});
	await page.evaluate(() =>
		/* SAFETY: gateway-evals-health-proof.mock.ts installs __gatewayEvalsHealthProof before this proof page is evaluated. */ (
			window as GatewayEvalsHealthWindow
		).__gatewayEvalsHealthProof.armEvalFailure()
	);
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(
		page.getByText("Provider unavailable for this run.")
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Aggregate" })).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Cases" })).toHaveCount(0);
	// A blank model id no longer falls back to a hosted model: Run stays
	// disabled until a model is named, and nothing is sent.
	await page.getByLabel("Model").fill("   ");
	await expect(
		page.getByRole("button", { name: "Run", exact: true })
	).toBeDisabled();
	expect((await snapshot(page)).evalRequests).toHaveLength(3);
	await page.getByLabel("Model").fill("  gpt-4o-mini  ");
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Aggregate" })).toBeVisible();
	const recovered = await snapshot(page);
	expect(recovered.evalRequests).toHaveLength(4);
	expect(recovered.evalRequests.at(-1)?.body).toEqual({
		dataset: [],
		model: "gpt-4o-mini",
	});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-evals-rerun-failure-retry-recovered"),
	});
});

test("displays a denied eval response without presenting a completed scorecard", async ({
	page,
}) => {
	await page.goto(
		"/gateway-evals-health-proof.html?surface=evals&denyEvals=true"
	);
	await expect(page.getByRole("heading", { name: "Run evals" })).toBeVisible();
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(page.getByText("Evaluation permission denied.")).toBeVisible();
	await expect(page.getByRole("heading", { name: "Aggregate" })).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Run", exact: true })
	).toBeEnabled();
	const result = await snapshot(page);
	expect(result.evalRequests).toHaveLength(1);
	expect(result.evalAuthorization).toEqual([
		"Bearer gateway-evals-health-proof-token",
	]);
});

test("preflight attempts one Core start, restarts Core on request, and refreshes the live status", async ({
	page,
}) => {
	await page.goto(
		"/gateway-evals-health-proof.html?surface=health&core=stopped&node=local"
	);
	await expect(page.getByText("not running", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Start Core", exact: true })
	).toBeVisible();
	await expect
		.poll(
			async () =>
				(await snapshot(page)).tauriCalls.filter(
					(call) => call.command === "start_ryu_core"
				).length
		)
		.toBe(1);

	await page.getByRole("button", { name: "Restart Core", exact: true }).click();
	await expect
		.poll(
			async () =>
				(await snapshot(page)).tauriCalls.filter(
					(call) => call.command === "restart_ryu_core"
				).length
		)
		.toBe(1);
	await page.evaluate(() =>
		/* SAFETY: gateway-evals-health-proof.mock.ts installs __gatewayEvalsHealthProof before this proof page is evaluated. */ (
			window as GatewayEvalsHealthWindow
		).__gatewayEvalsHealthProof.setCoreStatus("running")
	);
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect(page.getByText("running · v0.9.7")).toBeVisible();
	const result = await snapshot(page);
	expect(
		result.tauriCalls.filter((call) => call.command === "start_ryu_core")
	).toHaveLength(1);
	expect(
		result.tauriCalls.filter((call) => call.command === "restart_ryu_core")
	).toHaveLength(1);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-preflight-core-recovered"),
	});
});

test("preflight refresh reflects live gateway and helper status, and a failed helper action gives visible feedback", async ({
	page,
}) => {
	await page.goto(
		"/gateway-evals-health-proof.html?surface=health&core=running&failSidecarStart=true"
	);
	await expect(page.getByText("running · v0.9.7")).toBeVisible();
	await expect(page.getByText("can't connect", { exact: true })).toBeVisible();
	await expect(page.getByText("Helpers (1/2 running)")).toBeVisible();
	await expect(
		page.getByText("example-installed-engine", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("example-uninstalled-engine", { exact: true })
	).toHaveCount(0);

	await page.getByRole("button", { name: "Start", exact: true }).click();
	await expect(page.getByText("Sidecar install is unavailable.")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Start", exact: true })
	).toBeEnabled();
	const result = await snapshot(page);
	expect(result.requests).toContainEqual({
		args: undefined,
		body: null,
		method: "POST",
		path: "/api/sidecar/example-installed-stopped/start",
	});
});
