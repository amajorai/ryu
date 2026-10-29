// Bun module mocks survive mock.restore(). Run each suite in its own process
// so fallback-engine and DOM fixtures cannot replace another suite's runtime.
import { spawnSync } from "node:child_process";
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
		console.error(`FAIL ${file}`);
	}
}
console.log(`\n${files.length - failed}/${files.length} test files green`);
process.exit(failed === 0 ? 0 : 1);
