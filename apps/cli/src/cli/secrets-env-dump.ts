// Recognises commands whose purpose is to print the environment `ryu secrets
// run` injected (and shells that would run whatever arrives on stdin), so the
// AI agent guard in `secrets-agent-guard.ts` can refuse them. Approximate by
// design: it reduces accidental exposure; it is not a sandbox.

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish"]);
/** `env` options whose value is the next token. */
const ENV_VALUE_OPTIONS = new Set(["-u", "--unset", "-C", "--chdir"]);
/** Shell options whose value is the next token (so it is not a script file). */
const SHELL_VALUE_OPTIONS = new Set([
	"-o",
	"+o",
	"-O",
	"+O",
	"--rcfile",
	"--init-file",
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Splits a shell script into simple commands. Approximate by design. */
const SCRIPT_SEPARATORS = /\$\(|[;&|\n(){}`]/;
const SHELL_COMMAND_OPTION = /^-[a-z]*c[a-z]*$/;
const SHELL_STDIN_OPTION = /^-[a-zA-Z]*s[a-zA-Z]*$/;
const MAX_DEPTH = 4;

interface WrapperSpec {
	/** Operands the wrapper takes before the command (`timeout DURATION`). */
	operands?: number;
	/** Options whose value is the next token. */
	values?: readonly string[];
}

/** Commands that run the rest of their arguments as another command. */
const WRAPPERS: Record<string, WrapperSpec> = {
	builtin: {},
	busybox: {},
	command: {},
	doas: { values: ["-u", "-C"] },
	exec: { values: ["-a"] },
	nice: { values: ["-n", "--adjustment"] },
	nohup: {},
	setsid: {},
	stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"] },
	sudo: {
		values: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "-R"],
	},
	time: { values: ["-f", "-o", "--format", "--output"] },
	timeout: { values: ["-s", "-k", "--signal", "--kill-after"], operands: 1 },
	xargs: {
		values: ["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file"],
	},
};

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function readsProcEnviron(token: string): boolean {
	return token.includes("/proc/") && token.includes("environ");
}

function isOption(token: string): boolean {
	return token.startsWith("-") && token !== "-";
}

/** `words` after its wrapper's options and leading operands. */
function afterWrapper(spec: WrapperSpec, words: string[]): string[] {
	const values = new Set(spec.values ?? []);
	let index = 1;
	while (index < words.length) {
		const token = words[index] ?? "";
		if (token === "--") {
			index += 1;
			break;
		}
		if (values.has(token)) {
			index += 2;
		} else if (isOption(token) || ASSIGNMENT.test(token)) {
			index += 1;
		} else {
			break;
		}
	}
	return words.slice(index + (spec.operands ?? 0));
}

/** The command `words` actually runs once transparent wrappers such as
 *  `exec`, `nohup`, `timeout 5` or `sudo -u me` are removed. */
export function unwrapCommand(command: string[]): string[] {
	let words = command.filter((word) => !ASSIGNMENT.test(word));
	for (;;) {
		const [head, ...rest] = words;
		const name = head === undefined ? undefined : basename(head);
		const spec = name === undefined ? undefined : WRAPPERS[name];
		if (spec === undefined) {
			return words;
		}
		// `command -v NAME` describes NAME instead of running it.
		if (
			name === "command" &&
			rest.some((token) => /^-[a-zA-Z]*[vV]/.test(token))
		) {
			return [];
		}
		words = afterWrapper(spec, words);
	}
}

/** The command `env [OPTIONS] [NAME=VALUE…] [CMD …]` runs, or [] for a dump. */
function envOperand(rest: string[]): string[] {
	let index = 0;
	while (index < rest.length) {
		const token = rest[index] ?? "";
		if (ENV_VALUE_OPTIONS.has(token)) {
			index += 2;
		} else if (token.startsWith("-") || ASSIGNMENT.test(token)) {
			index += 1;
		} else {
			break;
		}
	}
	return rest.slice(index);
}

function shellScript(rest: string[]): string | null {
	const at = rest.findIndex(
		(token) => SHELL_COMMAND_OPTION.test(token) || token === "--command"
	);
	return at === -1 ? null : (rest[at + 1] ?? null);
}

function scriptSegments(script: string): string[][] {
	return script
		.split(SCRIPT_SEPARATORS)
		.map((segment) => segment.trim().split(/\s+/).filter(Boolean));
}

function builtinDumps(name: string, rest: string[]): boolean {
	switch (name) {
		case "printenv":
			return true;
		case "export":
			return rest.length === 0 || rest.includes("-p");
		case "declare":
		case "typeset":
			return (
				rest.length === 0 || rest.some((token) => /^-[a-zA-Z]*[px]/.test(token))
			);
		case "set":
			return rest.length === 0;
		case "compgen":
			return rest.some((token) => /^-[a-zA-Z]*[ev]/.test(token));
		default:
			return false;
	}
}

/** True when `command` exists to print its environment (and so the values
 *  `run` injected): `printenv`, a bare `env`, `export -p`, `declare -p`, a
 *  bare `set`, reads of `/proc/…/environ`, or a shell `-c` script doing so,
 *  also behind wrappers such as `exec`, `nohup` or `timeout 5`. */
export function dumpsEnvironment(command: string[], depth = 0): boolean {
	if (depth > MAX_DEPTH) {
		return true;
	}
	if (command.some(readsProcEnviron)) {
		return true;
	}
	const [head, ...rest] = unwrapCommand(command);
	if (head === undefined) {
		return false;
	}
	const name = basename(head);
	if (name === "env") {
		const operand = envOperand(rest);
		return operand.length === 0 || dumpsEnvironment(operand, depth + 1);
	}
	if (SHELLS.has(name)) {
		const script = shellScript(rest);
		return (
			script !== null &&
			scriptSegments(script).some((words) => dumpsEnvironment(words, depth + 1))
		);
	}
	return builtinDumps(name, rest);
}

/** True when a shell reads its script from stdin: `-s`, or neither a `-c`
 *  script nor a script file operand. */
function shellReadsStdin(rest: string[]): boolean {
	if (rest.some((token) => SHELL_STDIN_OPTION.test(token))) {
		return true;
	}
	let index = 0;
	while (index < rest.length) {
		const token = rest[index] ?? "";
		if (SHELL_VALUE_OPTIONS.has(token)) {
			index += 2;
		} else if (isOption(token) || token.startsWith("+")) {
			index += 1;
		} else {
			return false;
		}
	}
	return true;
}

/** True when `command` (or a shell `-c` script inside it) starts a shell that
 *  runs whatever arrives on stdin, such as `printf 'env\n' | … -- sh`. Such a
 *  command can dump its environment without naming the dump. */
export function readsScriptFromStdin(command: string[], depth = 0): boolean {
	if (depth > MAX_DEPTH) {
		return true;
	}
	const [head, ...rest] = unwrapCommand(command);
	if (head === undefined) {
		return false;
	}
	const name = basename(head);
	if (name === "env") {
		return readsScriptFromStdin(envOperand(rest), depth + 1);
	}
	if (!SHELLS.has(name)) {
		return false;
	}
	const script = shellScript(rest);
	if (script === null) {
		return shellReadsStdin(rest);
	}
	return scriptSegments(script).some((words) =>
		readsScriptFromStdin(words, depth + 1)
	);
}
