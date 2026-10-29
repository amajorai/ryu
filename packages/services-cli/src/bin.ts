// packages/services-cli/src/bin.ts
//
// The `ryu-services` executable: runs the command line on this process's
// argv and sets the exit code. Kept apart from `index.ts` so importing or
// bundling the library never starts the CLI.

import { runCli } from "./cli.ts";

runCli(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`ryu-services failed: ${String(error)}\n`);
		process.exitCode = 1;
	}
);
