import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { CoworkContextPanel } from "../../src/components/panels/CoworkContextPanel.tsx";
import { queryClient } from "../../src/lib/query-client.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

interface ProofWindow extends Window {
	__diffBridgeCalls: {
		command: string;
		args?: {
			path?: string;
			content?: string;
			projectPath?: string;
			revision?: string;
		};
	}[];
	__diffReleaseRead?: () => void;
}
const proof =
	/* SAFETY: This module initializes its private command capture array below and stores the actual Promise<void> resolver in the optional release callback during the held read; the separate kernel owner is unchanged. */ window as ProofWindow;
const saved = new Map<string, string>();
let failedWrite = false;
proof.__diffBridgeCalls = [];
const proofTauriKernel = {
	invoke: async (
		command: string,
		args?: {
			path?: string;
			content?: string;
			projectPath?: string;
			revision?: string;
		}
	) => {
		proof.__diffBridgeCalls.push({ command, args });
		if (
			command === "read_git_project_file" &&
			String(args?.path).includes("alpha") &&
			location.search.includes("hold")
		) {
			await new Promise<void>((resolve) => {
				proof.__diffReleaseRead = resolve;
			});
		}
		if (command === "read_git_project_file") {
			return `export const ${String(args?.path).includes("beta") ? "beta" : "alpha"} = 'before';\n`;
		}
		if (command === "write_project_file") {
			if (!failedWrite) {
				failedWrite = true;
				throw new Error("File permission denied");
			}
			saved.set(String(args?.path), String(args?.content));
			return undefined;
		}
		if (command === "read_project_file") {
			return (
				saved.get(String(args?.path)) ??
				`export const ${String(args?.path).includes("beta") ? "beta" : "alpha"} = 'after';\n`
			);
		}
		throw new Error(`Unexpected bridge command: ${command}`);
	},
	transformCallback: () => 1,
};
// SAFETY: The mutation view installs this exact complete authored private kernel.
// Its inferred results come from the unchanged fixture bodies, not the public Tauri generic ABI.
(
	proof as Omit<typeof proof, "__TAURI_INTERNALS__"> & {
		__TAURI_INTERNALS__: typeof proofTauriKernel;
	}
).__TAURI_INTERNALS__ = proofTauriKernel;
const target = { url: location.origin, token: "diff-review-fixture" };
useNodeStore.setState({
	autoSelect: false,
	defaultNode: "Review",
	nodes: [{ name: "Review", ...target, userJwt: null }],
});
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={queryClient}>
		<TooltipProvider delay={0}>
			<main className="min-h-screen bg-background p-6 text-foreground">
				<h1 className="mb-4 font-medium">Completed run · Review changes</h1>
				<CoworkContextPanel
					chatStatus="ready"
					messages={[]}
					runId="review/run"
					sideChatsEnabled={false}
					target={target}
				/>
			</main>
		</TooltipProvider>
	</QueryClientProvider>
);
