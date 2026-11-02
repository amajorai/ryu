import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { slidesStateSchema } from "../../../apps-store/slides/ui/src/schemas.ts";
import type { ProofJsonRecord, ProofJsonValue } from "./fixture-json.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for slides-behavior-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const BUNDLE = "/tmp/ryu-slides-coverage-build/index.html";
export const EVIDENCE = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);
export const GRANTS = [
	"storage:kv",
	"media:generate",
	"hook:side-model",
	"files:download",
];

export interface FixtureCall {
	args: ProofJsonRecord;
	method: string;
}
export interface SlidesProofApi {
	calls: () => FixtureCall[];
	connected: () => boolean;
	mount: (options: {
		appHtml: string;
		grants: string[];
		pluginId: string;
	}) => void;
	persisted: () => ProofJsonValue;
	reset: () => void;
}

declare global {
	interface Window {
		__slidesProof: SlidesProofApi;
	}
}

export async function mountApp(
	page: Page,
	reset = true
): Promise<FrameLocator> {
	if (reset) {
		await page.goto("/slides-companion-proof.html");
	}
	if (reset) {
		await expect(page.locator("body")).toHaveAttribute(
			"data-harness-ready",
			"1"
		);
		await page.evaluate(() => window.__slidesProof.reset());
	}
	const appHtml = await readFile(BUNDLE, "utf8");
	await page.evaluate((options) => window.__slidesProof.mount(options), {
		appHtml,
		grants: GRANTS,
		pluginId: "@ryu/slides",
	});
	await expect
		.poll(() => page.evaluate(() => window.__slidesProof.connected()), {
			timeout: 20_000,
		})
		.toBe(true);
	return page.frameLocator('iframe[title="Slides behavior proof"]');
}

export async function persisted(page: Page) {
	return slidesStateSchema
		.nullable()
		.parse(await page.evaluate(() => window.__slidesProof.persisted()));
}

export async function waitForProjectCount(page: Page, count: number) {
	await expect
		.poll(async () => {
			// SAFETY: This proof mounts the exact Playwright-built native Slides bundle against its private scoped storage Map. App saveState persists model.serializeState projects/trash from the actual normalized Project and Layer constructors; this observer reads those authored bytes through the scoped storage RPC. No foreign storage JSON is validated by this view.
			const state = await persisted(page);
			return state?.projects?.length ?? 0;
		})
		.toBe(count);
}

export async function saveEvidence(page: Page, name: string) {
	await mkdir(EVIDENCE, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE, name),
	});
}

export async function makeProject(app: FrameLocator, name: string) {
	const emptyCreate = app.getByRole("button", { name: "Make a project" });
	if (await emptyCreate.count()) {
		await emptyCreate.click();
	} else {
		await app.getByRole("button", { name: "New project" }).click();
	}
	await app.getByRole("textbox", { name: "Project name" }).fill(name);
}
