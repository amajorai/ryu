// `ryu secrets run` without `--broker` puts vault values in the command's
// environment, so a command whose purpose is to print that environment
// (`printenv`, a bare `env` or `set`, `export -p`, `declare -p`, a shell `-c`
// script doing so) would write every injected value to the terminal, a log or
// CI output. Such a run is refused unless `--allow-env-dump` says the dump is
// intended. AI agent sessions are refused earlier by `secrets-agent-guard.ts`,
// which this flag does not lift. Detection is approximate by design (see
// `secrets-env-dump.ts`); it prevents accidents, it is not a sandbox.

import { tr } from "../i18n/translate.ts";
import type { SecretsArgs } from "./secrets-args.ts";
import { dumpsEnvironment } from "./secrets-env-dump.ts";
import type { CliContext } from "./types.ts";

export const ALLOW_ENV_DUMP_FLAG = "--allow-env-dump";

/** Exit code 1 (with a message) when `command` dumps its environment and the
 *  run did not pass `--allow-env-dump`, else null. */
export function refusePlainEnvDump(
	ctx: Pick<CliContext, "io">,
	args: SecretsArgs,
	command: string[]
): number | null {
	if (args.booleans.has(ALLOW_ENV_DUMP_FLAG) || !dumpsEnvironment(command)) {
		return null;
	}
	ctx.io.err(
		`${tr("Refusing to run a command that prints its environment: it would print every injected value. Use --broker SERVICE, or add --allow-env-dump if printing them is intended.")}\n`
	);
	return 1;
}
