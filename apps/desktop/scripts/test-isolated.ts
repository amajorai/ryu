// Runs every test file in its OWN bun process.
//
// Required for this package for the same reason `packages/api` needs it, but a
// different global: happy-dom. Nine suites call `GlobalRegistrator.register()`,
// which replaces `window`, `localStorage`, `Response`, `ReadableStream` and
// `TransformStream` on `globalThis` for the WHOLE process — and `bun test`
// imports every file before running any test, so those swaps land before the
// first assertion regardless of file order.
//
// The failures that produced were all of the "passes alone, fails in the suite"
// kind, which is the expensive kind to chase:
//   - a file stubbing `window` left every later file without `dispatchEvent`;
//   - `globalThis.localStorage = …` threw "assign to readonly property" once any
//     sibling had registered happy-dom;
//   - `instrumentedFetch` piped a bun-native `Response.body` into a happy-dom
//     `TransformStream` and died on "readable should be ReadableStream", purely
//     because an unrelated sibling had registered first.
//
// Per-file processes remove the shared global entirely, so no suite has to
// defend against what its neighbours install.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Glob } from "bun";

const files = [
	...new Glob("{src,components,lib,e2e}/**/*.test.{ts,tsx}").scanSync("."),
].sort();
if (files.length === 0) {
	console.error("no test files found");
	process.exit(1);
}

// `NODE_ENV=test` for the children, explicitly.
//
// `bun run` (how this script is invoked) resolves NODE_ENV to development and
// therefore loads `.env.development`, which sets `VITE_CORE_URL` to the dev
// profile's port 8980; `bun test <file>` run directly resolves it to test and
// loads `.env`, which uses the release port 7980. That single variable decides
// what `isLocalNode` considers local, so under the wrong one a fixture node at
// 127.0.0.1:7980 stops looking local, gets probed as a remote, and
// `useNodeStore`'s auto-selection assertions invert.
//
// A test runner must not change what the tests see. Pinning it here keeps the
// isolated run identical to running any single file by hand, instead of leaving
// the answer to how the script happened to be launched.
const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test" };

// Setting NODE_ENV alone is NOT enough. `bun run` already loaded
// `.env.development` into THIS process before any of this code ran, and bun does
// not let a `.env` value override a variable that is already present in the
// environment — so the dev port would be inherited by every child no matter what
// NODE_ENV says. Drop the keys that file defines and let each child resolve them
// from the `.env` its own NODE_ENV selects.
const devEnvPath = ".env.development";
if (existsSync(devEnvPath)) {
	for (const line of readFileSync(devEnvPath, "utf8").split("\n")) {
		const key = line.trim().split("=")[0]?.trim();
		if (key && !key.startsWith("#")) {
			delete childEnv[key];
		}
	}
}

// A file that never settles (an awaited stream nobody closes) must fail the
// gate, not hold it open forever with every later file unrun.
const FILE_TIMEOUT_MS = 10 * 60 * 1000;

let failed = 0;
for (const file of files) {
	const run = spawnSync("bun", ["test", file], {
		stdio: "inherit",
		env: childEnv,
		killSignal: "SIGKILL",
		timeout: FILE_TIMEOUT_MS,
	});
	if (run.status !== 0) {
		failed += 1;
		const reason =
			run.signal === "SIGKILL" ? ` (killed after ${FILE_TIMEOUT_MS} ms)` : "";
		console.error(`FAIL ${file}${reason}`);
	}
}
console.log(`\n${files.length - failed}/${files.length} test files green`);
process.exit(failed === 0 ? 0 : 1);
