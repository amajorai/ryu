import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import type {
	GitGovernanceSettings,
	WorktreeGovernanceSettings,
} from "../src/lib/api/governance.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for gateway-governance-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export type GovernanceKind = "git" | "worktrees";
export interface GovernanceProofCall {
	body: unknown;
	method: string;
	path: string;
	status: number;
}
export interface GovernanceProofSnapshot {
	layers: Array<{
		scope: string;
		values: {
			git?: GitGovernanceSettings;
			worktrees?: WorktreeGovernanceSettings;
		};
	}>;
	schemaVersion: number;
}

export function governanceFixture(page: Page) {
	return page.evaluate(() => {
		const proof =
			/* SAFETY: gateway-governance-proof.tsx installs __GATEWAY_GOVERNANCE_PROOF__ before this proof page is evaluated. */ (
				window as Window & {
					__GATEWAY_GOVERNANCE_PROOF__?: {
						armFailure: (kind: GovernanceKind) => void;
						calls: () => GovernanceProofCall[];
						releaseHeldRead: () => void;
						snapshot: () => GovernanceProofSnapshot;
					};
				}
			).__GATEWAY_GOVERNANCE_PROOF__;
		return proof
			? {
					calls: proof.calls(),
					snapshot: proof.snapshot(),
				}
			: null;
	});
}

export async function governanceCalls(
	page: Page
): Promise<GovernanceProofCall[]> {
	return (
		(await governanceFixture(page)
			.then((fixture) => fixture?.calls)
			.catch(() => null)) ?? []
	);
}

export async function armGovernanceFailure(
	page: Page,
	kind: GovernanceKind
): Promise<void> {
	await page.evaluate((failureKind) => {
		const proof =
			/* SAFETY: gateway-governance-proof.tsx installs __GATEWAY_GOVERNANCE_PROOF__ before this proof page is evaluated. */ (
				window as Window & {
					__GATEWAY_GOVERNANCE_PROOF__?: {
						armFailure: (value: GovernanceKind) => void;
					};
				}
			).__GATEWAY_GOVERNANCE_PROOF__;
		proof?.armFailure(failureKind);
	}, kind);
}

export async function waitForGovernanceWrite(
	page: Page,
	kind: GovernanceKind,
	count: number,
	scope: "node" | "user",
	values: GitGovernanceSettings | WorktreeGovernanceSettings,
	status = 200
): Promise<void> {
	const path = `/api/gateway/governance/${kind}`;
	await expect
		.poll(
			async () =>
				(await governanceCalls(page)).filter(
					(call) => call.path === path && call.method === "PUT"
				).length
		)
		.toBe(count);
	const writes = (await governanceCalls(page)).filter(
		(call) => call.path === path && call.method === "PUT"
	);
	expect(writes.at(-1)).toEqual({
		body: { scope, values },
		method: "PUT",
		path,
		status,
	});
}

export async function persistedGovernance(
	page: Page
): Promise<GovernanceProofSnapshot> {
	const fixture = await governanceFixture(page);
	if (!fixture) {
		throw new Error("Gateway governance fixture was not installed.");
	}
	return fixture.snapshot;
}

export async function fillAndBlur(
	locator: Locator,
	value: string
): Promise<void> {
	await locator.fill(value);
	await locator.evaluate((element) => element.blur());
}

export function evidencePath(name: string): string {
	// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
	// the tracked proof ledger; without it the committed evidence is refreshed.
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	if (override) {
		return path.join(override, `${name}.png`);
	}
	return proofEvidencePath(`test-coverage-sweep-20260924/evidence/${name}.png`);
}
