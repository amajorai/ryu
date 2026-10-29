import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { createRoot } from "react-dom/client";
import { OnboardingSetupStep } from "../../src/components/onboarding/OnboardingSetupStep.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

interface RecordedRequest {
	body: unknown;
	method: string;
	path: string;
}

interface MigrationFixture {
	continued: number;
	readonly requests: RecordedRequest[];
	skipped: number;
}

declare global {
	interface Window {
		__migrationFixture?: MigrationFixture;
	}
}

const target: ApiTarget = {
	token: "local-migration-fixture-token",
	url: "http://127.0.0.1:7980",
};

const HOME = "/home/fixture";

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

const openclawScan = {
	root: `${HOME}/.openclaw`,
	source: "openclaw",
	items: [
		{
			kind: "agent",
			id: "agent/workspace/SOUL.md",
			title: "OpenClaw agent 'Clawd'",
		},
		{
			kind: "memory",
			id: "memory/workspace/MEMORY.md",
			title: "OpenClaw memory MEMORY.md (12 entries)",
		},
		{
			kind: "memory",
			id: "memory/workspace/USER.md",
			title: "OpenClaw memory USER.md (3 entries)",
		},
		{
			kind: "skill",
			id: "skill/workspace/skills/deploy",
			title: "Skill 'deploy'",
		},
		{
			kind: "skill",
			id: "skill/skills/research",
			title: "Skill 'research'",
			already_exists: true,
		},
		{
			kind: "mcp_server",
			id: "mcp_server/mcp/openclaw/docs",
			title: "MCP server 'docs'",
		},
	],
	warnings: [
		"Channels configured in OpenClaw (telegram, discord) are not imported; reconnect them in Ryu Channels. Bot tokens are never copied by a scan.",
		"OpenClaw cron jobs are not imported; recreate them as Ryu schedules.",
	],
};

const chatgptScan = {
	root: `${HOME}/Downloads/chatgpt-export`,
	source: "chatgpt",
	items: [
		{
			kind: "conversations",
			id: "conversations/conversations.json#chats",
			title: "ChatGPT chats (1284)",
		},
		{
			kind: "conversations",
			id: "conversations/conversations.json#g-p-685bb57d",
			title: "ChatGPT project 685bb57d (12 chats)",
			detail:
				"Latest chat: “Kitchen remodel budget”. Becomes a project folder.",
		},
		{
			kind: "memory",
			id: "memory/conversations.json#saved-context",
			title: "ChatGPT custom instructions",
		},
	],
	warnings: [
		"ChatGPT does not export project names, files, or saved memories. Imported projects are named by id; rename them in Ryu and add their files to the project folder.",
	],
};

const mastraScan = {
	root: `${HOME}/Projects/mastra-app`,
	source: "mastra",
	items: [
		{
			kind: "agent",
			id: "agent/src/mastra/agents/index.ts#0",
			title: "Mastra agent 'Weather Agent'",
		},
		{
			kind: "agent",
			id: "agent/src/mastra/agents/index.ts#1",
			title: "Mastra agent 'support'",
		},
	],
	warnings: [
		"Mastra tools, workflows, and graphs are code and are not converted.",
	],
};

function installFixture(): MigrationFixture {
	const fixture: MigrationFixture = { continued: 0, requests: [], skipped: 0 };
	window.__migrationFixture = fixture;
	window.fetch = async (input, init) => {
		const requestUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(requestUrl, window.location.href);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		let body: ProofJsonValue = null;
		if (isNativeText(init?.body)) {
			body = parseProofJson(init.body);
		}
		fixture.requests.push({ body, method, path: url.pathname });
		const requestedPath =
			body && typeof body === "object" && "path" in body
				? String(body.path)
				: "";

		if (url.pathname.endsWith("/api/workspace/list")) {
			const path = url.searchParams.get("path");
			if (path === "::this-pc") {
				return json({ error: "Not a Windows drive listing." }, 404);
			}
			if (!path || path === HOME) {
				return json({
					entries: [{ name: "Projects", path: `${HOME}/Projects` }],
					home: HOME,
					parent: null,
					path: HOME,
				});
			}
			if (path === `${HOME}/Projects`) {
				return json({
					entries: [
						{ name: "mastra-app", path: `${HOME}/Projects/mastra-app` },
						{
							name: "chatgpt-export",
							path: `${HOME}/Downloads/chatgpt-export`,
						},
					],
					home: HOME,
					parent: HOME,
					path,
				});
			}
			return json({ entries: [], home: HOME, parent: HOME, path });
		}
		if (url.pathname.endsWith("/api/import/scan") && method === "POST") {
			if (requestedPath === openclawScan.root) {
				return json(openclawScan);
			}
			if (requestedPath === mastraScan.root) {
				return json(mastraScan);
			}
			if (requestedPath === chatgptScan.root) {
				return json(chatgptScan);
			}
			return json(
				{ error: `cannot resolve folder ${requestedPath}: No such file` },
				400
			);
		}
		if (url.pathname.endsWith("/api/import/run") && method === "POST") {
			const items =
				body && typeof body === "object" && "items" in body
					? (body.items as { id: string; kind: string }[])
					: [];
			return json({
				root: requestedPath,
				results: items.map((item) => ({
					...item,
					status: "imported",
					title: item.id,
				})),
			});
		}
		return json(
			{ error: `Unexpected local API request: ${method} ${url.pathname}` },
			404
		);
	};
	return fixture;
}

const noop = () => undefined;

function Harness() {
	const fixture = window.__migrationFixture;
	return (
		<main className="h-screen bg-background text-foreground">
			<OnboardingSetupStep
				{
					/* SAFETY: the migrate step reads only kind, target, onContinue, and onSkip; the remaining onboarding props belong to other setup steps. */ ...({
						kind: "migrate",
						target,
						onContinue: () => {
							if (fixture) {
								fixture.continued += 1;
							}
						},
						onSkip: () => {
							if (fixture) {
								fixture.skipped += 1;
							}
						},
						onImportThreads: noop,
					} as unknown as Parameters<typeof OnboardingSetupStep>[0])
				}
			/>
		</main>
	);
}

installFixture();
const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Onboarding migration harness root is missing.");
}
createRoot(rootElement).render(<Harness />);
