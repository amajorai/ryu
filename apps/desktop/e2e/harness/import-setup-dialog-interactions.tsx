import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { ImportSetupDialog } from "../../src/components/chat/ImportSetupDialog.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

interface RecordedRequest {
	body: unknown;
	method: string;
	path: string;
	query: Record<string, string>;
}

interface ImportFixture {
	failedImportsRemaining: number;
	failedScansRemaining: number;
	importedCallbackCount: number;
	projectFolders: string[];
	projectIds: string[];
	readonly requests: RecordedRequest[];
}

declare global {
	interface Window {
		__importSetupFixture?: ImportFixture;
	}
}

const target: ApiTarget = {
	token: "local-import-fixture-token",
	url: "http://127.0.0.1:7980",
};

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

function scanItems() {
	return [
		{
			id: "instructions/CLAUDE.md",
			kind: "instructions",
			title: "Claude instructions",
			detail: "CLAUDE.md · 34 lines",
		},
		{
			id: "skills/research/SKILL.md",
			kind: "skill",
			title: "Research workflow",
			detail: "skills/research/SKILL.md",
		},
		{
			id: "skills/planning/SKILL.md",
			kind: "skill",
			title: "Planning workflow",
			detail: "skills/planning/SKILL.md",
		},
		{
			id: "plugins/formatter.json",
			kind: "plugin",
			title: "Formatter plugin",
			detail: "plugins/formatter.json",
		},
		{
			id: "memory/preferences.md",
			kind: "memory",
			title: "Project preferences",
			detail: "memory/preferences.md",
		},
		{
			id: "mcp/linear.json",
			kind: "mcp_server",
			title: "Linear MCP server",
			detail: "mcp/linear.json",
		},
		{
			id: "agents/reviewer.json",
			kind: "agent",
			title: "Release reviewer",
			detail: "agents/reviewer.json",
		},
		{
			id: "commands/review.md",
			kind: "slash_command",
			title: "/review",
			detail: "commands/review.md",
		},
	];
}

function installFixture(): ImportFixture {
	const fixture: ImportFixture = {
		failedImportsRemaining: 0,
		failedScansRemaining: 0,
		importedCallbackCount: 0,
		projectFolders: [],
		projectIds: [],
		requests: [],
	};
	window.__importSetupFixture = fixture;

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
		fixture.requests.push({
			body,
			method,
			path: url.pathname,
			query: Object.fromEntries(url.searchParams),
		});

		if (url.pathname.endsWith("/api/workspace/list")) {
			const path = url.searchParams.get("path");
			if (path === "::this-pc") {
				return json({ error: "Not a Windows drive listing." }, 404);
			}
			if (!path) {
				return json({
					entries: [],
					home: "/home/fixture",
					parent: null,
					path: "/home/fixture",
				});
			}
			if (path === "/home/fixture") {
				return json({
					entries: [{ name: "Projects", path: "/home/fixture/Projects" }],
					home: "/home/fixture",
					parent: null,
					path,
				});
			}
			if (path === "/home/fixture/Projects") {
				return json({
					entries: [
						{
							name: "AgentWorkspace",
							path: "/home/fixture/Projects/AgentWorkspace",
						},
						{ name: "Docs", path: "/home/fixture/Projects/Docs" },
					],
					home: "/home/fixture",
					parent: "/home/fixture",
					path,
				});
			}
			return json({
				entries: [],
				home: "/home/fixture",
				parent: "/home/fixture/Projects",
				path,
			});
		}
		if (url.pathname.endsWith("/api/import/scan") && method === "POST") {
			if (fixture.failedScansRemaining > 0) {
				fixture.failedScansRemaining -= 1;
				return json(
					{ error: "Local scanner is temporarily unavailable." },
					503
				);
			}
			const requestedPath =
				z.object({ path: z.string() }).safeParse(body).data?.path ??
				"/home/fixture/.claude";
			return json({
				items: scanItems(),
				root: requestedPath,
				warnings: ["One ignored file was skipped."],
			});
		}
		if (url.pathname.endsWith("/api/import/run") && method === "POST") {
			if (fixture.failedImportsRemaining > 0) {
				fixture.failedImportsRemaining -= 1;
				return json(
					{ error: "Local importer is temporarily unavailable." },
					503
				);
			}
			const requestedPath =
				z.object({ path: z.string() }).safeParse(body).data?.path ??
				"/home/fixture/.claude";
			return json({
				results: [
					{
						folder_path: "/workspace/claude-project",
						id: "instructions/CLAUDE.md",
						kind: "instructions",
						status: "imported",
						title: "Claude instructions",
					},
					{
						already_exists: true,
						id: "plugins/formatter.json",
						kind: "plugin",
						status: "skipped",
						title: "Formatter plugin",
					},
					{
						detail: "Memory import is disabled for this project.",
						id: "memory/preferences.md",
						kind: "memory",
						status: "failed",
						title: "Project preferences",
					},
				],
				root: requestedPath,
			});
		}
		return json(
			{ error: `Unexpected local API request: ${method} ${url.pathname}` },
			404
		);
	};
	return fixture;
}

function StoreReadback() {
	const recentFolders = useWorkspaceStore((state) => state.recentFolders);
	const projects = useWorkspaceStore((state) => state.projects);
	useEffect(() => {
		const fixture = window.__importSetupFixture;
		if (fixture) {
			fixture.projectFolders = [...recentFolders];
			fixture.projectIds = projects.map((project) => project.id);
		}
	}, [recentFolders, projects]);
	return null;
}

function Harness() {
	const [open, setOpen] = useState(true);
	const fixture = window.__importSetupFixture;
	return (
		<main className="min-h-screen bg-background px-6 py-10 text-foreground">
			<div className="mx-auto max-w-3xl">
				<header className="mb-8">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-section">
						Workspace · /chat · Command Palette → Import Agent Setup
					</p>
					<h1 className="mt-2 font-semibold text-4xl tracking-tight">
						Agent setup import
					</h1>
				</header>
				<button
					className="rounded-lg border px-3 py-2 text-sm"
					onClick={() => setOpen(true)}
					type="button"
				>
					Open Import Agent Setup
				</button>
				<ImportSetupDialog
					onImported={() => {
						if (fixture) {
							fixture.importedCallbackCount += 1;
						}
					}}
					onOpenChange={setOpen}
					open={open}
					target={target}
				/>
			</div>
		</main>
	);
}

installFixture();
const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Import setup interactions harness root is missing.");
}
createRoot(rootElement).render(
	<>
		<StoreReadback />
		<Harness />
	</>
);
