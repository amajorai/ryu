import { expect, type Page } from "@playwright/test";
import type {
	A2aPeer,
	A2aPrincipal,
	A2aPublishedAgent,
	A2aServerConfig,
	A2aTaskRecord,
} from "../src/lib/api/a2a.ts";
import type { AgentSummary } from "../src/lib/api/agents.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for a2a-settings-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const STORY_URL = "/a2a-settings-proof.html";
// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
export const evidenceDir =
	process.env.RYU_PROOF_EVIDENCE_DIR ??
	proofEvidencePath("test-coverage-sweep-20260924/evidence");

export interface ProofCall {
	body?: unknown;
	method: string;
	path: string;
}

export interface ProofResponse {
	acknowledged: boolean;
	data: unknown;
	method: string;
	path: string;
	status: number;
}

export interface QueryDiagnostic {
	data: unknown;
	fetchStatus: string;
	key: readonly unknown[];
	observers: number;
	status: string;
}

export interface FailurePlan {
	error: string;
	method: string;
	path: string;
	status: number;
}

export interface ProofWindow extends Window {
	__a2aProof: {
		calls: () => ProofCall[];
		failNext: (failure: FailurePlan) => void;
		invalidate: () => Promise<void>;
		queries: () => QueryDiagnostic[];
		responses: () => ProofResponse[];
		state: () => {
			agents: AgentSummary[];
			config: A2aServerConfig;
			peers: A2aPeer[];
			principals: A2aPrincipal[];
			published: A2aPublishedAgent[];
			tasks: A2aTaskRecord[];
		};
		unknownRequests: () => string[];
		unmount: () => void;
	};
}

export const pageErrors = new WeakMap<Page, string[]>();

export async function expectKnownRequests(page: Page) {
	expect(
		await page.evaluate(() =>
			(window as ProofWindow).__a2aProof.unknownRequests()
		)
	).toEqual([]);
}

export async function reloadSettings(page: Page) {
	// A navigation replaces the renderer ledger, so assert the old lifetime first.
	await expectKnownRequests(page);
	await page.reload();
}

export async function openSettings(page: Page, failures: FailurePlan[] = []) {
	await page.addInitScript((initialFailures) => {
		if (sessionStorage.getItem("ryu:a2a-proof:initialized") !== "1") {
			localStorage.clear();
			localStorage.setItem(
				"ryu:a2a-proof:failures",
				JSON.stringify(initialFailures)
			);
			sessionStorage.setItem("ryu:a2a-proof:initialized", "1");
		}
	}, failures);
	await page.goto(STORY_URL);
	await expect(page.locator("body")).toHaveAttribute("data-harness-ready", "1");
}

export async function proofCalls(page: Page): Promise<ProofCall[]> {
	return await page.evaluate(() =>
		/* SAFETY: a2a-settings-proof.tsx installs __a2aProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__a2aProof.calls()
	);
}

export async function callsFor(
	page: Page,
	method: string,
	path: string
): Promise<ProofCall[]> {
	return (await proofCalls(page)).filter(
		(call) => call.method === method && call.path === path
	);
}

export async function failNext(page: Page, failure: FailurePlan) {
	await page.evaluate((nextFailure) => {
		/* SAFETY: a2a-settings-proof.tsx installs __a2aProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__a2aProof.failNext(nextFailure);
	}, failure);
}

export const PAUSED_CLOCK_STEP_MS = 10;
export const PAUSED_CLOCK_MAX_STEPS = 50;

export async function settlePausedClock(page: Page) {
	for (let step = 0; step < PAUSED_CLOCK_MAX_STEPS; step += 1) {
		await page.clock.runFor(PAUSED_CLOCK_STEP_MS);
		const settled = await page.evaluate(() => {
			const queries = (window as ProofWindow).__a2aProof.queries();
			return (
				queries.length === 5 &&
				queries.every(
					(query) => query.status === "success" && query.fetchStatus === "idle"
				)
			);
		});
		if (settled) {
			return;
		}
	}
	throw new Error(
		`A2A queries did not settle within ${PAUSED_CLOCK_STEP_MS * PAUSED_CLOCK_MAX_STEPS}ms of paused clock time`
	);
}

export async function expectToast(page: Page, message: string) {
	await expect(page.getByText(message, { exact: true })).toBeVisible();
}
