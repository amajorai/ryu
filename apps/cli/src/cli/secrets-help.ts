// `ryu-cli secrets help`: usages and flags stay verbatim; headings and
// descriptions render in the CLI locale (`secrets-help-format.ts` lays them
// out). Administration, broker and machine sections live in
// `secrets-help-admin.ts` and `secrets-help-machines.ts`.

import { CLI_TRANSLATOR, type CliTranslator } from "../i18n/translate.ts";
import { adminHelpEntries } from "./secrets-help-admin.ts";
import { devloopHelpEntries } from "./secrets-help-devloop.ts";
import { engineHelpEntries } from "./secrets-help-engines.ts";
import { type HelpEntry, renderHelpEntries } from "./secrets-help-format.ts";
import { machineHelpEntries } from "./secrets-help-machines.ts";

type HelpTranslator = Pick<CliTranslator, "tr">;

function valueEntries({ tr }: HelpTranslator): HelpEntry[] {
	return [
		`ryu-cli secrets — ${tr("manage the Secret Vault on the target Core node.")}`,
		"",
		tr("Values:"),
		["list [--env E] [--path P]", tr("List visible values (metadata only)")],
		["get NAME [VERSION]", tr("Reveal one value (requires read)")],
		[
			"confirm [CODE] [--method totp|backup|password|otp]",
			tr(
				"Confirm it's you so get/export/run can read shared team and org values for 10 minutes (password on stdin)"
			),
		],
		[
			"set NAME [VALUE|-] [metadata flags]",
			tr("Write a value (stdin when VALUE is - or omitted)"),
		],
		"      --description T --tag T (repeatable) --expires-at RFC3339 --rotate-every 30d",
		`      --type config|secret|sealed (${tr("sealed is use-only and one-way")})`,
		[
			"--random [--length 32] [--charset alphanumeric|hex|base64url|symbols]",
			tr("Generate the value here (never printed); rotation reuses it"),
			6,
		],
		[
			"delete NAME [--force]",
			tr("Soft-delete (restorable); refused while broker services use it"),
		],
		[
			"destroy NAME VERSION… | destroy NAME --all",
			tr("Permanently erase versions (not restorable)"),
		],
		["versions NAME", tr("List versions (never values)")],
		["rollback NAME VERSION", tr("Make an older version current")],
		["restore NAME", tr("Undo a soft delete")],
		`  ${tr("Coordinates:")} --scope user|node|team|org --scope-id ID --env E --path /folder`,
	];
}

function workflowEntries({ tr }: HelpTranslator): HelpEntry[] {
	return [
		"",
		tr("Developer workflow:"),
		"  init --env E [--path P] [--tags T,…] [--org-project ID] [--broker SVC,…] [--placeholder VAR,…]",
		[
			"[--out .ryu/vault.json] [--force]",
			tr(
				"Write .ryu-vault.json here; commands in this directory and below default to its environment, folder, tags, and project (--no-project ignores it); with --broker, run brokers those services by default (--no-broker passes values instead)"
			),
			6,
		],
		[
			"run [--env E] [--path P] -- CMD ARGS…",
			tr("Run CMD with values in its environment"),
		],
		["--tags T,…", tr("Only values tagged with one of these tags"), 6],
		[
			"--org-project ID",
			tr("Also include this organization project's values (export too)"),
			6,
		],
		[
			"--lease ROLE[=PREFIX]… [--lease-ttl 1h]",
			tr(
				"Add a dynamic credential (PREFIX_FIELD); renewed while CMD runs, revoked on exit"
			),
			6,
		],
		["--watch", tr("Restart CMD when its values or leases change"), 6],
		[
			"--allow-env-dump",
			tr("Allow a CMD that prints its env (printenv, env, set, export -p)"),
			6,
		],
		[
			"shell [--env E] [--path P] [--tags T,…] [--lease ROLE[=PREFIX]]…",
			tr("Start $SHELL with values in its env; leases revoked on exit"),
		],
		[
			"run --broker SVC[,SVC…] [--env E] [--ttl 15m] -- CMD ARGS…",
			tr("Run CMD through the credential broker (no values in its env)"),
		],
		[
			"[--placeholder VAR,…] [--no-placeholders]",
			tr("Brokered API keys are set to __ryu_broker__ so SDKs start"),
			6,
		],
		[
			"--isolation=container (or --container) [--image REF] [--mount SRC:DST[:ro]]…",
			tr("Run it in a Docker container whose only egress is the broker"),
			6,
		],
		"  export [--format dotenv|json|yaml|shell|k8s|csv|toml|hcl|ini] [--name NAME]… [--tags T,…] [--k8s-name N] [--k8s-namespace NS]",
		[
			"snapshot [--out FILE] [--env E] [--path P]",
			tr("Passphrase-sealed export (RYU_VAULT_PASSPHRASE)"),
		],
		"  import FILE [--format dotenv|json|snapshot|doppler|envkey] [--on-conflict skip|overwrite] [--passphrase P]",
	];
}

function scanEntries({ tr }: HelpTranslator): HelpEntry[] {
	return [
		[
			"scan [PATHS…] [--allow FINGERPRINT]",
			tr(
				"Find leaked credentials; exit 1 on findings, 3 if the scan cannot run (Core unreachable, git error)"
			),
		],
		["scan --staged", tr("Scan the staged blobs the next commit would record")],
		[
			"scan --history [REV-RANGE] [--max-commits N]",
			tr("Scan lines added by the newest N commits (default 1000)"),
		],
		[
			"--allow-offline",
			tr(
				"Exit 0 instead of 3 when Core is unreachable (or RYU_SECRETS_SCAN_ALLOW_OFFLINE=1)"
			),
			6,
		],
		[
			"scan install-hook [--force] | scan uninstall-hook",
			tr(
				"Add or remove a git pre-commit hook that runs scan --staged (--force keeps an existing hook and runs it first)"
			),
		],
	];
}

function agentEntries({ tr }: HelpTranslator): HelpEntry[] {
	return [
		"",
		tr(
			"Client agent (machine identity; like the HashiCorp Vault, OpenBao and Infisical agents):"
		),
		[
			"agent --config FILE [--once]",
			tr(
				"Log in and keep the token renewed, write it to sink files, render {{secret:REF}} and {{lease:NAME.FIELD}} templates, render again on vault changes and lease replacement, and run each template's command when its file changed"
			),
		],
		["--once", tr("Render once and exit (no watching or renewal)"), 6],
		"",
		tr("AI coding agents (CLAUDECODE, CURSOR_AGENT, CODEX_*, AGENT set):"),
		{
			prose: tr(
				"get and export show config values only; snapshot, unwrap, share, dynamic issue, items reveal, pm read, machine secret-id, token create, and control-group redeem refuse to print values. run uses --broker with every available service (plus the config values in its env), and refuses commands that print their env."
			),
		},
		["--human", tr("A person at a terminal confirms and lifts the guard once")],
	];
}

/** The full `ryu-cli secrets help` text in the translator's locale. */
export function renderSecretsHelp(
	translator: HelpTranslator = CLI_TRANSLATOR
): string {
	return renderHelpEntries([
		...valueEntries(translator),
		...workflowEntries(translator),
		...scanEntries(translator),
		...agentEntries(translator),
		...adminHelpEntries(translator),
		...machineHelpEntries(translator),
		...devloopHelpEntries(translator),
		...engineHelpEntries(translator),
	]).join("\n");
}

export const SUBCOMMAND_HELP = renderSecretsHelp();
