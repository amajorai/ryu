// Run each Auth test file in its own Bun process. Bun's mock.module registry is
// process-global, so a partial mock from one file can otherwise leak into a
// later file even after mock.restore() runs.
import { spawnSync } from "node:child_process";
import { Glob } from "bun";

const files = [...new Glob("src/**/*.test.ts").scanSync(".")].sort();
if (files.length === 0) {
	console.error("no Auth test files found");
	process.exit(1);
}

let failed = 0;
for (const file of files) {
	const run = spawnSync("bun", ["test", "--timeout", "15000", file], {
		shell: true,
		stdio: "inherit",
	});
	if (run.status !== 0) {
		failed += 1;
		console.error(`FAIL ${file}`);
	}
}

console.log(`\n${files.length - failed}/${files.length} Auth test files green`);
process.exit(failed === 0 ? 0 : 1);
