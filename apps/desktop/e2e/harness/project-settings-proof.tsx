import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { EnvironmentsSection } from "../../src/components/gateway/EnvironmentsSection.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { projectIdForFolder } from "../../src/lib/workspace-projects.ts";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import { initializeProjectSettingsFixture } from "./project-settings-proof.mock.ts";
import "../../src/index.css";

const PROJECT_PATH = "/fixture/projects/project-settings";
const SECONDARY_PATH = "/fixture/projects/shared";
const PROJECT_NAME = "Project Settings Fixture";
const PROJECT_ID = projectIdForFolder(PROJECT_PATH);
const PROJECT = {
	folders: [PROJECT_PATH, SECONDARY_PATH],
	id: PROJECT_ID,
	name: PROJECT_NAME,
};
const INITIAL_INSTRUCTIONS = "Keep project settings in the local fixture.\n";

interface ProjectSettingsWindow extends Window {
	__READ_PROJECT_SETTINGS_STORE__?: () => {
		activeProjectEnvironments: Record<string, string>;
		projectEnvironments: Record<string, unknown[]>;
		projectNames: Record<string, string>;
		projects: Array<{ folders: string[]; id: string; name?: string }>;
		recentFolders: string[];
		removedProjects: string[];
	};
}

function seedWorkspace(reset: boolean): void {
	const params = new URLSearchParams(window.location.search);
	if (reset) {
		for (const key of [
			"ryu_workspace_projects_v1",
			"ryu_workspace_folder",
			"ryu_workspace_recents",
			"ryu_workspace_names",
			"ryu_workspace_environments_v1",
			"ryu_workspace_active_environments_v1",
			"ryu_workspace_removed",
		]) {
			localStorage.removeItem(key);
		}
		localStorage.setItem(
			"ryu_workspace_projects_v1",
			JSON.stringify([PROJECT])
		);
		localStorage.setItem("ryu_workspace_folder", PROJECT_PATH);
		localStorage.setItem(
			"ryu_workspace_recents",
			JSON.stringify([PROJECT_PATH, SECONDARY_PATH])
		);
		localStorage.setItem(
			"ryu_workspace_names",
			JSON.stringify({ [PROJECT_PATH]: PROJECT_NAME })
		);
		localStorage.setItem("ryu_workspace_environments_v1", JSON.stringify({}));
		localStorage.setItem(
			"ryu_workspace_active_environments_v1",
			JSON.stringify({})
		);
		localStorage.setItem("ryu_workspace_removed", JSON.stringify([]));
		params.delete("reset");
		const search = params.toString();
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${search ? `?${search}` : ""}`
		);
		useWorkspaceStore.setState({
			activeProjectEnvironments: {},
			folder: PROJECT_PATH,
			projectEnvironments: {},
			projectNames: { [PROJECT_PATH]: PROJECT_NAME },
			projects: [PROJECT],
			recentFolders: [PROJECT_PATH, SECONDARY_PATH],
			removedProjects: [],
		});
	}
	/* SAFETY: This mutation view publishes only the private callback authored immediately here; its six cloned fields retain their existing native workspace-store ports, without validating persisted storage. */ (
		window as ProjectSettingsWindow
	).__READ_PROJECT_SETTINGS_STORE__ = () => {
		const current = useWorkspaceStore.getState();
		return {
			activeProjectEnvironments: structuredClone(
				current.activeProjectEnvironments
			),
			projectEnvironments: structuredClone(current.projectEnvironments),
			projectNames: structuredClone(current.projectNames),
			projects: structuredClone(current.projects),
			recentFolders: structuredClone(current.recentFolders),
			removedProjects: structuredClone(current.removedProjects),
		};
	};
}

const queryClient = new QueryClient({
	defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

function ProofSurface() {
	return (
		<QueryClientProvider client={queryClient}>
			<AppSurfaceProvider surface="desktop">
				<div className="dark min-h-screen bg-background text-foreground">
					<main className="mx-auto max-w-5xl px-7 py-8">
						<header className="mb-7">
							<p className="mb-2 text-primary text-xs tracking-(--tracking-section)">
								RYU · GATEWAY SETTINGS PROOF
							</p>
							<h1 className="font-medium text-3xl">Project environments</h1>
							<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
								Production project settings caller with local file, directory,
								clone, and mapping fixtures. No user folder or repository is
								accessed.
							</p>
						</header>
						<EnvironmentsSection />
					</main>
					<Toaster position="bottom-right" theme="dark" />
				</div>
			</AppSurfaceProvider>
		</QueryClientProvider>
	);
}

const shouldReset =
	new URLSearchParams(window.location.search).get("reset") === "true";
seedWorkspace(shouldReset);
initializeProjectSettingsFixture(shouldReset);
const fileKey = "project-settings-proof-files";
if (shouldReset || !localStorage.getItem(fileKey)) {
	localStorage.setItem(
		fileKey,
		JSON.stringify({ [`${PROJECT_PATH}/AGENTS.md`]: INITIAL_INSTRUCTIONS })
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing root");
}

createRoot(root).render(<ProofSurface />);
