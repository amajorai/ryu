import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { type ProofJsonValue, parseProofJson } from "./fixture-json.ts";

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const evidenceDir =
	process.env.RYU_PROOF_EVIDENCE_DIR ??
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence"
	);

const memoryScopeLabels = {
	agent: "This agent",
	node: "This device",
	org: "My organization",
	project: "This project",
	user: "Just me",
} as const;

type MemoryScope = keyof typeof memoryScopeLabels;

interface AgentMemoryWire {
	read_levels: string[];
	space_ids: string[];
	write_enabled: boolean;
}

interface AgentWire {
	built_in: boolean;
	composio_actions: string[];
	description: string | null;
	engine: string | null;
	id: string;
	identity_profile_ids: string[];
	lifecycle_status: string;
	locked: boolean;
	memory: AgentMemoryWire;
	name: string;
	orchestrator: boolean | null;
	safety_profile: string;
	skills: string[];
	system_prompt: string | null;
	title: string;
	tools: string[];
	version: string;
}

// This fixture consumes tools and the complete memory allowlists, not a full
// AgentInput response contract. Raw requests remain in calls before admission.
const agentAccessWriteSchema = z.looseObject({
	memory: z
		.looseObject({
			read_levels: z.array(z.string()),
			space_ids: z.array(z.string()),
			write_enabled: z.boolean(),
		})
		.optional(),
	tools: z.array(z.string()),
});

interface ApiCall {
	body: unknown;
	method: string;
	path: string;
}

function initialAgent(): AgentWire {
	return {
		built_in: false,
		composio_actions: [],
		description: "An agent used to verify scoped access changes.",
		engine: null,
		id: "agent-access-demo",
		identity_profile_ids: [],
		lifecycle_status: "active",
		locked: false,
		memory: { read_levels: [], space_ids: [], write_enabled: false },
		name: "Research Agent",
		orchestrator: null,
		safety_profile: "autonomous",
		skills: [],
		system_prompt: "Use only the approved resources.",
		title: "Research",
		tools: ["__ryu_none__"],
		version: "1.0.0",
	};
}

async function captureScreenshot(
	page: import("@playwright/test").Page,
	filename: string
) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

test("AgentAccessPanel persists exact Space, memory-level, and MCP allowlists with rollback and reload", async ({
	page,
}) => {
	let storedAgent = initialAgent();
	let failNextWrite = false;
	const calls: ApiCall[] = [];
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("requestfailed", (request) => {
		consoleErrors.push(
			`${request.url()}: ${request.failure()?.errorText ?? "request failed"}`
		);
	});
	await page.route("http://127.0.0.1:5388/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const rawBody = request.postData();
		let body: ProofJsonValue = null;
		if (rawBody) {
			try {
				body = parseProofJson(rawBody);
			} catch {
				body = rawBody;
			}
		}
		calls.push({ body, method: request.method(), path: url.pathname });

		if (url.pathname === "/api/agents/agent-access-demo") {
			if (request.method() === "GET") {
				await route.fulfill({ json: { agent: storedAgent } });
				return;
			}
			if (request.method() === "PUT") {
				if (failNextWrite) {
					failNextWrite = false;
					await route.fulfill({
						json: { error: "permission_denied" },
						status: 403,
					});
					return;
				}
				const input = agentAccessWriteSchema.parse(body);
				storedAgent = {
					...storedAgent,
					...(input.memory ? { memory: input.memory } : undefined),
					tools: input.tools,
				};
				await route.fulfill({ json: { agent: storedAgent } });
				return;
			}
		}

		if (url.pathname === "/api/spaces" && request.method() === "GET") {
			await route.fulfill({
				json: {
					spaces: [
						{
							created_at: 1_790_000_000_000,
							document_count: 2,
							id: "space-docs",
							name: "Project Docs",
							retrieval_mode: "vector",
							system: false,
							updated_at: 1_790_000_000_000,
							visibility: "owner",
						},
						{
							created_at: 1_790_000_000_000,
							document_count: 1,
							id: "space-research",
							name: "Research Notes",
							retrieval_mode: "vector",
							system: false,
							updated_at: 1_790_000_000_000,
							visibility: "owner",
						},
					],
				},
			});
			return;
		}

		if (url.pathname === "/api/mcp/tools" && request.method() === "GET") {
			await route.fulfill({
				json: {
					tools: [
						{
							description: "Read a Space document.",
							id: "spaces.read",
							name: "read",
							server: "spaces",
						},
						{
							description: "Search a Space.",
							id: "spaces.search",
							name: "search",
							server: "spaces",
						},
						{
							description: "Open an approved browser page.",
							id: "browser.open",
							name: "open",
							server: "browser",
						},
					],
				},
			});
			return;
		}

		await route.fulfill({
			json: { error: "fixture_route_not_found", path: url.pathname },
			status: 404,
		});
	});

	await page.goto("/agent-access-settings-proof.html");
	if (pageErrors.length > 0) {
		throw new Error(`Harness page error: ${pageErrors.join("; ")}`);
	}
	const initialBody = await page.locator("body").innerText();
	if (!initialBody.toLowerCase().includes("production component proof")) {
		throw new Error(
			`Unexpected Agent Access harness body: ${initialBody}; browser errors: ${consoleErrors.join("; ")}; page errors: ${pageErrors.join("; ")}`
		);
	}
	await expect(page.locator("body")).toHaveAttribute("data-harness-ready", "1");
	await expect
		.poll(() => calls.filter((call) => call.method === "GET"))
		.toHaveLength(3);
	expect(pageErrors).toEqual([]);
	await expect(page.getByText("Research Agent", { exact: true })).toBeVisible();

	const projectDocs = page.getByRole("checkbox", { name: "Project Docs" });
	const researchNotes = page.getByRole("checkbox", { name: "Research Notes" });
	const memoryLevel = (level: MemoryScope) =>
		page.getByRole("checkbox", { name: memoryScopeLabels[level] });
	const spacesTools = page.getByRole("switch", {
		name: "Allow Spaces (docs & pages)",
	});
	for (const level of ["agent", "user", "node", "project"] as const) {
		await expect(memoryLevel(level)).toBeChecked();
	}
	await expect(memoryLevel("org")).not.toBeChecked();
	await expect(spacesTools).not.toBeChecked();

	await projectDocs.click();
	await expect.poll(() => storedAgent.memory.space_ids).toEqual(["space-docs"]);
	const firstSpaceWrite = calls.filter((call) => call.method === "PUT").at(-1);
	expect(firstSpaceWrite).toMatchObject({
		path: "/api/agents/agent-access-demo",
		body: {
			memory: {
				read_levels: [],
				space_ids: ["space-docs"],
				write_enabled: false,
			},
		},
	});
	await expect(projectDocs).toBeChecked();

	failNextWrite = true;
	await researchNotes.click();
	await expect(page.getByText("Couldn't save agent access")).toBeVisible();
	await expect(researchNotes).not.toBeChecked();
	expect(storedAgent.memory.space_ids).toEqual(["space-docs"]);
	const failedSpaceWrite = calls.filter((call) => call.method === "PUT").at(-1);
	expect(failedSpaceWrite).toMatchObject({
		body: {
			memory: {
				space_ids: ["space-docs", "space-research"],
			},
		},
	});
	await captureScreenshot(page, "desktop-agent-access-write-rollback.png");

	await researchNotes.click();
	await expect
		.poll(() => storedAgent.memory.space_ids)
		.toEqual(["space-docs", "space-research"]);
	await expect(researchNotes).toBeChecked();

	await memoryLevel("org").click();
	await expect
		.poll(() => storedAgent.memory.read_levels)
		.toEqual(["agent", "user", "node", "project", "org"]);
	const organizationWrite = calls
		.filter((call) => call.method === "PUT")
		.at(-1);
	expect(organizationWrite?.body).toMatchObject({
		memory: {
			read_levels: ["agent", "user", "node", "project", "org"],
			space_ids: ["space-docs", "space-research"],
			write_enabled: false,
		},
	});
	await memoryLevel("project").click();
	await expect
		.poll(() => storedAgent.memory.read_levels)
		.toEqual(["agent", "user", "node", "org"]);
	const orderedMemoryWrite = calls
		.filter((call) => call.method === "PUT")
		.at(-1);
	expect(orderedMemoryWrite?.body).toMatchObject({
		memory: { read_levels: ["agent", "user", "node", "org"] },
	});
	await memoryLevel("project").click();
	await expect
		.poll(() => storedAgent.memory.read_levels)
		.toEqual(["agent", "user", "node", "project", "org"]);

	await spacesTools.click();
	await expect
		.poll(() => storedAgent.tools)
		.toEqual(["spaces.read", "spaces.search"]);
	const enabledToolsWrite = calls
		.filter((call) => call.method === "PUT")
		.at(-1);
	expect(enabledToolsWrite?.body).toMatchObject({
		tools: ["spaces.read", "spaces.search"],
	});
	await expect(spacesTools).toBeChecked();
	await expect(
		page.getByText("Couldn't save agent access", { exact: true })
	).toHaveCount(0, { timeout: 10_000 });

	await spacesTools.click();
	await expect.poll(() => storedAgent.tools).toEqual(["__ryu_none__"]);
	const disabledToolsWrite = calls
		.filter((call) => call.method === "PUT")
		.at(-1);
	expect(disabledToolsWrite?.body).toMatchObject({
		tools: ["__ryu_none__"],
	});

	await page.reload();
	await expect(page.getByText("Research Agent", { exact: true })).toBeVisible();
	await expect(projectDocs).toBeChecked();
	await expect(researchNotes).toBeChecked();
	await expect(memoryLevel("org")).toBeChecked();
	for (const level of ["agent", "user", "node", "project"] as const) {
		await expect(memoryLevel(level)).toBeChecked();
	}
	await expect(spacesTools).not.toBeChecked();
	expect(storedAgent.memory).toEqual({
		read_levels: ["agent", "user", "node", "project", "org"],
		space_ids: ["space-docs", "space-research"],
		write_enabled: false,
	});
	expect(storedAgent.tools).toEqual(["__ryu_none__"]);
	await captureScreenshot(
		page,
		"desktop-agent-access-permissions-after-reload.png"
	);
});
