// Bun module mocks survive mock.restore(). Run each suite in its own process
// so fallback-engine and DOM fixtures cannot replace another suite's runtime.
import { spawnSync } from "node:child_process";
import { sep } from "node:path";
import { Glob } from "bun";

const files = [
	...new Glob("{src,scripts}/**/*.test.{ts,tsx}").scanSync("."),
].sort();
if (files.length === 0) {
	console.error("no test files found");
	process.exit(1);
}
let failed = 0;
for (const file of files) {
	const result = spawnSync(process.execPath, ["test", file], {
		env: { ...process.env, NODE_ENV: "test" },
		stdio: "inherit",
	});
	if (result.status !== 0) {
		failed += 1;
		// Named with `/` separators, as on POSIX, whatever the OS.
		console.error(`FAIL ${file.split(sep).join("/")}`);
	}
}
console.log(`\n${files.length - failed}/${files.length} test files green`);
process.exit(failed === 0 ? 0 : 1);
