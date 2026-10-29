import path from "node:path";
import { expect, test } from "@playwright/test";

interface CapturedEvalRequest {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
}

interface EvalResultTooltipWindow extends Window {
	__gatewayEvalResultTooltipProof: {
		requests: CapturedEvalRequest[];
	};
}

const LONG_PROMPT =
	"A release engineer opens a production incident after a deploy, compares the request latency with the previous stable build, and chooses the safest rollback plan.";

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

test("a completed eval exposes the full truncated prompt and exact run request", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto("/gateway-eval-result-tooltip-proof.html");
	await expect(page.getByRole("heading", { name: "Run evals" })).toBeVisible();

	await page.getByLabel("Model").fill("  tooltip-proof-model  ");
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Aggregate" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Cases" })).toBeVisible();
	await expect(
		page.getByRole("row", { name: /A release engineer opens/u })
	).toContainText("91%");
	await expect(
		page.getByRole("row", { name: /A release engineer opens/u })
	).toContainText("pass");

	const requestState = await page.evaluate(
		() =>
			/* SAFETY: gateway-eval-result-tooltip-proof.tsx installs __gatewayEvalResultTooltipProof before this proof page is evaluated. */ (
				window as EvalResultTooltipWindow
			).__gatewayEvalResultTooltipProof.requests
	);
	expect(requestState).toEqual([
		{
			authorization: "Bearer gateway-eval-result-tooltip-proof-token",
			body: { dataset: [], model: "tooltip-proof-model" },
			method: "POST",
			path: "/api/gateway/evals/run",
		},
	]);

	await page
		.getByRole("cell")
		.filter({ hasText: LONG_PROMPT.slice(0, 35) })
		.hover();
	const promptTooltip = page
		.locator('[data-slot="tooltip-content"]')
		.filter({ hasText: LONG_PROMPT });
	await expect(promptTooltip).toHaveText(LONG_PROMPT);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-evals-full-case-prompt-tooltip"),
	});
	expect(pageErrors).toEqual([]);
});
