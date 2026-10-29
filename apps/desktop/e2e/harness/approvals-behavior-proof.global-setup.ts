import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const approvalsUi = path.join(repositoryRoot, "apps-store/approvals/ui");
const distDir = path.join(tmpdir(), "ryu-approvals-behavior-app-dist");

export default function buildApprovalsCompanion(): void {
	const result = spawnSync(
		"bun",
		["x", "vite", "build", "--outDir", distDir, "--emptyOutDir"],
		{ cwd: approvalsUi, stdio: "inherit" }
	);
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`Approvals companion build exited with ${result.status}.`);
	}
}
