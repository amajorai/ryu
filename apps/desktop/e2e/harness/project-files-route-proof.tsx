import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import ProjectFilesPage from "../../src/pages/ProjectFilesPage.tsx";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import "../../src/index.css";

interface BridgeCall {
	args?: { cwd?: string; command?: string; path?: string; opener?: string };
	command: string;
}
interface Fixture {
	calls: BridgeCall[];
	failNext: (command: string) => void;
	releaseHeldListing: () => Promise<void>;
	setFolder: (folder: string) => void;
}
interface ProofWindow extends Window {
	__projectFiles: Fixture;
	__TAURI_INTERNALS__?: {
		invoke: (
			command: string,
			args?: { cwd?: string; command?: string; path?: string; opener?: string }
		) => Promise<
			| { code: number; stderr: string; stdout: string }
			| { id: string; available: boolean }[]
			| undefined
		>;
		transformCallback: (...args: unknown[]) => number;
	};
}

// SAFETY: This write view publishes the complete local fixture below before rendering; replacement callbacks keep its declared string and Promise<void> inputs/outputs. The controlled bridge still returns unknown.
const proofWindow = window as ProofWindow;
const params = new URLSearchParams(location.search);
const failures = new Set<string>();
const fixture: Fixture = {
	calls: [],
	failNext: (command) => failures.add(command),
	setFolder: () => {
		throw new Error("Project route is not mounted yet");
	},
	releaseHeldListing: async () => {
		throw new Error("No listing is held");
	},
};
proofWindow.__projectFiles = fixture;
proofWindow.__TAURI_INTERNALS__ = {
	invoke: async (command, args) => {
		fixture.calls.push({ command, args });
		if (failures.delete(command)) {
			if (command === "shell_execute") {
				return {
					code: 128,
					stderr: "Fixture repository read denied",
					stdout: "",
				};
			}
			throw new Error("Fixture workspace item unavailable");
		}
		if (command === "shell_execute") {
			if (params.has("hold")) {
				params.delete("hold");
				return new Promise<{ code: number; stderr: string; stdout: string }>(
					(resolve) => {
						fixture.releaseHeldListing = () =>
							new Promise<void>((completed) => {
								resolve({ code: 0, stderr: "", stdout: "README.md\n" });
								requestAnimationFrame(() =>
									requestAnimationFrame(() => completed())
								);
							});
					}
				);
			}
			if (params.has("failure")) {
				params.delete("failure");
				return {
					code: 128,
					stderr: "Fixture repository read denied",
					stdout: "",
				};
			}
			return {
				code: 0,
				stderr: "",
				stdout:
					args?.cwd === "/tmp/ryu-new-project-fixture"
						? "new-project.ts\n"
						: params.has("empty")
							? ""
							: "README.md\nsrc/index.ts\nsrc/untracked.ts\n",
			};
		}
		if (command === "get_editor_availability") {
			return [
				{ id: "vscode", available: true },
				{ id: "cursor", available: false },
				{ id: "terminal", available: true },
			];
		}
		if (["open_workspace_item", "reveal_workspace_item"].includes(command)) {
			return undefined;
		}
		throw new Error(`Unexpected fixture command: ${command}`);
	},
	transformCallback: () => 1,
};

useWorkspaceStore.setState({ defaultFileOpener: "vscode" });

function ProofPage() {
	const [folder, setFolder] = useState("/tmp/ryu-project-files-fixture");
	fixture.setFolder = setFolder;
	return (
		<main className="flex h-screen flex-col bg-background text-foreground">
			<header className="flex h-14 shrink-0 items-center border-border border-b px-5">
				<h1 className="font-medium text-sm">Project files</h1>
			</header>
			<div className="min-h-0 flex-1">
				<ProjectFilesPage folder={folder} />
			</div>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<AppSurfaceProvider surface={params.has("web") ? "web" : "desktop"}>
		<ThemeProvider attribute="class" defaultTheme="dark" forcedTheme="dark">
			<TooltipProvider delay={0}>
				<ProofPage />
				<Toaster />
			</TooltipProvider>
		</ThemeProvider>
	</AppSurfaceProvider>
);
