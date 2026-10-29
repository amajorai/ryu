import path from "node:path";
import { expect, test } from "@playwright/test";
import type { GatewayInlineEvaluatorProofPublisher } from "./harness/gateway-inline-evaluator-editor-proof.tsx";

const JUDGE_RUBRIC = "  Penalise replies that talk down to the user.  ";

interface EvaluatorProofWindow extends Window {
	__gatewayInlineEvaluatorProof: GatewayInlineEvaluatorProofPublisher;
}
declare const window: EvaluatorProofWindow;
type EvaluatorProofSnapshot = ReturnType<
	GatewayInlineEvaluatorProofPublisher["snapshot"]
>;
type CapturedRequest = EvaluatorProofSnapshot["requests"][number];

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
	return page.evaluate(() =>
		/* SAFETY: gateway-inline-evaluator-editor-proof.tsx installs __gatewayInlineEvaluatorProof before this proof page is evaluated. */ (
			window as EvaluatorProofWindow
		).__gatewayInlineEvaluatorProof.snapshot()
	);
}

async function chooseOption(
	page: import("@playwright/test").Page,
	dialog: import("@playwright/test").Locator,
	label: string,
	option: string | RegExp
): Promise<void> {
	await dialog.getByRole("combobox", { name: label }).click();
	await page.getByRole("option", { name: option }).click();
}

function configWrites(snapshot: EvaluatorProofSnapshot): CapturedRequest[] {
	return snapshot.requests.filter(
		(request) =>
			request.path.endsWith("/api/gateway/config") && request.method === "PUT"
	);
}

function gatewayRestarts(snapshot: EvaluatorProofSnapshot): CapturedRequest[] {
	return snapshot.requests.filter(
		(request) =>
			request.path.endsWith("/api/gateway/restart") && request.method === "POST"
	);
}

test.describe.configure({ timeout: 90_000 });

test("creates an inline LLM judge through Gateway Safety filters, which offers no code evaluator, and retries a failed save", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto("/gateway-inline-evaluator-editor-proof.html");
	await expect(
		page.getByRole("heading", { name: "Safety filters" })
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Evaluators" })).toBeVisible();
	await expect(
		page.getByText("Coverage PII detector", { exact: true })
	).toBeVisible();

	await readProof(page);
	// Safety filters lists only evaluators the Gateway can run inline, and the
	// Gateway does not run code, so a code evaluator made here would never be
	// listed. The page offers the judge editor alone; code evaluators belong to
	// the agent Evals surface.
	await expect(
		page.getByRole("button", { name: "Code evaluator", exact: true })
	).toHaveCount(0);
	const judgeEditorButton = page.getByRole("button", {
		name: "LLM-as-a-Judge",
		exact: true,
	});
	await judgeEditorButton.click();
	let editor = page.getByRole("dialog", {
		name: "New LLM-as-a-Judge evaluator",
	});
	await expect(editor).toBeVisible();
	await expect(
		editor.getByRole("button", { name: "Save evaluator" })
	).toBeDisabled();
	await editor.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(editor).toHaveCount(0);
	const afterCancel = await readProof(page);
	expect(configWrites(afterCancel)).toEqual([]);
	expect(gatewayRestarts(afterCancel)).toEqual([]);

	await judgeEditorButton.click();
	editor = page.getByRole("dialog", { name: "New LLM-as-a-Judge evaluator" });
	await editor.getByLabel("Name").fill("  Request Tone Guard  ");
	await chooseOption(page, editor, "Category", "Security");
	await chooseOption(page, editor, "Target", /^Input/u);
	await editor.getByLabel("Pass threshold (0–1)").fill("0.85");
	await editor.getByLabel("Judge model (optional)").fill("coverage-judge");
	await editor
		.getByRole("switch", { name: "Available as inline guardrail" })
		.click();
	const rubric = editor.getByLabel("Rubric");
	await rubric.fill(JUDGE_RUBRIC);

	const expectedEvaluator = {
		builtin: false,
		capabilities: { inline: true, offline: true },
		category: "security",
		description: "Custom LLM-as-a-Judge evaluator.",
		enforced: true,
		higherIsBetter: true,
		id: "request_tone_guard",
		impl: { kind: "llm_judge", rubric: JUDGE_RUBRIC.trim() },
		inline: { action: "warn_and_continue" },
		name: "Request Tone Guard",
		offline: { judgeModel: "coverage-judge", threshold: 0.85 },
		target: "input",
	};

	await page.evaluate(() => {
		/* SAFETY: gateway-inline-evaluator-editor-proof.tsx installs __gatewayInlineEvaluatorProof before this proof page is evaluated. */ (
			window as EvaluatorProofWindow
		).__gatewayInlineEvaluatorProof.failNextConfigWrite = true;
	});
	await editor.getByRole("button", { name: "Save evaluator" }).click();
	await expect(editor.getByText(/failed: 503/u)).toBeVisible();
	await expect(editor.getByLabel("Name")).toHaveValue("  Request Tone Guard  ");
	await expect(rubric).toHaveValue(JUDGE_RUBRIC);
	const failed = await readProof(page);
	expect(configWrites(failed)).toEqual([
		{
			body: { custom_evaluators: [expectedEvaluator] },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	expect(gatewayRestarts(failed)).toEqual([]);
	expect(
		failed.catalog.some((evaluator) => evaluator.id === "request_tone_guard")
	).toBe(false);
	await expect(
		page.getByRole("switch", { name: "Enable Request Tone Guard" })
	).toHaveCount(0);

	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("desktop-gateway-inline-evaluator-save-retry-error"),
	});
	await editor.getByRole("button", { name: "Save evaluator" }).click();
	await expect(editor).toHaveCount(0);

	const saved = await readProof(page);
	expect(saved.config.custom_evaluators).toEqual([expectedEvaluator]);
	expect(saved.catalog).toContainEqual(expectedEvaluator);
	expect(configWrites(saved)).toEqual([
		{
			body: { custom_evaluators: [expectedEvaluator] },
			method: "PUT",
			path: "/api/gateway/config",
		},
		{
			body: { custom_evaluators: [expectedEvaluator] },
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
	expect(gatewayRestarts(saved)).toHaveLength(1);
	// The saved judge is inline-capable, so Safety filters now lists it with the
	// same enable switch as the built-in detector.
	await expect(
		page.getByText("Coverage PII detector", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Request Tone Guard", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("switch", { name: "Enable Request Tone Guard" })
	).toBeVisible();

	await page.reload();
	await expect(page.getByRole("heading", { name: "Evaluators" })).toBeVisible();
	await expect(
		page.getByText("Coverage PII detector", { exact: true })
	).toBeVisible();
	expect((await readProof(page)).config.custom_evaluators).toEqual([
		expectedEvaluator,
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("desktop-gateway-inline-evaluator-created"),
	});
	expect(pageErrors).toEqual([]);
});
