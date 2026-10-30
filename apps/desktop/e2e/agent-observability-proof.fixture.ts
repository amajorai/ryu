// Shared fixture for the agent observability proofs: proof state readers,
// the page opener and the exact-request helpers.
import { expect, type Page } from "@playwright/test";

export const AGENT_ID = "observability-proof-agent";
export const PROOF_TIME = new Date("2026-09-28T12:00:00.000Z");

export interface ProofRequest {
	body: unknown;
	method: string;
	path: string;
	query: Record<string, string>;
	status: number;
}

export interface ProofSnapshot {
	auditEntries: { id: string }[];
	importedRunIds: string[];
	prunedRows: number;
	requests: ProofRequest[];
	suites: { agent_id: string; id: string; name: string }[];
}

export interface ProofWindow extends Window {
	__AGENT_OBSERVABILITY_PROOF__: {
		appendRefreshFixtureEntry: () => void;
		failNext: (
			point:
				| "audit"
				| "prune"
				| "trace"
				| "suiteList"
				| "suiteCreate"
				| "traceImport"
				| "score"
				| "redteam"
		) => void;
		snapshot: () => ProofSnapshot;
	};
}

export async function readProof(page: Page): Promise<ProofSnapshot> {
	return page.evaluate(() =>
		/* SAFETY: agent-observability-proof.tsx installs __AGENT_OBSERVABILITY_PROOF__ before this proof page is evaluated. */ (
			window as ProofWindow
		).__AGENT_OBSERVABILITY_PROOF__.snapshot()
	);
}

export async function openProof(page: Page): Promise<void> {
	await page.clock.install({ time: PROOF_TIME });
	await page.goto("/agent-observability-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await expect(page.getByTestId("proof-status")).toHaveText(
		"Production UI mounted"
	);
	await expect(page.getByTestId("observability-events")).toBeVisible();
}

export function requestsFor(
	snapshot: ProofSnapshot,
	method: string,
	path: string
): ProofRequest[] {
	return snapshot.requests.filter(
		(request) => request.method === method && request.path === path
	);
}

export function expectKnownFixtureRequests(snapshot: ProofSnapshot): void {
	expect(snapshot.requests.filter((request) => request.status === 404)).toEqual(
		[]
	);
}

export function expectWindowStart(
	value: string | undefined,
	durationMs: number
): void {
	expect(value).toBeTruthy();
	const requestedStart = Date.parse(value ?? "");
	const expectedStart = PROOF_TIME.getTime() - durationMs;
	expect(Math.abs(requestedStart - expectedStart)).toBeLessThan(2000);
}
