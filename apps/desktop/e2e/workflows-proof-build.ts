import { tmpdir } from "node:os";
import path from "node:path";

// Where a workflows proof builds the Workflows Companion UI before its host
// serves it. It defaults under the OS temp dir (honouring TMPDIR) rather than a
// fixed /tmp path, so runs can keep the build off a full root disk;
// RYU_WORKFLOWS_PROOF_BUILD_ROOT moves every proof's build at once.
export function workflowsProofBuildDir(name: string): string {
	const root = process.env.RYU_WORKFLOWS_PROOF_BUILD_ROOT ?? tmpdir();
	return path.join(root, `ryu-workflows-${name}-build`);
}

export function workflowsProofBuildCommand(name: string, host: string): string {
	return `bunx vite build --config ../../apps-store/workflows/ui/vite.config.ts --outDir ${JSON.stringify(workflowsProofBuildDir(name))} && bun e2e/${host}`;
}
