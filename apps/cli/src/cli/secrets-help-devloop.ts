// Help entries for `run --recursive`, local `.env` layering, `example-env`, and
// `access` requests, spread into `SUBCOMMAND_HELP` (`secrets-help.ts`).

import { CLI_TRANSLATOR, type CliTranslator } from "../i18n/translate.ts";
import { type HelpEntry, renderHelpEntries } from "./secrets-help-format.ts";

/** The developer-loop help entries, described in the translator's locale. */
export function devloopHelpEntries(
	translator: Pick<CliTranslator, "tr"> = CLI_TRANSLATOR
): HelpEntry[] {
	const { tr } = translator;
	return [
		"",
		tr("Sub-folders and local env files (run without --broker):"),
		[
			"run --recursive -- CMD",
			tr(
				"Also inject values from sub-folders of --path; the folder's own values win, sub-folders only fill in (shallowest first)"
			),
		],
		[
			"run --dotenv -- CMD",
			tr("Also read .env, then .env.local, from this directory"),
		],
		[
			"run --env-file FILE… -- CMD",
			tr("Also read FILE (repeatable; later files win)"),
		],
		[
			"--dotenv-override",
			tr(
				"Local files win over vault values (default: vault wins and the files only fill in names it does not set); --lease is last"
			),
			6,
		],
		[
			"example-env [--env E] [--path P] [--recursive] [--tags T,…] [--out FILE]",
			tr(
				"Print or write NAME= lines for every name run would inject (never a value; --force replaces an existing FILE)"
			),
		],
		[
			"server --dev [--bind 127.0.0.1:8210]",
			tr(
				"Start a throwaway loopback vault (temporary data, deleted on Ctrl-C); never for production"
			),
		],
		"",
		tr("Access requests (time-bound access to a path on this node):"),
		"  access list [--status S] | access get ID | access policies",
		[
			"access request PATH --capability read[,write…] --ttl 1h --reason WHY",
			tr("PATH is ENV/folder/glob, for example prod/payments/**"),
		],
		"  access approve ID | access deny ID [--reason R] | access cancel ID | access revoke ID",
	];
}

export const DEVLOOP_HELP_LINES = renderHelpEntries(devloopHelpEntries());
