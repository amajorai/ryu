import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentsSection } from "../../src/components/gateway/EnvironmentsSection.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import { installProjectEnvironmentFetch } from "./gateway-project-environments-proof.mock.ts";
import "../../src/index.css";

const projectPath = "/Users/proof/projects/ryu-app";
useWorkspaceStore.getState().addProjectFolder(projectPath);

declare global {
	interface Window {
		__PROJECT_ENVIRONMENT_PATH__?: string;
		__READ_PROJECT_ENVIRONMENT_STATE__?: () => {
			activeId: string | null;
			environments: unknown[];
		};
	}
}

window.__PROJECT_ENVIRONMENT_PATH__ = projectPath;
window.__READ_PROJECT_ENVIRONMENT_STATE__ = () => {
	const state = useWorkspaceStore.getState();
	return {
		activeId: state.activeProjectEnvironments[projectPath] ?? null,
		environments: state.projectEnvironments[projectPath] ?? [],
	};
};
const restoreFetch = installProjectEnvironmentFetch();
window.addEventListener("pagehide", restoreFetch, { once: true });

function ProofShell() {
	const queryClient = useMemo(
		() => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
		[]
	);

	return (
		<QueryClientProvider client={queryClient}>
			<AppSurfaceProvider surface="desktop">
				<div className="min-h-screen bg-background text-foreground">
					<main className="mx-auto max-w-5xl px-7 py-8">
						<header className="mb-7 flex items-start justify-between gap-6">
							<div>
								<p className="mb-2 text-primary text-xs tracking-(--tracking-section)">
									RYU · GATEWAY SETTINGS
								</p>
								<h1 className="font-medium text-3xl">Project environments</h1>
								<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
									Named local variables and actions for this project.
								</p>
							</div>
							<div className="rounded-full border border-success/50 bg-success/60 px-3 py-1.5 font-medium text-success text-xs">
								LOCAL API FIXTURES
							</div>
						</header>
						<EnvironmentsSection />
					</main>
					<Toaster position="bottom-right" theme="dark" />
				</div>
			</AppSurfaceProvider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing root");
}

createRoot(root).render(<ProofShell />);
