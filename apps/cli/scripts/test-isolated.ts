import { spawnSync } from "node:child_process";
import { Glob } from "bun";

// OpenTUI loads a native library that Bun's in-process --isolate cannot
// initialize reliably. Separate processes also contain React renderer and
// mock.module state when a test fails or times out.
const files = [
	...new Glob("src/**/*.test.ts").scanSync("."),
	...new Glob("src/**/*.test.tsx").scanSync("."),
].sort();

if (files.length === 0) {
	console.error("No CLI test files found");
	process.exit(1);
}

let failed = 0;
for (const file of files) {
	const run = spawnSync(
		process.execPath,
		["test", "--timeout", "30000", file],
		{
			stdio: "inherit",
		}
	);
	if (run.status !== 0) {
		failed += 1;
		console.error(`FAIL ${file}`);
	}
}

console.log(`${files.length - failed}/${files.length} CLI test files green`);
process.exit(failed === 0 ? 0 : 1);
