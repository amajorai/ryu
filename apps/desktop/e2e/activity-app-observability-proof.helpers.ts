import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import type { RyuBridge } from "../../../apps-store/activity/ui/src/ryu.d.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for activity-app-observability-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export type ActivityProofPayload =
	| Parameters<RyuBridge["activity"][keyof RyuBridge["activity"]]>[0]
	| Parameters<RyuBridge["shell"]["openTab"]>[0];

export type ActivityProofOperation =
	| "audit"
	| "eval"
	| "importTrace"
	| "list"
	| "openTab"
	| "prune"
	| "redteam"
	| "score"
	| "trace";

export interface ActivityProofCall {
	operation: ActivityProofOperation;
	payload?: ActivityProofPayload;
}

declare global {
	interface Window {
		__activityProof: {
			calls: () => ActivityProofCall[];
			failNext: (operation: ActivityProofOperation) => void;
		};
	}
}

export const FIXED_NOW = new Date("2026-09-26T12:00:00.000Z");
export const AGENT_ID = "observability-proof-agent";
export const RUN_ID = "run-proof-success";
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export function evidencePath(name: string): string {
	return proofEvidencePath(`test-coverage-sweep-20260924/evidence/${name}.png`);
}

export async function openActivity(page: Page, query = ""): Promise<void> {
	await page.clock.setFixedTime(FIXED_NOW);
	await page.goto(`/activity-app-observability-proof.html${query}`);
	await expect(page.getByTestId("activity-proof-status")).toHaveText(
		"Activity Companion mounted"
	);
}

export async function selectObservability(page: Page): Promise<void> {
	await page.getByRole("tab", { name: "Observability" }).click();
	await expect(
		page.getByRole("heading", { exact: true, name: "Agent observability" })
	).toBeVisible();
	await expect(page.getByText("Live · 15s", { exact: true })).toBeVisible();
	await expect(
		page.getByTestId("observability-event-audit-proof-success")
	).toBeVisible();
}

export async function openObservability(page: Page): Promise<void> {
	await openActivity(page);
	await selectObservability(page);
}

export async function proofCalls(page: Page): Promise<ActivityProofCall[]> {
	return page.evaluate(() => window.__activityProof.calls());
}

export async function callsFor(
	page: Page,
	operation: ActivityProofOperation
): Promise<ActivityProofCall[]> {
	return (await proofCalls(page)).filter(
		(call) => call.operation === operation
	);
}

export async function waitForCallCount(
	page: Page,
	operation: ActivityProofOperation,
	count: number
): Promise<void> {
	await expect
		.poll(async () => (await callsFor(page, operation)).length)
		.toBe(count);
}

export async function expectAuditWindow(
	page: Page,
	index: number,
	window: "1h" | "24h" | "7d" | "all"
): Promise<void> {
	await waitForCallCount(page, "audit", index + 1);
	const call = (await callsFor(page, "audit"))[index];
	expect(call).toBeDefined();
	const payload = z
		.object({ from: z.string().optional(), limit: z.number().optional() })
		.optional()
		.parse(call?.payload);
	expect(payload?.limit).toBe(100);
	if (window === "all") {
		expect(payload?.from).toBeUndefined();
		return;
	}
	const duration = { "1h": HOUR, "24h": DAY, "7d": 7 * DAY }[window];
	expect(payload?.from).toBe(
		new Date(FIXED_NOW.getTime() - duration).toISOString()
	);
}

export const agentCallSchema = z.object({
	agent_id: z.string(),
	model: z.string().optional(),
});
export function record(value: ActivityProofPayload) {
	return agentCallSchema.parse(value);
}
