import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { WorkspaceBar } from "../../src/components/chat/WorkspaceBar.tsx";
import { WorkspacePicker } from "../../src/components/chat/WorkspacePicker.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import { projectIdForFolder } from "../../src/lib/workspace-projects.ts";
import { useDockPanelRequestStore } from "../../src/store/useDockPanelRequestStore.ts";
import { LOCAL_FALLBACK, useNodeStore } from "../../src/store/useNodeStore.ts";
import {
	emptyEnvironmentScripts,
	type ProjectEnvironment,
	useWorkspaceStore,
	type WorkspaceProject,
} from "../../src/store/useWorkspaceStore.ts";
import { type ProofJsonRecord, parseProofJsonRecord } from "../fixture-json.ts";
import "../../src/index.css";

const HOME_PATH = "/fixture/home";
const PROJECTS_PATH = `${HOME_PATH}/Projects`;
const ALPHA_PATH = `${PROJECTS_PATH}/alpha`;
const BETA_PATH = `${PROJECTS_PATH}/beta`;
const REQUESTS_KEY = "proof:workspace-picker:requests";
const CREATED_PATHS_KEY = "proof:workspace-picker:created-paths";
const FIXTURE_BRANCHES = [
	"main",
	"release",
	"feature/alpha",
	"topic/fixture",
	...Array.from({ length: 60 }, (_, index) => `topic/branch-${index + 1}`),
];
const WORKSPACE_KEYS = [
	"ryu_workspace_folder",
	"ryu_workspace_projects_v1",
	"ryu_workspace_recents",
	"ryu_workspace_removed",
	"ryu_workspace_names",
	"ryu_workspace_icons",
	"ryu_workspace_environments_v1",
	"ryu_workspace_active_environments_v1",
	"ryu_workspace_worktree_mode",
	"ryu_workspace_worktree_branch",
];

interface FixtureRequest {
	body: unknown;
	method: string;
	path: string;
}

declare global {
	interface Window {
		__workspacePickerProof?: {
			releaseBranches: () => void;
			releaseHomeListing: () => void;
		};
	}
}

const ALPHA_PROJECT: WorkspaceProject = {
	folders: [ALPHA_PATH],
	id: projectIdForFolder(ALPHA_PATH),
	name: "Alpha project",
};
const BETA_PROJECT: WorkspaceProject = {
	folders: [BETA_PATH],
	id: projectIdForFolder(BETA_PATH),
	name: "Beta project",
};
const TEST_PROJECTS = [ALPHA_PROJECT, BETA_PROJECT];

function scripts(command: string) {
	return { default: command, linux: command, macos: command, windows: command };
}

const FIXTURE_ENVIRONMENTS: ProjectEnvironment[] = [
	{
		actions: [
			{
				id: "build-action",
				name: "Run fixture build",
				scripts: scripts("printf fixture-build"),
			},
		],
		cleanup: emptyEnvironmentScripts(),
		id: "fixture-build",
		name: "Build profile",
		setup: emptyEnvironmentScripts(),
		variables: [{ id: "mode", key: "FIXTURE_MODE", value: "workspace-proof" }],
	},
	{
		actions: [
			{
				id: "test-action",
				name: "Run fixture tests",
				scripts: scripts("printf fixture-tests"),
			},
		],
		cleanup: emptyEnvironmentScripts(),
		id: "fixture-test",
		name: "Test profile",
		setup: emptyEnvironmentScripts(),
		variables: [{ id: "suite", key: "FIXTURE_SUITE", value: "local-only" }],
	},
];

function json<FixturePayload>(value: FixturePayload, status = 200): Response {
	return Response.json(value, { status });
}

function readObject(raw: string | null): ProofJsonRecord | null {
	if (!raw) {
		return null;
	}
	try {
		return parseProofJsonRecord(raw);
	} catch {
		return null;
	}
}

function consumeFlag(key: string): boolean {
	if (localStorage.getItem(key) !== "true") {
		return false;
	}
	localStorage.removeItem(key);
	return true;
}

function recordRequest(request: FixtureRequest): void {
	const current = JSON.parse(localStorage.getItem(REQUESTS_KEY) ?? "[]");
	current.push(request);
	localStorage.setItem(REQUESTS_KEY, JSON.stringify(current));
}

function installLocalCoreFixture(): void {
	const nativeFetch = window.fetch.bind(window);
	let releaseHomeListing: (() => void) | null = null;
	let releaseBranches: (() => void) | null = null;
	window.__workspacePickerProof = {
		releaseBranches: () => {
			releaseBranches?.();
			releaseBranches = null;
		},
		releaseHomeListing: () => {
			releaseHomeListing?.();
			releaseHomeListing = null;
		},
	};

	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(rawUrl, window.location.href);
		if (!url.pathname.startsWith("/api/")) {
			return nativeFetch(input, init);
		}

		const method = (init?.method ?? "GET").toUpperCase();
		const body = isNativeText(init?.body) ? readObject(init.body) : null;
		const requestPath = `${url.pathname}${url.search}`;
		recordRequest({ body, method, origin: url.origin, path: requestPath });

		if (url.pathname === "/api/workspace/list" && method === "GET") {
			const path = url.searchParams.get("path");
			if (path === "::this-pc") {
				return json(
					{ error: "Drive roots are unavailable in this fixture." },
					404
				);
			}
			if (path === null) {
				const homeListing = () =>
					json({
						entries: [{ name: "Projects", path: PROJECTS_PATH }],
						home: HOME_PATH,
						parent: null,
						path: HOME_PATH,
					});
				if (consumeFlag("proof:workspace-picker:fail-home-list-once")) {
					return json(
						{ error: "Fixture folder listing is temporarily unavailable." },
						503
					);
				}
				if (consumeFlag("proof:workspace-picker:hold-home-list-once")) {
					return new Promise<Response>((resolve) => {
						releaseHomeListing = () => {
							const shouldFail = consumeFlag(
								"proof:workspace-picker:fail-held-home-list-once"
							);
							resolve(
								shouldFail
									? json(
											{
												error:
													"Fixture folder listing is temporarily unavailable.",
											},
											503
										)
									: homeListing()
							);
						};
					});
				}
				return homeListing();
			}

			if (path === HOME_PATH) {
				return json({
					entries: [{ name: "Projects", path: PROJECTS_PATH }],
					home: HOME_PATH,
					parent: null,
					path,
				});
			}
			if (path === PROJECTS_PATH) {
				return json({
					entries: [
						{ name: "alpha", path: ALPHA_PATH },
						{ name: "beta", path: BETA_PATH },
					],
					home: HOME_PATH,
					parent: HOME_PATH,
					path,
				});
			}

			const createdPaths = JSON.parse(
				localStorage.getItem(CREATED_PATHS_KEY) ?? "[]"
			);
			if ([ALPHA_PATH, BETA_PATH, ...createdPaths].includes(path)) {
				return json({
					entries: [],
					home: HOME_PATH,
					parent: PROJECTS_PATH,
					path,
				});
			}
			return json({ error: "Path does not exist in the local fixture." }, 404);
		}

		if (url.pathname === "/api/workspace/new-folder" && method === "POST") {
			const name = isNativeText(body?.name) ? body.name : "";
			if (name === "Taken") {
				return json({ error: "A project with that name already exists." }, 409);
			}
			if (!name || /[\\/]/.test(name)) {
				return json({ error: "Choose a single folder name." }, 400);
			}
			const createdPath = `${HOME_PATH}/Documents/Ryu/${name}`;
			const createdPaths = JSON.parse(
				localStorage.getItem(CREATED_PATHS_KEY) ?? "[]"
			);
			localStorage.setItem(
				CREATED_PATHS_KEY,
				JSON.stringify([...createdPaths, createdPath])
			);
			return json({ path: createdPath });
		}

		if (url.pathname === "/api/workspace/clone" && method === "POST") {
			const name = isNativeText(body?.name) ? body.name : "";
			if (!name || /[\\/]/.test(name)) {
				return json({ error: "Choose a single repository folder name." }, 400);
			}
			const clonedPath = `${HOME_PATH}/Documents/Ryu/${name}`;
			const createdPaths = JSON.parse(
				localStorage.getItem(CREATED_PATHS_KEY) ?? "[]"
			);
			localStorage.setItem(
				CREATED_PATHS_KEY,
				JSON.stringify([...createdPaths, clonedPath])
			);
			return json({ name, path: clonedPath });
		}

		if (url.pathname === "/api/git/status" && method === "GET") {
			const cwd = url.searchParams.get("cwd") ?? "";
			const branch =
				localStorage.getItem(`proof:workspace-picker:branch:${cwd}`) ?? "main";
			const dirty =
				localStorage.getItem("proof:workspace-picker:dirty") === "true";
			return json({
				is_repo:
					cwd === ALPHA_PATH ||
					cwd === BETA_PATH ||
					JSON.parse(localStorage.getItem(CREATED_PATHS_KEY) ?? "[]").includes(
						cwd
					),
				branch,
				dirty,
				changed_files_count: dirty ? 2 : 0,
				insertions: dirty ? 7 : 0,
				deletions: dirty ? 2 : 0,
				ahead: 0,
				behind: 0,
			});
		}

		if (url.pathname === "/api/git/branches" && method === "GET") {
			if (consumeFlag("proof:workspace-picker:hold-branches-once")) {
				return new Promise<Response>((resolve) => {
					releaseBranches = () => {
						const shouldFail = consumeFlag(
							"proof:workspace-picker:fail-held-branches-once"
						);
						resolve(
							shouldFail
								? json(
										{
											error:
												"Fixture branch listing is temporarily unavailable.",
										},
										503
									)
								: json({
										is_repo: true,
										current:
											localStorage.getItem(
												`proof:workspace-picker:branch:${url.searchParams.get("cwd") ?? ""}`
											) ?? "main",
										branches: branchList(),
									})
						);
					};
				});
			}
			if (consumeFlag("proof:workspace-picker:fail-branches-once")) {
				return json({ error: "Fixture branch listing failed." }, 503);
			}
			return json({
				is_repo: true,
				current:
					localStorage.getItem(
						`proof:workspace-picker:branch:${url.searchParams.get("cwd") ?? ""}`
					) ?? "main",
				branches: branchList(),
			});
		}

		if (url.pathname === "/api/git/checkout" && method === "POST") {
			const cwd = isNativeText(body?.cwd) ? body.cwd : "";
			const branch = isNativeText(body?.branch) ? body.branch : "";
			if (consumeFlag("proof:workspace-picker:fail-checkout-once")) {
				return json({ error: "Fixture refused this checkout." }, 409);
			}
			localStorage.setItem(`proof:workspace-picker:branch:${cwd}`, branch);
			return json({ success: true, branch });
		}

		if (url.pathname === "/api/git/create-branch" && method === "POST") {
			const cwd = isNativeText(body?.cwd) ? body.cwd : "";
			const branch = isNativeText(body?.branch) ? body.branch : "";
			if (branch === "feature/taken") {
				return json({ error: "That branch already exists." }, 409);
			}
			localStorage.setItem(`proof:workspace-picker:branch:${cwd}`, branch);
			const branches = branchList();
			localStorage.setItem(
				"proof:workspace-picker:branches",
				JSON.stringify([...branches, branch])
			);
			return json({ success: true, branch });
		}

		if (/^\/api\/worktree\/[^/]+\/status$/.test(url.pathname)) {
			return json({
				active: false,
				branch: null,
				path: null,
				has_changes: false,
				changed_files: 0,
			});
		}
		if (/^\/api\/worktree\/[^/]+\/diff$/.test(url.pathname)) {
			return json({ files: [], has_changes: false, unified_diff: "" });
		}
		return json({});
	};
}

function branchList(): string[] {
	const value: unknown = JSON.parse(
		localStorage.getItem("proof:workspace-picker:branches") ??
			JSON.stringify(FIXTURE_BRANCHES)
	);
	return Array.isArray(value)
		? value.filter((item): item is string => isNativeText(item))
		: FIXTURE_BRANCHES;
}

function seedWorkspace(): void {
	const url = new URL(window.location.href);
	if (url.searchParams.get("reset") !== "1") {
		return;
	}
	for (const key of WORKSPACE_KEYS) {
		localStorage.removeItem(key);
	}
	for (const key of [
		REQUESTS_KEY,
		CREATED_PATHS_KEY,
		"proof:workspace-picker:branches",
		"proof:workspace-picker:dirty",
		"proof:workspace-picker:fail-home-list-once",
		"proof:workspace-picker:fail-held-home-list-once",
		"proof:workspace-picker:hold-home-list-once",
		"proof:workspace-picker:fail-branches-once",
		"proof:workspace-picker:fail-held-branches-once",
		"proof:workspace-picker:hold-branches-once",
		"proof:workspace-picker:fail-checkout-once",
	]) {
		localStorage.removeItem(key);
	}
	localStorage.setItem(REQUESTS_KEY, "[]");
	localStorage.setItem(
		"ryu_workspace_projects_v1",
		JSON.stringify(TEST_PROJECTS)
	);
	localStorage.setItem(
		"ryu_workspace_recents",
		JSON.stringify([ALPHA_PATH, BETA_PATH])
	);
	localStorage.setItem(
		"ryu_workspace_names",
		JSON.stringify({
			[ALPHA_PATH]: "Alpha project",
			[BETA_PATH]: "Beta project",
		})
	);
	localStorage.setItem("ryu_workspace_removed", "[]");
	localStorage.setItem(
		"ryu_workspace_environments_v1",
		JSON.stringify({ [ALPHA_PATH]: FIXTURE_ENVIRONMENTS })
	);
	localStorage.setItem(
		"ryu_workspace_active_environments_v1",
		JSON.stringify({ [ALPHA_PATH]: "fixture-build" })
	);
	localStorage.setItem("ryu_workspace_worktree_mode", "false");
	localStorage.setItem("ryu_workspace_worktree_branch", "ryu/fixture-start");
	localStorage.setItem(
		"proof:workspace-picker:branches",
		JSON.stringify(FIXTURE_BRANCHES)
	);
	if (url.searchParams.get("folder") === "alpha") {
		localStorage.setItem("ryu_workspace_folder", ALPHA_PATH);
		localStorage.setItem(`proof:workspace-picker:branch:${ALPHA_PATH}`, "main");
	} else {
		localStorage.removeItem("ryu_workspace_folder");
	}
	useWorkspaceStore.setState({
		activeProjectEnvironments: { [ALPHA_PATH]: "fixture-build" },
		folder: url.searchParams.get("folder") === "alpha" ? ALPHA_PATH : null,
		projectEnvironments: { [ALPHA_PATH]: FIXTURE_ENVIRONMENTS },
		projectNames: {
			[ALPHA_PATH]: "Alpha project",
			[BETA_PATH]: "Beta project",
		},
		projects: TEST_PROJECTS,
		recentFolders: [ALPHA_PATH, BETA_PATH],
		removedProjects: [],
		worktreeMode: false,
		worktreeBranch: "ryu/fixture-start",
	});
	url.searchParams.delete("reset");
	window.history.replaceState(
		null,
		"",
		`${url.pathname}${url.search}${url.hash}`
	);
}

const fixtureNode = { ...LOCAL_FALLBACK, token: null };
const cloudFixtureNode = {
	...LOCAL_FALLBACK,
	managed: true,
	name: "Sandbox Cloud",
	url: "http://sandbox-cloud.example.test:7980",
	token: "fixture-cloud-node-token",
	userJwt: "fixture-cloud-user-jwt",
};
const cloudFixtureEnabled = new URLSearchParams(window.location.search).has(
	"cloud"
);
useNodeStore.setState({
	activeNodeOnline: true,
	cloudNodes: cloudFixtureEnabled ? [cloudFixtureNode] : [],
	defaultNode: cloudFixtureEnabled ? cloudFixtureNode.name : fixtureNode.name,
	localNodes: [fixtureNode],
	nodes: cloudFixtureEnabled ? [cloudFixtureNode, fixtureNode] : [fixtureNode],
});
seedWorkspace();
installLocalCoreFixture();
queryClient.clear();

function TerminalRequestFeedback() {
	const pending = useDockPanelRequestStore((state) => state.pending);
	return (
		<output aria-live="polite" data-testid="terminal-request">
			{pending ? JSON.stringify(pending) : "No terminal request"}
		</output>
	);
}

function ProofSurface() {
	const isStacked =
		new URLSearchParams(window.location.search).get("variant") === "stacked";
	const target: ApiTarget = {
		token: null,
		url: LOCAL_FALLBACK.url,
		userJwt: null,
	};
	return (
		<QueryClientProvider client={queryClient}>
			<AppSurfaceProvider surface="desktop">
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<Toaster position="bottom-right" theme="dark" />
					<main
						className="min-h-screen bg-background p-8 text-foreground"
						data-testid="workspace-picker-proof"
					>
						<div className="mx-auto max-w-4xl rounded-2xl border bg-card p-6 shadow-xl">
							<header className="border-border/60 border-b pb-4">
								<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
									Chat composer · Code mode
								</p>
								<h1 className="mt-2 font-semibold text-2xl">New chat</h1>
							</header>
							<div className="mt-5 min-h-24 rounded-xl border bg-background/70 p-4">
								<p className="text-muted-foreground text-sm">
									Choose the project and run context for this chat.
								</p>
							</div>
							<div className="mt-4 flex min-h-10 items-center border-border/60 border-t pt-2">
								{isStacked ? (
									<WorkspacePicker
										conversationId="workspace-picker-proof"
										stacked
										target={target}
									/>
								) : (
									<WorkspaceBar
										conversationId="workspace-picker-proof"
										target={target}
									/>
								)}
							</div>
							<TerminalRequestFeedback />
						</div>
					</main>
				</ThemeProvider>
			</AppSurfaceProvider>
		</QueryClientProvider>
	);
}

createRoot(document.getElementById("root")!).render(<ProofSurface />);
