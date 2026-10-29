import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { createRoot } from "react-dom/client";
import { PatchDiffPanel } from "../../src/components/panels/WorkspacePanels.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

interface BridgeOutput {
	code: number;
	stderr: string;
	stdout: string;
}

interface PatchDiffCall {
	args?: { command?: string; path?: string; projectPath?: string };
	command: string;
}

interface PatchDiffProofFixture {
	failNextCommand: (command: string, message?: string) => void;
	holdNextCommand: (command: string) => void;
	resolveHeldCommand: (command: string) => void;
}

interface PatchDiffProofWindow extends Window {
	__patchDiffCalls: PatchDiffCall[];
	__patchDiffFixture: PatchDiffProofFixture;
}

const COMMIT_SHA = "abcdef012345678901234567890123456789abcd";
const LOG_COMMAND = "git log -n 50 --pretty=format:%H%x09%s";
const BRANCH_COMMAND = 'git branch --format="%(refname:short)"';
const WORKING_PATCH = [
	"diff --git a/src/working.ts b/src/working.ts",
	"index 1111111..2222222 100644",
	"--- a/src/working.ts",
	"+++ b/src/working.ts",
	"@@ -1 +1 @@",
	"-export const state = 'clean';",
	"+export const state = 'working tree';",
].join("\n");
const STAGED_PATCH = [
	"diff --git a/src/staged.ts b/src/staged.ts",
	"index 1111111..2222222 100644",
	"--- a/src/staged.ts",
	"+++ b/src/staged.ts",
	"@@ -1 +1 @@",
	"-export const state = 'before staging';",
	"+export const state = 'staged change';",
].join("\n");
const COMMIT_PATCH = [
	"diff --git a/src/commit.ts b/src/commit.ts",
	"index 1111111..2222222 100644",
	"--- a/src/commit.ts",
	"+++ b/src/commit.ts",
	"@@ -1 +1 @@",
	"-export const state = 'previous';",
	"+export const state = 'selected commit';",
].join("\n");
const BRANCH_PATCH = [
	"diff --git a/src/branch.ts b/src/branch.ts",
	"index 1111111..2222222 100644",
	"--- a/src/branch.ts",
	"+++ b/src/branch.ts",
	"@@ -1 +1 @@",
	"-export const state = 'base';",
	"+export const state = 'branch change';",
].join("\n");

const isEmptyFixture = new URLSearchParams(location.search).has("empty");
const calls: PatchDiffCall[] = [];
const failures = new Map<string, string>();
const heldNext = new Set<string>();
const pending = new Map<string, (result: BridgeOutput) => void>();

function outputFor(command: string): BridgeOutput {
	if (command === LOG_COMMAND) {
		return {
			code: 0,
			stderr: "",
			stdout: isEmptyFixture ? "" : `${COMMIT_SHA}\tInitial baseline\n`,
		};
	}
	if (command === BRANCH_COMMAND) {
		return {
			code: 0,
			stderr: "",
			stdout: isEmptyFixture ? "" : "main\nfeature/review\n",
		};
	}
	if (command === "git diff HEAD") {
		return { code: 0, stderr: "", stdout: isEmptyFixture ? "" : WORKING_PATCH };
	}
	if (command === "git diff --staged") {
		return { code: 0, stderr: "", stdout: isEmptyFixture ? "" : STAGED_PATCH };
	}
	if (command === `git diff-tree -p --no-commit-id --root ${COMMIT_SHA}`) {
		return { code: 0, stderr: "", stdout: COMMIT_PATCH };
	}
	if (command === "git diff feature/review...HEAD") {
		return { code: 0, stderr: "", stdout: BRANCH_PATCH };
	}
	return { code: 0, stderr: "", stdout: "" };
}

const proofWindow =
	/* SAFETY: This module publishes its typed private calls array and three authored fixture callbacks immediately below; the separate kernel mutation retains its existing exact inferred owner. */ window as PatchDiffProofWindow;
proofWindow.__patchDiffCalls = calls;
proofWindow.__patchDiffFixture = {
	failNextCommand: (
		command,
		message = "fatal: fixture repository is unavailable"
	) => {
		failures.set(command, message);
	},
	holdNextCommand: (command) => {
		heldNext.add(command);
	},
	resolveHeldCommand: (command) => {
		const resolve = pending.get(command);
		if (resolve) {
			pending.delete(command);
			resolve(outputFor(command));
		}
	},
};
const proofTauriKernel = {
	invoke: async (
		command: string,
		args?: { command?: string; path?: string; projectPath?: string }
	) => {
		calls.push({ args, command });
		if (command === "shell_execute") {
			const shellCommand = String(args?.command ?? "");
			const failure = failures.get(shellCommand);
			if (failure) {
				failures.delete(shellCommand);
				return {
					code: 128,
					stderr: failure,
					stdout: "",
				} satisfies BridgeOutput;
			}
			if (heldNext.delete(shellCommand)) {
				return new Promise<BridgeOutput>((resolve) => {
					pending.set(shellCommand, resolve);
				});
			}
			return outputFor(shellCommand);
		}
		if (command === "read_git_project_file") {
			return "export const state = 'clean';\n";
		}
		if (command === "read_project_file") {
			return "export const state = 'working tree';\n";
		}
		if (command === "write_project_file") {
			return undefined;
		}
		throw new Error(`Unexpected fixture bridge command: ${command}`);
	},
	transformCallback: () => 1,
};
// SAFETY: The mutation view installs this exact complete authored private kernel.
// Its inferred results come from the unchanged fixture bodies, not the public Tauri generic ABI.
(
	proofWindow as Omit<typeof proofWindow, "__TAURI_INTERNALS__"> & {
		__TAURI_INTERNALS__: typeof proofTauriKernel;
	}
).__TAURI_INTERNALS__ = proofTauriKernel;

useNodeStore.setState({
	autoSelect: false,
	defaultNode: "Proof",
	nodes: [
		{
			name: "Proof",
			token: null,
			url: "http://127.0.0.1:5238",
			userJwt: null,
		},
	],
});

function ProofPage() {
	return (
		<main className="flex h-screen flex-col bg-background text-foreground">
			<header className="flex h-14 shrink-0 items-center justify-between border-border/70 border-b px-5">
				<h1 className="font-medium text-sm">Project changes</h1>
				<span className="text-muted-foreground text-xs">
					demo-repo · feature/review
				</span>
			</header>
			<div className="min-h-0 flex-1 px-5 py-4">
				<PatchDiffPanel folder="/Users/demo/demo-repo" />
			</div>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<TooltipProvider delay={0}>
		<ProofPage />
	</TooltipProvider>
);
