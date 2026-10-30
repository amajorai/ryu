// Builds the reply-message proof page before its file:// suite runs.
//
// The suite opens one self-contained page from disk (no dev server), so the page
// has to be built first. It is rebuilt only when it is missing, so a run over an
// existing build stays fast; delete the output to rebuild after a change.
// `REPLY_MESSAGE_PROOF_DIST` moves the output (and the suite's base URL) out of
// the tree, for example to a scratch directory.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const REPLY_MESSAGE_PROOF_DIST =
	process.env.REPLY_MESSAGE_PROOF_DIST ??
	path.resolve(import.meta.dirname, "dist");

export default function buildReplyMessageProof(): void {
	if (
		existsSync(path.join(REPLY_MESSAGE_PROOF_DIST, "reply-message-proof.html"))
	) {
		return;
	}
	execFileSync(
		"bunx",
		[
			"vite",
			"build",
			"--config",
			"e2e/harness/vite.reply-message-file-proof.config.ts",
			"--outDir",
			REPLY_MESSAGE_PROOF_DIST,
		],
		{
			cwd: path.resolve(import.meta.dirname, "../.."),
			// The single-file build of the transcript graph needs more than
			// Node's default heap.
			env: {
				...process.env,
				NODE_OPTIONS: [
					process.env.NODE_OPTIONS,
					process.env.NODE_OPTIONS?.includes("--max-old-space-size")
						? null
						: "--max-old-space-size=6144",
				]
					.filter(Boolean)
					.join(" "),
			},
			stdio: "inherit",
		}
	);
}
