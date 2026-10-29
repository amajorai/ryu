// packages/services-cli/src/program.ts
//
// The command line that invokes this CLI. Every help, usage, example and
// hint string is written with `ryu-services`; a host that delegates to
// `runCli` (`ryu-cli services`) sets `CliIo.program`, and the CLI rewrites
// those command lines on the way out with {@link withProgram}, so nothing it
// prints sends the reader to a binary their install does not have. Only text
// the CLI authors passes through it: command output (`box exec`, file
// contents) is never rewritten.

import { fileURLToPath } from "node:url";

/** The command line that runs this CLI when no host overrides it. */
export const DEFAULT_PROGRAM = "ryu-services";

/**
 * Every `ryu-services` that names the command, not the MCP server: not the
 * quoted `"ryu-services"` server key, the `claude mcp add ryu-services` server
 * name, or part of a longer word, path or package name.
 */
const PROGRAM_WORD = /(?<![\w"@/.-])(?<!mcp add )ryu-services(?![\w"-])/gu;

/**
 * `text` with each command-line `ryu-services` replaced by `program`.
 * Returns `text` itself when `program` is the default.
 */
export function withProgram(text: string, program: string | undefined): string {
	const name = program?.trim();
	if (!name || name === DEFAULT_PROGRAM) {
		return text;
	}
	return text.replace(PROGRAM_WORD, name);
}

/**
 * How to launch this checkout's CLI when it is a workspace build, where no
 * `ryu-services` executable is installed: `bun <checkout>/src/bin.ts` from
 * source, or `node <dist>/bin.js` from a local build.
 */
export function workspaceLauncher(
	moduleUrl: string = import.meta.url
): readonly string[] {
	const fromSource = moduleUrl.endsWith(".ts");
	const bin = fileURLToPath(
		new URL(fromSource ? "./bin.ts" : "./bin.js", moduleUrl)
	);
	return [fromSource ? "bun" : "node", bin];
}

/** Quotes one word of a shell command line when it needs it. */
export function shellWord(word: string): string {
	return /^[\w@%+=:,./-]+$/u.test(word)
		? word
		: `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * {@link workspaceLauncher} as one shell command line
 * (`bun <checkout>/src/bin.ts`): what usage and error hints name in a
 * workspace build in place of the uninstalled `ryu-services`.
 */
export function workspaceProgram(moduleUrl: string = import.meta.url): string {
	return workspaceLauncher(moduleUrl).map(shellWord).join(" ");
}
