// Argument handling for `scripts/test-isolated.ts`.
//
// `bun run test <filter…>` must narrow the run the way `bun test <filter…>`
// does: a positional argument selects every discovered test file whose path
// contains it. Flags (and the value of the flags that take one) are forwarded
// to each per-file `bun test` child unchanged.
const FLAGS_WITH_VALUE = new Set([
	"-t",
	"--test-name-pattern",
	"--timeout",
	"--preload",
	"--rerun-each",
]);

export interface IsolatedRunArgs {
	childFlags: string[];
	filters: string[];
}

export function parseIsolatedRunArgs(argv: readonly string[]): IsolatedRunArgs {
	const childFlags: string[] = [];
	const filters: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (arg === "--") {
			continue;
		}
		if (!arg.startsWith("-")) {
			filters.push(arg.replace(/^\.\//, ""));
			continue;
		}
		childFlags.push(arg);
		const next = argv[index + 1];
		if (FLAGS_WITH_VALUE.has(arg) && next !== undefined) {
			childFlags.push(next);
			index += 1;
		}
	}
	return { childFlags, filters };
}

export function selectTestFiles(
	files: readonly string[],
	filters: readonly string[]
): string[] {
	if (filters.length === 0) {
		return [...files];
	}
	return files.filter((file) =>
		filters.some((filter) => file.includes(filter))
	);
}
