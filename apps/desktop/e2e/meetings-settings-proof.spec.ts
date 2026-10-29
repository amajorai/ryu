import path from "node:path";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { z } from "zod";

const PROOF_URL = "/meetings-settings-proof.html";
const NODE_TOKEN = "meetings-settings-proof-node-token";
const USER_JWT = "meetings-settings-proof-user-jwt";
// Verification runs set RYU_PROOF_OUTPUT_ROOT so screenshots land in scratch
// space instead of rewriting the tracked sweep evidence.
const EVIDENCE_DIR = process.env.RYU_PROOF_OUTPUT_ROOT
	? path.resolve(process.env.RYU_PROOF_OUTPUT_ROOT)
	: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/test-coverage-sweep-20260924/evidence"
		);

interface DetectionConfig {
	apps: string[];
	enabled: boolean;
}

interface CapturedRequest {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
	status: number | null;
	url: string;
	userJwt: string | null;
}

interface FixtureOptions {
	detection?: DetectionConfig;
	failures?: Array<{ method: string; path: string; status?: number }>;
	preferences?: Record<string, string>;
}

interface MeetingsFixture {
	armFailure: (method: string, path: string, status?: number) => void;
	preference: (key: string) => string | null;
	requests: CapturedRequest[];
	snapshotDetection: () => DetectionConfig;
}

const defaultPreferences = {
	"meeting-diarization-enabled": "false",
	"meeting-diarization-model": "pyannote",
	"meeting-notes-effort": "medium",
	"meeting-notes-model": "gpt-4.1-mini",
	"meeting-notes-prompt": "Keep the transcript grounded.",
	"meeting-notes-template": "general",
};

const templates = [
	{ id: "general", name: "General" },
	{ id: "standup", name: "Daily standup" },
	{ id: "interview", name: "Interview" },
];

const catalog = {
	apiTypes: ["openai-completions"],
	providers: [
		{
			authKind: "api-key",
			configured: true,
			custom: false,
			id: "openai",
			label: "OpenAI",
			modelOverrides: {},
			routing: "gateway",
			suggestedModels: ["gpt-4.1-mini", "gpt-4.1"],
			supportsDiscovery: false,
		},
	],
	thinkingLevels: ["low", "medium", "high"],
};

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

async function fulfillResponse(
	route: Route,
	response: Response
): Promise<void> {
	await route.fulfill({
		body: await response.text(),
		contentType: "application/json",
		status: response.status,
	});
}

function requestBody(route: Route) {
	const body = route.request().postData();
	if (!body) {
		return null;
	}
	try {
		return route.request().postDataJSON();
	} catch {
		return body;
	}
}

async function installMeetingsFixture(
	page: Page,
	options: FixtureOptions = {}
): Promise<MeetingsFixture> {
	const preferences = new Map(
		Object.entries({ ...defaultPreferences, ...options.preferences })
	);
	let detection: DetectionConfig = {
		apps: options.detection?.apps ?? ["zoom", "teams"],
		enabled: options.detection?.enabled ?? true,
	};
	const requests: CapturedRequest[] = [];
	const failures = new Map<string, number[]>();
	for (const failure of options.failures ?? []) {
		const key = `${failure.method.toUpperCase()} ${failure.path}`;
		failures.set(key, [...(failures.get(key) ?? []), failure.status ?? 503]);
	}

	const fixture: MeetingsFixture = {
		armFailure: (method, path, status = 503) => {
			const key = `${method.toUpperCase()} ${path}`;
			failures.set(key, [...(failures.get(key) ?? []), status]);
		},
		preference: (key) => preferences.get(key) ?? null,
		requests,
		snapshotDetection: () => structuredClone(detection),
	};

	await page.route("http://127.0.0.1:5573/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method().toUpperCase();
		const record: CapturedRequest = {
			body: requestBody(route),
			method,
			path: url.pathname,
			status: null,
			url: url.origin,
			authorization: request.headers().authorization ?? null,
			userJwt: request.headers()["x-ryu-user-jwt"] ?? null,
		};
		requests.push(record);

		const failureKey = `${method} ${url.pathname}`;
		const nextFailures = failures.get(failureKey);
		const failStatus = nextFailures?.shift();
		if (nextFailures && nextFailures.length === 0) {
			failures.delete(failureKey);
		}
		if (failStatus !== undefined) {
			record.status = failStatus;
			await fulfillResponse(
				route,
				json({ error: "fixture_unavailable" }, failStatus)
			);
			return;
		}

		let response: Response;
		if (
			url.pathname === "/api/preferences/" ||
			url.pathname.startsWith("/api/preferences/")
		) {
			const key = decodeURIComponent(
				url.pathname.slice("/api/preferences/".length)
			);
			if (method === "GET") {
				const value = preferences.get(key);
				response =
					value === undefined
						? json({ error: "not found" }, 404)
						: json({ key, value });
			} else if (method === "PUT") {
				const parsed = z.object({ value: z.string() }).safeParse(record.body);
				if (!parsed.success) {
					record.status = 400;
					await fulfillResponse(
						route,
						json({ error: "value must be a string" }, 400)
					);
					return;
				}
				const body = parsed.data;
				preferences.set(key, body.value);
				response = json({ key, value: body.value });
			} else {
				response = json({ error: "method not allowed" }, 405);
			}
		} else if (url.pathname === "/api/meetings/detection-config") {
			if (method === "GET") {
				response = json(detection);
			} else if (method === "PUT") {
				const patch = z
					.object({
						apps: z.array(z.string()).optional(),
						enabled: z.boolean().optional(),
					})
					.parse(record.body ?? {});
				detection = { ...detection, ...patch };
				response = json(detection);
			} else {
				response = json({ error: "method not allowed" }, 405);
			}
		} else if (url.pathname === "/api/meetings/templates") {
			response = json({ templates });
		} else if (url.pathname === "/api/pi-config/catalog") {
			response = json(catalog);
		} else if (url.pathname === "/api/agents") {
			response = json({ agents: [] });
		} else if (url.pathname === "/api/engines") {
			response = json({ engines: [] });
		} else if (url.pathname === "/api/engine/active") {
			response = json({ active: "gateway", running: true, available: [] });
		} else {
			response = json({});
		}

		record.status = response.status;
		await route.fulfill({
			body: await response.text(),
			contentType: "application/json",
			status: response.status,
		});
	});
	return fixture;
}

async function openSettings(page: Page) {
	await page.goto(PROOF_URL);
}

function expectNodeScopedRequests(fixture: MeetingsFixture, origin: string) {
	expect(fixture.requests.length).toBeGreaterThan(0);
	for (const request of fixture.requests) {
		expect(request.url).toBe(origin);
		expect(request.authorization).toBe(`Bearer ${NODE_TOKEN}`);
		expect(request.userJwt).toBe(USER_JWT);
	}
}

test.describe("Desktop Meetings settings", () => {
	test("recovers from a failed node-scoped load with Retry and reloads the complete settings state", async ({
		page,
	}) => {
		const fixture = await installMeetingsFixture(page, {
			failures: [
				{ method: "GET", path: "/api/preferences/meeting-notes-model" },
			],
		});
		await openSettings(page);
		await expect(
			page.getByText(/We couldn't load your meeting settings/)
		).toBeVisible();
		await page.getByRole("button", { name: "Retry" }).click();
		await expect(
			page.getByRole("heading", { name: "Notes model" })
		).toBeVisible();
		await expect(
			page.getByRole("textbox", { name: "Meeting apps" })
		).toHaveValue("zoom, teams");
		const reads = fixture.requests.filter(
			(request) =>
				request.method === "GET" &&
				request.path === "/api/preferences/meeting-notes-model"
		);
		expect(reads.map((request) => request.status)).toEqual([503, 200]);
		expect(
			fixture.requests.some(
				(request) => request.path === "/api/meetings/templates"
			)
		).toBe(true);
		expect(
			fixture.requests.some(
				(request) => request.path === "/api/meetings/detection-config"
			)
		).toBe(true);
		expectNodeScopedRequests(fixture, "http://127.0.0.1:5573");
	});

	test("saves model and effort with exact preference values, rolls back a failed write, retries, and persists after reload", async ({
		page,
	}) => {
		const fixture = await installMeetingsFixture(page);
		await openSettings(page);
		const modelButton = page.getByRole("button", {
			name: "Model",
			exact: true,
		});
		await expect(modelButton).toContainText("gpt-4.1-mini");

		fixture.armFailure("PUT", "/api/preferences/meeting-notes-model");
		await modelButton.click();
		const customModel = page.getByRole("textbox", { name: "Custom model id" });
		await customModel.fill("  local/meeting-notes-v2  ");
		await page.getByRole("button", { name: "Use this model" }).click();
		await expect(modelButton).toContainText("gpt-4.1-mini");
		await expect(page.getByText("Couldn't save the notes model")).toBeVisible();
		expect(fixture.preference("meeting-notes-model")).toBe("gpt-4.1-mini");

		await modelButton.click();
		await page
			.getByRole("textbox", { name: "Custom model id" })
			.fill("  local/meeting-notes-v2  ");
		await page.getByRole("button", { name: "Use this model" }).click();
		await expect(modelButton).toContainText("local/meeting-notes-v2");
		expect(fixture.preference("meeting-notes-model")).toBe(
			"local/meeting-notes-v2"
		);

		const effort = page.getByRole("combobox").first();
		await effort.click();
		await page.getByRole("option", { name: "high" }).click();
		await expect(effort).toContainText("high");
		expect(fixture.preference("meeting-notes-effort")).toBe("high");

		const modelWrites = fixture.requests.filter(
			(request) =>
				request.method === "PUT" &&
				request.path === "/api/preferences/meeting-notes-model"
		);
		expect(
			modelWrites.map((request) => [request.body, request.status])
		).toEqual([
			[{ value: "local/meeting-notes-v2" }, 503],
			[{ value: "local/meeting-notes-v2" }, 200],
			[{ value: "local/meeting-notes-v2" }, 200],
		]);
		const effortWrites = fixture.requests.filter(
			(request) =>
				request.method === "PUT" &&
				request.path === "/api/preferences/meeting-notes-effort"
		);
		expect(effortWrites.map((request) => request.body)).toEqual([
			{ value: "medium" },
			{ value: "medium" },
			{ value: "high" },
		]);
		expect(
			fixture.requests.some(
				(request) => request.path === "/api/preferences/meeting-notes-provider"
			)
		).toBe(false);
		expectNodeScopedRequests(fixture, "http://127.0.0.1:5573");
		await page.reload();
		await expect(
			page.getByRole("button", { name: "Model", exact: true })
		).toContainText("local/meeting-notes-v2");
		await expect(page.getByRole("combobox").first()).toContainText("high");
		await page.screenshot({
			animations: "disabled",
			fullPage: true,
			path: path.join(
				EVIDENCE_DIR,
				"desktop-meetings-settings-model-effort.png"
			),
		});
	});

	test("saves prompt text verbatim on blur, preserves the draft after a failed request, and retries it", async ({
		page,
	}) => {
		const fixture = await installMeetingsFixture(page);
		await openSettings(page);
		const prompt =
			"Write a concise summary.\n\nKeep named owners and exact dates.";
		const textarea = page.getByPlaceholder(
			"Using the built-in default prompt…"
		);
		fixture.armFailure("PUT", "/api/preferences/meeting-notes-prompt");
		await textarea.fill(prompt);
		await page.getByRole("heading", { name: "Notes template" }).click();
		await expect(
			page.getByText("Couldn't save the notes prompt")
		).toBeVisible();
		await expect(textarea).toHaveValue(prompt);
		await textarea.focus();
		await textarea.press("Tab");
		// The blur-triggered retry is asynchronous: poll the fixture's request log
		// instead of reading it once, which raced the PUT's arrival.
		await expect
			.poll(() =>
				fixture.requests
					.filter(
						(request) =>
							request.method === "PUT" &&
							request.path === "/api/preferences/meeting-notes-prompt"
					)
					.map((request) => [request.body, request.status])
			)
			.toEqual([
				[{ value: prompt }, 503],
				[{ value: prompt }, 200],
			]);
		expect(fixture.preference("meeting-notes-prompt")).toBe(prompt);
		expectNodeScopedRequests(fixture, "http://127.0.0.1:5573");
		await page.reload();
		await expect(
			page.getByPlaceholder("Using the built-in default prompt…")
		).toHaveValue(prompt);
	});

	test("saves the selected template, rolls back its selected value after a 503, retries, and restores it", async ({
		page,
	}) => {
		const fixture = await installMeetingsFixture(page);
		await openSettings(page);
		const template = page.getByRole("combobox", { name: "Notes template" });
		await expect(template).toContainText("General");
		fixture.armFailure("PUT", "/api/preferences/meeting-notes-template");
		await template.click();
		await page.getByRole("option", { name: "Daily standup" }).click();
		await expect(template).toContainText("General");
		await expect(
			page.getByText("Couldn't save the notes template")
		).toBeVisible();
		expect(fixture.preference("meeting-notes-template")).toBe("general");

		await template.click();
		await page.getByRole("option", { name: "Daily standup" }).click();
		await expect(template).toContainText("Daily standup");
		expect(fixture.preference("meeting-notes-template")).toBe("standup");
		expect(
			fixture.requests
				.filter(
					(request) =>
						request.method === "PUT" &&
						request.path === "/api/preferences/meeting-notes-template"
				)
				.map((request) => [request.body, request.status])
		).toEqual([
			[{ value: "standup" }, 503],
			[{ value: "standup" }, 200],
		]);
		expectNodeScopedRequests(fixture, "http://127.0.0.1:5573");
		await page.reload();
		await expect(
			page.getByRole("combobox", { name: "Notes template" })
		).toContainText("Daily standup");
	});

	test("rolls back and retries diarization toggle/model saves, then restores both choices", async ({
		page,
	}) => {
		const fixture = await installMeetingsFixture(page);
		await openSettings(page);
		const identify = page.getByRole("switch", { name: "Identify speakers" });
		await expect(identify).toHaveAttribute("aria-checked", "false");
		fixture.armFailure("PUT", "/api/preferences/meeting-diarization-enabled");
		await identify.click();
		await expect(identify).toHaveAttribute("aria-checked", "false");
		await expect(
			page.getByText("Couldn't save the diarization setting")
		).toBeVisible();
		await identify.click();
		await expect(identify).toHaveAttribute("aria-checked", "true");
		expect(fixture.preference("meeting-diarization-enabled")).toBe("true");
		expect(
			fixture.requests
				.filter(
					(request) =>
						request.method === "PUT" &&
						request.path === "/api/preferences/meeting-diarization-enabled"
				)
				.map((request) => [request.body, request.status])
		).toEqual([
			[{ value: "true" }, 503],
			[{ value: "true" }, 200],
		]);

		const speakerModel = page.getByRole("combobox", { name: "Speaker model" });
		await expect(speakerModel).toContainText("pyannote 3.1");
		fixture.armFailure("PUT", "/api/preferences/meeting-diarization-model");
		await speakerModel.click();
		await page.getByRole("option", { name: "NVIDIA Nemotron 3" }).click();
		await expect(speakerModel).toContainText("pyannote 3.1");
		await expect(
			page.getByText("Couldn't save the speaker model")
		).toBeVisible();
		expect(fixture.preference("meeting-diarization-model")).toBe("pyannote");
		await speakerModel.click();
		await page.getByRole("option", { name: "NVIDIA Nemotron 3" }).click();
		await expect(speakerModel).toContainText("NVIDIA Nemotron 3");
		expect(fixture.preference("meeting-diarization-model")).toBe("nemotron");
		expect(
			fixture.requests
				.filter(
					(request) =>
						request.method === "PUT" &&
						request.path === "/api/preferences/meeting-diarization-model"
				)
				.map((request) => [request.body, request.status])
		).toEqual([
			[{ value: "nemotron" }, 503],
			[{ value: "nemotron" }, 200],
		]);
		expectNodeScopedRequests(fixture, "http://127.0.0.1:5573");
		await page.reload();
		await expect(
			page.getByRole("switch", { name: "Identify speakers" })
		).toHaveAttribute("aria-checked", "true");
		await expect(
			page.getByRole("combobox", { name: "Speaker model" })
		).toContainText("NVIDIA Nemotron 3");
		await page.screenshot({
			animations: "disabled",
			fullPage: true,
			path: path.join(
				EVIDENCE_DIR,
				"desktop-meetings-settings-speaker-labels.png"
			),
		});
	});

	test("rolls back auto-detection, normalizes meeting app names, retries, and restores both settings", async ({
		page,
	}) => {
		const fixture = await installMeetingsFixture(page);
		await openSettings(page);
		const detection = page.getByRole("switch", {
			name: "Auto-detect meetings",
		});
		await expect(detection).toHaveAttribute("aria-checked", "true");
		fixture.armFailure("PUT", "/api/meetings/detection-config");
		await detection.click();
		await expect(detection).toHaveAttribute("aria-checked", "true");
		await expect(
			page.getByText("Couldn't save your detection settings")
		).toBeVisible();
		await detection.click();
		await expect(detection).toHaveAttribute("aria-checked", "false");
		expect(fixture.snapshotDetection().enabled).toBe(false);

		fixture.armFailure("PUT", "/api/meetings/detection-config");
		const apps = page.getByRole("textbox", { name: "Meeting apps" });
		await apps.fill(" zoom, , teams, Google Meet  ");
		await page.getByRole("heading", { name: "Automatic detection" }).click();
		await expect(apps).toHaveValue("zoom, teams, Google Meet");
		await expect(
			page.getByText("Couldn't save your detection settings")
		).toBeVisible();
		expect(fixture.snapshotDetection().apps).toEqual(["zoom", "teams"]);
		await apps.focus();
		await apps.press("Tab");
		// The blur-triggered retry is asynchronous: poll the fixture state.
		await expect
			.poll(() => fixture.snapshotDetection())
			.toEqual({
				apps: ["zoom", "teams", "Google Meet"],
				enabled: false,
			});
		expect(
			fixture.requests
				.filter(
					(request) =>
						request.method === "PUT" &&
						request.path === "/api/meetings/detection-config"
				)
				.map((request) => [request.body, request.status])
		).toEqual([
			[{ enabled: false }, 503],
			[{ enabled: false }, 200],
			[{ apps: ["zoom", "teams", "Google Meet"] }, 503],
			[{ apps: ["zoom", "teams", "Google Meet"] }, 200],
		]);
		expectNodeScopedRequests(fixture, "http://127.0.0.1:5573");
		await page.reload();
		await expect(
			page.getByRole("switch", { name: "Auto-detect meetings" })
		).toHaveAttribute("aria-checked", "false");
		await expect(
			page.getByRole("textbox", { name: "Meeting apps" })
		).toHaveValue("zoom, teams, Google Meet");
		await page.screenshot({
			animations: "disabled",
			fullPage: true,
			path: path.join(EVIDENCE_DIR, "desktop-meetings-settings-detection.png"),
		});
	});
});
