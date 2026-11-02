import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let initScript: Promise<string> | undefined;
/** Native browser codecs run in the same realm as the fixture transport. */
export function sideChatCodecScript() {
	// Bundle with the `bun build` CLI rather than the in-process Bun.build API,
	// so the spec also runs under the default Node-hosted Playwright CLI.
	initScript ??= (async () => {
		const entry = fileURLToPath(
			new URL("./side-chat-proof.browser.ts", import.meta.url)
		);
		try {
			const { stdout } = await execFileAsync(
				"bun",
				["build", entry, "--target=browser", "--format=iife"],
				{ maxBuffer: 64 * 1024 * 1024 }
			);
			if (!stdout.trim()) {
				throw new Error("Missing native side-chat proof codec artifact");
			}
			return stdout;
		} catch (error) {
			throw new Error("Could not compile native side-chat proof codecs", {
				cause: error,
			});
		}
	})();
	return initScript;
}
