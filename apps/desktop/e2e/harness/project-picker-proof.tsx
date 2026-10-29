import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceRequiredDialog } from "../../src/components/chat/WorkspaceRequiredDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { projectIdForFolder } from "../../src/lib/workspace-projects.ts";
import { LOCAL_FALLBACK, useNodeStore } from "../../src/store/useNodeStore.ts";
import {
	useWorkspaceStore,
	type WorkspaceProject,
} from "../../src/store/useWorkspaceStore.ts";
import { type ProofJsonRecord, parseProofJsonRecord } from "../fixture-json.ts";
import "../../src/index.css";

const HOME_PATH = "/fixture/home";
const PROJECTS_PATH = `${HOME_PATH}/Projects`;
const ALPHA_PATH = `${PROJECTS_PATH}/alpha`;
const BETA_PATH = `${PROJECTS_PATH}/beta`;
const BETA_EXTRA_PATH = `${BETA_PATH}/packages/client`;
const CREATED_PATHS_KEY = "proof:project-picker:created-paths";
const REQUESTS_KEY = "proof:project-picker:requests";
const WORKSPACE_KEYS = [
	"ryu_workspace_folder",
	"ryu_workspace_projects_v1",
	"ryu_workspace_recents",
	"ryu_workspace_removed",
	"ryu_workspace_names",
	"ryu_workspace_icons",
	"ryu_workspace_environments_v1",
	"ryu_workspace_active_environments_v1",
];

interface FixtureRequest {
	body: unknown;
	hasAuthorization: boolean;
	method: string;
	origin: string;
	path: string;
	status: number;
}

declare global {
	interface Window {
		__projectPickerProof?: { requests: () => FixtureRequest[] };
	}
}

const ALPHA_PROJECT: WorkspaceProject = {
	folders: [ALPHA_PATH],
	id: projectIdForFolder(ALPHA_PATH),
	name: "Alpha project",
};
const BETA_PROJECT: WorkspaceProject = {
	folders: [BETA_PATH, BETA_EXTRA_PATH],
	id: projectIdForFolder(BETA_PATH),
	name: "Beta project",
};
const TEST_PROJECTS = [ALPHA_PROJECT, BETA_PROJECT];
const REMOTE_NODE = {
	...LOCAL_FALLBACK,
	managed: true,
	name: "Sandbox Cloud",
	url: "http://sandbox-project-picker.example.test:7980",
	token: "fixture-node-token",
	userJwt: "fixture-user-jwt",
};

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

function createdPaths(): string[] {
	const parsed: unknown = JSON.parse(
		localStorage.getItem(CREATED_PATHS_KEY) ?? "[]"
	);
	return Array.isArray(parsed)
		? parsed.filter((value): value is string => isNativeText(value))
		: [];
}

function saveCreatedPath(path: string): void {
	const current = createdPaths();
	if (!current.includes(path)) {
		localStorage.setItem(CREATED_PATHS_KEY, JSON.stringify([...current, path]));
	}
}

function recordRequest(request: FixtureRequest): void {
	const requests = JSON.parse(localStorage.getItem(REQUESTS_KEY) ?? "[]");
	localStorage.setItem(REQUESTS_KEY, JSON.stringify([...requests, request]));
}

function answer<Payload>(
	url: URL,
	method: string,
	body: ProofJsonRecord | null,
	status: number,
	payload: Payload,
	requestHeaders: Headers
): Response {
	recordRequest({
		body,
		hasAuthorization: requestHeaders.has("authorization"),
		method,
		origin: url.origin,
		path: `${url.pathname}${url.search}`,
		status,
	});
	return json(payload, status);
}

function installLocalCoreFixture(): void {
	const nativeFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(rawUrl, window.location.href);
		if (!url.pathname.startsWith("/api/workspace/")) {
			return nativeFetch(input, init);
		}

		const method = (init?.method ?? "GET").toUpperCase();
		const body = isNativeText(init?.body) ? readObject(init.body) : null;
		const requestHeaders = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined)
		);

		if (url.pathname === "/api/workspace/list" && method === "GET") {
			const path = url.searchParams.get("path");
			if (path === "::this-pc") {
				return answer(
					url,
					method,
					null,
					404,
					{ error: "No Windows drives." },
					requestHeaders
				);
			}
			if (path === null) {
				if (consumeFlag("proof:project-picker:fail-home-list-once")) {
					return answer(
						url,
						method,
						null,
						403,
						{ error: "The active node denied access to its home folder." },
						requestHeaders
					);
				}
				return answer(
					url,
					method,
					null,
					200,
					{
						entries: [{ name: "Projects", path: PROJECTS_PATH }],
						home: HOME_PATH,
						parent: null,
						path: HOME_PATH,
					},
					requestHeaders
				);
			}
			if (
				(path === ALPHA_PATH &&
					consumeFlag("proof:project-picker:fail-alpha-list-once")) ||
				(path === BETA_PATH &&
					consumeFlag("proof:project-picker:fail-beta-list-once"))
			) {
				return answer(
					url,
					method,
					null,
					403,
					{
						error: `The active node denied access to ${path === ALPHA_PATH ? "Alpha" : "Beta"}.`,
					},
					requestHeaders
				);
			}
			if (
				path.startsWith(`${HOME_PATH}/Documents/Ryu/`) &&
				consumeFlag("proof:project-picker:fail-created-folder-once")
			) {
				return answer(
					url,
					method,
					null,
					403,
					{ error: "The active node denied access to the new folder." },
					requestHeaders
				);
			}
			if (path === HOME_PATH) {
				return answer(
					url,
					method,
					null,
					200,
					{
						entries: [{ name: "Projects", path: PROJECTS_PATH }],
						home: HOME_PATH,
						parent: null,
						path,
					},
					requestHeaders
				);
			}
			if (path === PROJECTS_PATH) {
				return answer(
					url,
					method,
					null,
					200,
					{
						entries: [
							{ name: "alpha", path: ALPHA_PATH },
							{ name: "beta", path: BETA_PATH },
						],
						home: HOME_PATH,
						parent: HOME_PATH,
						path,
					},
					requestHeaders
				);
			}
			if (
				path === ALPHA_PATH ||
				path === BETA_PATH ||
				path === BETA_EXTRA_PATH ||
				createdPaths().includes(path)
			) {
				return answer(
					url,
					method,
					null,
					200,
					{
						entries: [],
						home: HOME_PATH,
						parent: PROJECTS_PATH,
						path,
					},
					requestHeaders
				);
			}
			return answer(
				url,
				method,
				null,
				404,
				{ error: "The requested folder does not exist in this fixture." },
				requestHeaders
			);
		}

		if (url.pathname === "/api/workspace/new-folder" && method === "POST") {
			const name = isNativeText(body?.name) ? body.name : "";
			if (consumeFlag("proof:project-picker:fail-create-once")) {
				return answer(
					url,
					method,
					body,
					403,
					{ error: "The active node does not permit project creation." },
					requestHeaders
				);
			}
			if (name === "Taken") {
				return answer(
					url,
					method,
					body,
					409,
					{ error: "A project with that name already exists." },
					requestHeaders
				);
			}
			if (!name || /[\\/]/.test(name)) {
				return answer(
					url,
					method,
					body,
					400,
					{ error: "Choose a single folder name." },
					requestHeaders
				);
			}
			const path = `${HOME_PATH}/Documents/Ryu/${name}`;
			saveCreatedPath(path);
			return answer(url, method, body, 200, { path }, requestHeaders);
		}

		if (url.pathname === "/api/workspace/clone" && method === "POST") {
			if (consumeFlag("proof:project-picker:fail-clone-once")) {
				return answer(
					url,
					method,
					body,
					403,
					{ error: "The active node denied Git clone access." },
					requestHeaders
				);
			}
			const name = isNativeText(body?.name) ? body.name : "";
			if (!name || /[\\/]/.test(name)) {
				return answer(
					url,
					method,
					body,
					400,
					{ error: "Choose a single repository folder name." },
					requestHeaders
				);
			}
			const path = `${HOME_PATH}/Documents/Ryu/${name}`;
			saveCreatedPath(path);
			return answer(url, method, body, 200, { name, path }, requestHeaders);
		}

		return answer(url, method, body, 200, {}, requestHeaders);
	};
	window.__projectPickerProof = {
		requests: () => JSON.parse(localStorage.getItem(REQUESTS_KEY) ?? "[]"),
	};
}

function seedWorkspace(): void {
	const url = new URL(window.location.href);
	if (!url.searchParams.has("reset")) {
		return;
	}
	for (const key of WORKSPACE_KEYS) {
		localStorage.removeItem(key);
	}
	for (const key of [
		REQUESTS_KEY,
		CREATED_PATHS_KEY,
		"proof:project-picker:fail-home-list-once",
		"proof:project-picker:fail-alpha-list-once",
		"proof:project-picker:fail-beta-list-once",
		"proof:project-picker:fail-created-folder-once",
		"proof:project-picker:fail-create-once",
		"proof:project-picker:fail-clone-once",
	]) {
		localStorage.removeItem(key);
	}
	localStorage.setItem(REQUESTS_KEY, "[]");
	localStorage.setItem(CREATED_PATHS_KEY, "[]");
	const empty = url.searchParams.has("empty");
	const projects = empty ? [] : TEST_PROJECTS;
	const activeFolder =
		url.searchParams.get("active") === "alpha" ? ALPHA_PATH : null;
	const recentFolders = activeFolder
		? [ALPHA_PATH, BETA_PATH]
		: empty
			? []
			: [ALPHA_PATH, BETA_PATH];
	localStorage.setItem("ryu_workspace_projects_v1", JSON.stringify(projects));
	localStorage.setItem("ryu_workspace_recents", JSON.stringify(recentFolders));
	localStorage.setItem("ryu_workspace_removed", "[]");
	localStorage.setItem(
		"ryu_workspace_names",
		JSON.stringify({
			[ALPHA_PATH]: "Alpha project",
			[BETA_PATH]: "Beta project",
		})
	);
	localStorage.setItem("ryu_workspace_icons", "{}");
	if (activeFolder) {
		localStorage.setItem("ryu_workspace_folder", activeFolder);
	} else {
		localStorage.removeItem("ryu_workspace_folder");
	}
	useWorkspaceStore.setState({
		folder: activeFolder,
		projectIcons: {},
		projectNames: {
			[ALPHA_PATH]: "Alpha project",
			[BETA_PATH]: "Beta project",
		},
		projects,
		recentFolders,
		removedProjects: [],
	});

	const remote = url.searchParams.has("node");
	useNodeStore.setState({
		activeNodeOnline: true,
		cloudNodes: remote ? [REMOTE_NODE] : [],
		defaultNode: remote ? REMOTE_NODE.name : LOCAL_FALLBACK.name,
		localNodes: [LOCAL_FALLBACK],
		nodes: remote ? [REMOTE_NODE, LOCAL_FALLBACK] : [LOCAL_FALLBACK],
	});
	url.searchParams.delete("reset");
	window.history.replaceState(
		null,
		"",
		`${url.pathname}${url.search}${url.hash}`
	);
}

function ProofSurface() {
	const [selectedFolder, setSelectedFolder] = useState("");
	const [dialogOpen, setDialogOpen] = useState(true);
	const activeFolder = useWorkspaceStore((state) => state.folder);
	return (
		<AppSurfaceProvider surface="desktop">
			<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
				<Toaster position="bottom-right" theme="dark" />
				<main
					className="min-h-screen bg-background p-8 text-foreground"
					data-testid="project-picker-proof"
				>
					<div className="mx-auto max-w-xl rounded-2xl border bg-card p-6 shadow-xl">
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							ChatPage · pending workspace request
						</p>
						<output aria-live="polite" data-testid="selected-folder">
							{selectedFolder || "No project selected"}
						</output>
						<output aria-live="polite" data-testid="active-folder">
							{activeFolder || "No active project"}
						</output>
					</div>
					<WorkspaceRequiredDialog
						onFolderSelected={setSelectedFolder}
						onOpenChange={setDialogOpen}
						open={dialogOpen}
					/>
				</main>
			</ThemeProvider>
		</AppSurfaceProvider>
	);
}

useNodeStore.setState({
	activeNodeOnline: true,
	cloudNodes: [],
	defaultNode: LOCAL_FALLBACK.name,
	localNodes: [LOCAL_FALLBACK],
	nodes: [LOCAL_FALLBACK],
});
seedWorkspace();
installLocalCoreFixture();

createRoot(document.getElementById("root")!).render(<ProofSurface />);
