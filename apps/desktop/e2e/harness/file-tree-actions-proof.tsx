import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { FileTreePanel } from "../../src/components/panels/WorkspacePanels.tsx";
import { AppearanceTab } from "../../src/components/settings/AppearanceTab.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";
const headers = { "x-file-tree-proof": "finite-native-boundary" };
const boot = await fetch("/__file-tree/state", { headers });
if (!boot.ok) throw new Error("Independent project fixture unavailable");
const { project, secondaryProject } = (await boot.json()) as {
	project: string;
	secondaryProject: string;
};
declare global {
	interface Window {
		__fileTreeCompletions: { command: string; args: unknown }[];
	}
}
window.__fileTreeCompletions = [];
mockIPC(async (command, args) => {
	const response = await fetch("/__file-tree/invoke", {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify({ command, args }),
	});
	const body = (await response.json()) as { result?: unknown; error?: string };
	window.__fileTreeCompletions.push({ command, args });
	if (!response.ok) throw new Error(body.error);
	return body.result;
});
useNodeStore.setState({
	autoSelect: false,
	defaultNode: "Files proof",
	nodes: [
		{
			name: "Files proof",
			url: location.origin,
			token: "file-tree-proof-token",
			userJwt: null,
		},
	],
});
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
function ProjectFiles() {
	const [folder, setFolder] = useState(project);
	const [visible, setVisible] = useState(true);
	return (
		<section className="flex h-full min-h-0 flex-col p-4">
			<header className="flex gap-2 pb-4">
				<button type="button" onClick={() => setFolder(secondaryProject)}>
					Open alternate project
				</button>
				<button type="button" onClick={() => setVisible(false)}>
					Close Files
				</button>
				<button type="button" onClick={() => setVisible(true)}>
					Reopen Files
				</button>
			</header>
			<div data-testid="files" className="min-h-0 flex-1">
				{visible && <FileTreePanel folder={folder} />}
			</div>
		</section>
	);
}
createRoot(document.getElementById("root")!).render(
	<MemoryRouter>
		<QueryClientProvider client={client}>
			<AppSurfaceProvider
				surface={
					new URLSearchParams(location.search).has("web") ? "web" : "desktop"
				}
			>
				<I18nProvider>
					<ThemeProvider
						attribute="class"
						defaultTheme="dark"
						enableSystem={false}
					>
						<TooltipProvider delay={0}>
							<main className="grid h-screen grid-cols-2 bg-background text-foreground">
								<ProjectFiles />
								<section data-testid="settings" className="overflow-auto p-4">
									<AppearanceTab />
								</section>
							</main>
							<Toaster />
						</TooltipProvider>
					</ThemeProvider>
				</I18nProvider>
			</AppSurfaceProvider>
		</QueryClientProvider>
	</MemoryRouter>
);
