// Bun module mocks survive mock.restore(). Run each suite in its own process
// so fallback-engine and DOM fixtures cannot replace another suite's runtime.
import { sep } from "node:path";
import { Glob } from "bun";
import { runIsolatedTestFiles } from "./isolated-test-pool.ts";

const files = [
	...new Glob("{src,scripts}/**/*.test.{ts,tsx}").scanSync("."),
].sort();
if (files.length === 0) {
	console.error("no test files found");
	process.exit(1);
}
// Files run concurrently, so a CPU-starved file can outlast Bun's 5 s default
// test timeout; 15 s matches apps/web's runner.
const failed = await runIsolatedTestFiles(
	files.map((file) => ({
		args: ["test", "--timeout", "15000", file],
		// Named with `/` separators, as on POSIX, whatever the OS.
		file: file.split(sep).join("/"),
	})),
	{ env: { ...process.env, NODE_ENV: "test" } }
);
for (const file of failed) {
	console.error(`FAIL ${file}`);
}
console.log(
	`\n${files.length - failed.length}/${files.length} test files green`
);
process.exit(failed.length === 0 ? 0 : 1);
