import { readFileSync } from "node:fs";
import path from "node:path";
import {
	expect,
	type FrameLocator,
	type Locator,
	type Page,
} from "@playwright/test";
import { z } from "zod";
import type { CalendarProofApi } from "./calendar-companion-proof/calendar-companion-proof.tsx";
import type { ProofJsonRecord } from "./fixture-json.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for calendar-companion-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const bundlePath = path.resolve(
	import.meta.dirname,
	"../../core/src/plugin_manifest/fixtures/calendar.ui.html"
);
export const bundle = readFileSync(bundlePath, "utf8");
export const evidenceDir = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);
export const proofTime = new Date("2026-09-23T12:00:00.000Z");
export const rangeAnchor = "2026-09-23T12:00:00.000Z";

export interface JobWire {
	created_at: string;
	enabled?: boolean;
	history?: unknown[];
	id: string;
	last_outcome?: string | null;
	last_run_at?: string | null;
	name: string;
	owner_app?: string | null;
	require_approval?: boolean;
	schedule: ProofJsonRecord;
	target: ProofJsonRecord;
	updated_at: string;
}

export interface WorkflowWire {
	edges: unknown[];
	id: string;
	name: string;
	nodes: ProofJsonRecord[];
	triggers: ProofJsonRecord[];
}

export interface CapturedRequest {
	authorization: string | null;
	body: ProofJsonRecord | null;
	method: string;
	path: string;
	userJwt: string | null;
}

export interface FixtureState {
	createError: string;
	createFailuresRemaining: number;
	jobReadFailuresRemaining: number;
	jobs: JobWire[];
	requests: CapturedRequest[];
	updateError: string;
	updateFailuresRemaining: number;
	workflows: WorkflowWire[];
}

declare global {
	interface Window {
		__calendarProof: CalendarProofApi;
	}
}

export function job(
	id: string,
	name: string,
	target: ProofJsonRecord,
	schedule: ProofJsonRecord,
	extra: Partial<JobWire> = {}
): JobWire {
	return {
		created_at: rangeAnchor,
		enabled: true,
		history: [],
		id,
		last_outcome: null,
		last_run_at: null,
		name,
		require_approval: false,
		schedule,
		target,
		updated_at: rangeAnchor,
		...extra,
	};
}

export function workflow(
	id: string,
	name: string,
	options: Partial<WorkflowWire> = {}
): WorkflowWire {
	return {
		edges: [],
		id,
		name,
		nodes: [],
		triggers: [],
		...options,
	};
}

export const JobSchema = z.object({
	created_at: z.string(),
	enabled: z.boolean().optional(),
	history: z.array(z.json()).optional(),
	id: z.string(),
	last_outcome: z.string().nullable().optional(),
	last_run_at: z.string().nullable().optional(),
	name: z.string(),
	owner_app: z.string().nullable().optional(),
	require_approval: z.boolean().optional(),
	schedule: z.record(z.string(), z.json()),
	target: z.record(z.string(), z.json()),
	updated_at: z.string(),
});
export const WorkflowSchema = z.object({
	edges: z.array(z.json()),
	id: z.string(),
	name: z.string(),
	nodes: z.array(z.record(z.string(), z.json())),
	triggers: z.array(z.record(z.string(), z.json())),
});
export const FixtureSchema = z.object({
	createError: z.string(),
	createFailuresRemaining: z.number(),
	jobReadFailuresRemaining: z.number(),
	jobs: JobSchema.array(),
	requests: z.array(
		z.object({
			authorization: z.string().nullable(),
			body: z.record(z.string(), z.json()).nullable(),
			method: z.string(),
			path: z.string(),
			userJwt: z.string().nullable(),
		})
	),
	updateError: z.string(),
	updateFailuresRemaining: z.number(),
	workflows: WorkflowSchema.array(),
}) satisfies z.ZodType<FixtureState>;

export async function fixtureState(page: Page): Promise<FixtureState> {
	const state = await page.evaluate(async () => {
		const response = await fetch("/__proof/state");
		if (!response.ok) {
			throw new Error(`Fixture state request failed: ${response.status}`);
		}
		return await response.json();
	});
	return FixtureSchema.parse(state);
}

export async function mountCalendar(
	page: Page,
	fixture: {
		createError?: string;
		createFailuresRemaining?: number;
		jobs?: JobWire[];
		jobReadFailuresRemaining?: number;
		updateError?: string;
		updateFailuresRemaining?: number;
		workflows?: WorkflowWire[];
	} = {}
): Promise<FrameLocator> {
	const startupErrors: string[] = [];
	page.on("pageerror", (error) => startupErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			startupErrors.push(message.text());
		}
	});
	page.on("requestfailed", (request) => {
		startupErrors.push(
			`${request.method()} ${request.url()}: ${request.failure()?.errorText}`
		);
	});
	await page.clock.setFixedTime(proofTime);
	await page.goto("/calendar-companion-proof.html");
	try {
		await page.waitForSelector('body[data-calendar-proof-ready="1"]', {
			timeout: 10_000,
		});
	} catch (error) {
		const html = await page.locator("body").innerHTML();
		throw new Error(
			`Calendar harness boot failed: ${String(error)}; errors=${startupErrors.join(" | ")}; body=${html}`
		);
	}
	const reset = await page.evaluate(async (serializedState) => {
		const response = await fetch("/__proof/reset", {
			body: serializedState,
			headers: { "Content-Type": "application/json" },
			method: "POST",
		});
		return response.ok;
	}, JSON.stringify(fixture));
	expect(reset).toBe(true);
	await page.evaluate(
		(appHtml) => window.__calendarProof.mount(appHtml),
		bundle
	);
	await expect
		.poll(() => page.evaluate(() => window.__calendarProof.connected()), {
			timeout: 15_000,
		})
		.toBe(true);
	const calendar = page.frameLocator("#host-root iframe");
	if ((fixture.jobReadFailuresRemaining ?? 0) > 0) {
		await expect(
			calendar.getByText("Could not load calendar", { exact: true })
		).toBeVisible();
	} else {
		await expect(calendar.getByRole("button", { name: "Today" })).toBeVisible();
	}
	return calendar;
}

export function coreRequest(
	state: FixtureState,
	method: string,
	path: string
): CapturedRequest[] {
	return state.requests.filter(
		(request) => request.method === method && request.path === path
	);
}

export async function expectButtonWithinCell(button: Locator, cell: Locator) {
	const [buttonBox, cellBox] = await Promise.all([
		button.boundingBox(),
		cell.boundingBox(),
	]);
	expect(buttonBox).not.toBeNull();
	expect(cellBox).not.toBeNull();
	if (buttonBox && cellBox) {
		expect(buttonBox.x).toBeGreaterThanOrEqual(cellBox.x);
		expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(
			cellBox.x + cellBox.width + 1
		);
	}
}

export interface ScheduleCase {
	expected: Record<string, string>;
	set?: (dialog: Locator) => ReturnType<Locator["fill"]>;
	value: string;
}
