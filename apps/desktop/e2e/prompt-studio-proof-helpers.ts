// Shared helpers for the Prompt Studio proof specs (split from
// prompt-studio-proof.spec.ts to stay under the file size limit).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { z } from "zod";
import { pluginDocumentSchema } from "../src/lib/api/plugin-wire-values.ts";
import type { PromptStudioFixtureHooks } from "./prompt-studio-fixture-contract.ts";

declare global {
	interface Window {
		__promptStudioProof: PromptStudioFixtureHooks;
	}
}

export const exportedPromptFixtureSchema = z.object({
	defaultTest: pluginDocumentSchema,
	evaluateOptions: pluginDocumentSchema,
	judge_model: z.string(),
	prompts: z.array(
		z.union([
			z.string(),
			z.object({ content: z.string(), id: z.string(), name: z.string() }),
		])
	),
	providers: z.array(z.string()),
	tests: z.array(
		z.object({
			assert: z.array(
				z.object({ type: z.string(), value: z.string(), weight: z.number() })
			),
			id: z.string(),
			prompt: z.string(),
			threshold: z.number(),
		})
	),
});

export const evidence = (name: string) =>
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence",
		name
	);

export async function readProof(page: import("@playwright/test").Page) {
	return await page.evaluate(() => window.__promptStudioProof.snapshot());
}

export async function armFailure(
	page: import("@playwright/test").Page,
	operation: string
): Promise<void> {
	await page.evaluate(
		(name) => window.__promptStudioProof.armFailure(name),
		operation
	);
}

export async function downloadedText(
	download: import("@playwright/test").Download
) {
	const filePath = await download.path();
	expect(filePath).not.toBeNull();
	if (filePath === null) {
		throw new Error("Prompt Studio download path is missing.");
	}
	return await readFile(filePath, "utf8");
}
