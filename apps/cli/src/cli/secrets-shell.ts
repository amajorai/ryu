// `ryu secrets shell`: an interactive shell with Secret Vault values in its
// environment, like `phase shell`. It is `ryu secrets run` with the caller's
// `$SHELL` (`%COMSPEC%` on Windows, else `/bin/sh`) as the command, so the
// same flags apply (`--env`, `--path`, `--tags`, `--lease`, `--recursive`,
// local env files) and leases are revoked when the shell exits. `--watch`
// would restart the shell and drop what was typed, and `--broker` already
// has `run`, so both are refused here. An AI agent cannot drive an
// interactive shell: `secrets.ts` refuses agent sessions unless a person
// confirms `--human`.

import { tf, tr } from "../i18n/translate.ts";
import type { SecretsArgs } from "./secrets-args.ts";
import { runWithSecrets } from "./secrets-run.ts";
import { type CliContext, UsageError } from "./types.ts";

const SHELL_USAGE =
	"Usage: ryu-cli secrets shell [--env E] [--path P] [--tags T,…] [--lease ROLE[=PREFIX]]…";

/** The interactive shell to start for this environment and platform. */
export function interactiveShell(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform = process.platform
): string {
	if (platform === "win32") {
		return env.COMSPEC?.trim() || "cmd.exe";
	}
	return env.SHELL?.trim() || "/bin/sh";
}

export async function shell(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	if ((args.passthrough?.length ?? 0) > 0 || args.positional.length > 1) {
		throw new UsageError(SHELL_USAGE);
	}
	if (args.booleans.has("--watch")) {
		throw new UsageError(
			"--watch restarts the command, which would end the shell. Use 'ryu-cli secrets run --watch -- CMD'."
		);
	}
	if (args.values.has("--broker")) {
		throw new UsageError(
			"Use 'ryu-cli secrets run --broker SVC -- CMD' for a brokered command."
		);
	}
	const command = interactiveShell(ctx.env);
	ctx.io.err(
		`${tf("ryu: starting {shell} with vault values; exit it to end the session.", { shell: command })}\n`
	);
	const code = await runWithSecrets(ctx, { ...args, passthrough: [command] });
	ctx.io.err(`${tr("ryu: vault shell ended.")}\n`);
	return code;
}
