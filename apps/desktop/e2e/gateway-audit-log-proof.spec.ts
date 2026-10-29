import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";

interface AuditEntryFixture {
	agent_id: string | null;
	api_key: string | null;
	backend: string | null;
	command: string | null;
	cost_micro_usd: number | null;
	duration_ms: number | null;
	error: string | null;
	eval_score: number | null;
	event_type: string | null;
	feature: string | null;
	id: string;
	input_tokens: number | null;
	latency_ms: number | null;
	model: string | null;
	output_tokens: number | null;
	prompt_cache_outcome: string | null;
	prompt_cache_read_tokens: number | null;
	prompt_cache_write_tokens: number | null;
	provider: string | null;
	request_id: string;
	session_id: string | null;
	timestamp: string;
	user_id: string | null;
	user_name: string | null;
}

interface AuditRequestRecord {
	authorization: string | null;
	errorsOnly: string | null;
	limit: string | null;
	method: string;
	url: string;
}

type FixtureMode =
	| "filter-refresh"
	| "request-error"
	| "empty-refresh"
	| "unreachable";

interface FixtureState {
	auditRequests: AuditRequestRecord[];
	mode: FixtureMode;
	pageErrors: string[];
	recoverRequestError: boolean;
	releaseInitialAudit: () => void;
	rows: AuditEntryFixture[];
}

const API_BASE = "http://127.0.0.1:7984";

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

function entry(
	overrides: Partial<AuditEntryFixture> &
		Pick<AuditEntryFixture, "id" | "request_id" | "timestamp">
): AuditEntryFixture {
	return {
		agent_id: null,
		api_key: "***",
		backend: null,
		command: null,
		cost_micro_usd: null,
		duration_ms: null,
		error: null,
		eval_score: null,
		event_type: "model_call",
		feature: null,
		input_tokens: 120,
		latency_ms: 440,
		model: "gpt-coverage",
		output_tokens: 35,
		prompt_cache_outcome: null,
		prompt_cache_read_tokens: null,
		prompt_cache_write_tokens: null,
		provider: "openai",
		session_id: "session-coverage",
		user_id: null,
		user_name: null,
		...overrides,
	};
}

const successEntry = entry({
	agent_id: "agent-reviewer",
	eval_score: 0.84,
	id: "audit-success-001",
	input_tokens: 123,
	latency_ms: 1450,
	model: "gpt-5.5-coverage",
	output_tokens: 45,
	request_id: "req-audit-success-001",
	session_id: "session-audit-001",
	timestamp: "2026-08-12T12:34:56.000Z",
	user_name: "Mina Example",
});

const failedEntry = entry({
	agent_id: "agent-deploy",
	backend: "local",
	command: "shell.run",
	error: "Command exited with status 2",
	event_type: "exec_call",
	id: "audit-failed-002",
	input_tokens: null,
	latency_ms: 350,
	model: null,
	output_tokens: null,
	provider: null,
	request_id: "req-audit-failed-002",
	session_id: "session-audit-002",
	timestamp: "2026-08-12T12:35:12.000Z",
	user_id: "user-42",
});

const refreshedFailedEntry = entry({
	agent_id: "agent-policy",
	command: "firewall.block",
	error: "Blocked by the configured policy",
	event_type: "control_change",
	id: "audit-failed-003",
	input_tokens: null,
	latency_ms: 11,
	model: null,
	output_tokens: null,
	provider: null,
	request_id: "req-audit-failed-003",
	session_id: null,
	timestamp: "2026-08-12T12:36:00.000Z",
});

function jsonResponse<FixturePayload>(body: FixturePayload, status = 200) {
	return {
		contentType: "application/json",
		body: JSON.stringify(body),
		status,
	};
}

async function installGatewayFixture(
	page: Page,
	mode: FixtureMode
): Promise<FixtureState> {
	const state: FixtureState = {
		auditRequests: [],
		mode,
		pageErrors: [],
		recoverRequestError: false,
		releaseInitialAudit: () => undefined,
		rows:
			mode === "filter-refresh"
				? [successEntry, failedEntry]
				: mode === "empty-refresh"
					? []
					: [successEntry],
	};
	let releaseInitialAudit: () => void = () => undefined;
	const initialAuditHold =
		mode === "filter-refresh"
			? new Promise<void>((resolve) => {
					releaseInitialAudit = resolve;
				})
			: null;
	state.releaseInitialAudit = () => releaseInitialAudit();
	let auditReads = 0;
	await page.route(`${API_BASE}/**`, async (route: Route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname === "/api/gateway/status") {
			await route.fulfill(
				jsonResponse({
					health: {
						auth_required: true,
						providers: ["openai"],
						status: "ok",
						version: "fixture",
					},
					metrics: {},
					reachable: true,
					url: API_BASE,
				})
			);
			return;
		}
		if (url.pathname === "/api/gateway/audit") {
			auditReads += 1;
			state.auditRequests.push({
				authorization: request.headers().authorization ?? null,
				errorsOnly: url.searchParams.get("errors_only"),
				limit: url.searchParams.get("limit"),
				method: request.method(),
				url: request.url(),
			});
			if (auditReads === 1 && initialAuditHold) {
				await initialAuditHold;
			}
			if (state.mode === "request-error" && !state.recoverRequestError) {
				await route.fulfill(
					jsonResponse({ error: "audit fixture temporarily unavailable" }, 503)
				);
				return;
			}
			if (state.mode === "unreachable" && auditReads === 1) {
				await route.fulfill(
					jsonResponse({ count: 0, entries: [], reachable: false })
				);
				return;
			}
			const errorsOnly = url.searchParams.get("errors_only") === "true";
			const entries = errorsOnly
				? state.rows.filter((candidate) => candidate.error !== null)
				: state.rows;
			await route.fulfill(
				jsonResponse({ count: entries.length, entries, reachable: true })
			);
			return;
		}
		if (url.pathname === "/api/plugins") {
			await route.fulfill(jsonResponse({ apps: [] }));
			return;
		}
		if (url.pathname === "/api/plugins/contributions") {
			await route.fulfill(jsonResponse({ settings_tabs: [] }));
			return;
		}
		await route.fulfill(jsonResponse({}));
	});
	return state;
}

async function openAuditLog(
	page: Page,
	mode: FixtureMode
): Promise<FixtureState> {
	const state = await installGatewayFixture(page, mode);
	page.on("pageerror", (error) => state.pageErrors.push(error.message));
	await page.goto("/gateway-audit-log-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
	return state;
}

test.describe.configure({ timeout: 60_000 });

test("filters real audit rows by error and refreshes the active result set", async ({
	page,
}) => {
	const state = await openAuditLog(page, "filter-refresh");
	await expect(page.getByText("Loading…", { exact: true })).toBeVisible();
	state.releaseInitialAudit();
	await expect(
		page.getByText("gpt-5.5-coverage", { exact: true })
	).toBeVisible();
	await expect(page.getByText("Command exited with status 2")).toBeVisible();
	await expect(page.getByText("123 / 45 tokens")).toBeVisible();
	await expect(page.getByText("1.4s · 84% score")).toBeVisible();
	await expect(
		page.getByText("agent agent-reviewer", { exact: true })
	).toBeVisible();
	await expect(page.getByText("request req-audit-success-001")).toBeVisible();
	await expect(page.getByText("session session-audit-001")).toBeVisible();
	await expect(page.getByText("***", { exact: true })).toHaveCount(0);
	const successRow = page
		.getByRole("row")
		.filter({ hasText: "req-audit-success-001" });
	await successRow.getByRole("cell").first().hover();
	await expect(
		page
			.locator('[data-slot="tooltip-content"]')
			.filter({ hasText: successEntry.timestamp })
	).toHaveText(successEntry.timestamp);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-audit-log-full-timestamp-tooltip"),
	});
	await page.getByRole("heading", { name: "Audit log" }).hover();

	const errorsOnly = page.getByRole("switch", { name: "Errors only" });
	await errorsOnly.click();
	await expect(errorsOnly).toBeChecked();
	await expect(page.getByText("Command exited with status 2")).toBeVisible();
	await expect(page.getByText("gpt-5.5-coverage", { exact: true })).toHaveCount(
		0
	);
	await expect(page.getByText("Tool execution", { exact: true })).toBeVisible();
	expect(
		state.auditRequests.map(({ errorsOnly, limit }) => ({ errorsOnly, limit }))
	).toEqual([
		{ errorsOnly: null, limit: "100" },
		{ errorsOnly: "true", limit: "100" },
	]);
	expect(
		state.auditRequests.every(
			({ authorization, method }) =>
				authorization === "Bearer gateway-audit-proof-token" && method === "GET"
		)
	).toBe(true);

	state.rows.push(refreshedFailedEntry);
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect(
		page.getByText("Blocked by the configured policy")
	).toBeVisible();
	await expect(page.getByText("req-audit-failed-003")).toBeVisible();
	expect(state.auditRequests.at(-1)).toMatchObject({
		errorsOnly: "true",
		limit: "100",
	});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-audit-log-errors-filter-and-refresh"),
	});
	expect(state.pageErrors).toEqual([]);
});

test("recovers from an HTTP audit read error with the visible retry action", async ({
	page,
}) => {
	const state = await openAuditLog(page, "request-error");
	await expect(page.getByText("Could not load audit log")).toBeVisible();
	await expect(
		page.getByText(/\/api\/gateway\/audit\?limit=100 failed: 503/)
	).toBeVisible();
	expect(state.auditRequests).toHaveLength(1);
	const failedReadsBeforeRetry = state.auditRequests.length;
	state.recoverRequestError = true;
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(
		page.getByText("gpt-5.5-coverage", { exact: true })
	).toBeVisible();
	expect(state.auditRequests).toHaveLength(failedReadsBeforeRetry + 1);
	expect(state.auditRequests.every((request) => request.limit === "100")).toBe(
		true
	);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-audit-log-request-error-recovered"),
	});
	expect(state.pageErrors).toEqual([]);
});

test("recovers from an empty audit log when a later refresh finds new activity", async ({
	page,
}) => {
	const state = await openAuditLog(page, "empty-refresh");
	await expect(page.getByText("No audit entries yet")).toBeVisible();
	await expect(
		page.getByText(
			"Run a model, tool, or control action through the gateway and refresh to see its trace."
		)
	).toBeVisible();
	state.rows.push(successEntry);
	await page.getByRole("button", { name: "Refresh audit log" }).click();
	await expect(
		page.getByText("gpt-5.5-coverage", { exact: true })
	).toBeVisible();
	expect(state.auditRequests).toHaveLength(2);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-audit-log-empty-refresh-recovered"),
	});
	expect(state.pageErrors).toEqual([]);
});

test("distinguishes disabled or unreachable audit logging and retries to live rows", async ({
	page,
}) => {
	const state = await openAuditLog(page, "unreachable");
	await expect(page.getByText("Audit log unavailable")).toBeVisible();
	await expect(
		page.getByText("RYU_AUDIT_LOG=1", { exact: false })
	).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(
		page.getByText("gpt-5.5-coverage", { exact: true })
	).toBeVisible();
	expect(state.auditRequests).toHaveLength(2);
	expect(state.pageErrors).toEqual([]);
});
