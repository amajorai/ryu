// Help entries for vault administration, the credential broker, password
// managers, external stores, dynamic secrets and share links, spread into
// `ryu-cli secrets help` (`secrets-help.ts`).

import { CLI_TRANSLATOR, type CliTranslator } from "../i18n/translate.ts";
import type { HelpEntry } from "./secrets-help-format.ts";

type HelpTranslator = Pick<CliTranslator, "tr">;

function administration({ tr }: HelpTranslator): HelpEntry[] {
	return [
		"",
		tr("Administration:"),
		"  env list | env set SLUG [--name N] [--protected|--unprotected] [--approvals N] | env delete SLUG",
		"  policy list | policy set NAME FILE | policy delete NAME",
		"  policy bind POLICY SUBJECT [--expires-at T] | policy unbind BINDING_ID",
		"  approvals list [--status S] | approvals approve ID | approvals reject ID [--reason R]",
		"  audit [--verify] [--limit N] [--name NAME] [--before SEQ]",
		"  audit-device list | audit-device set ID FILE | audit-device delete ID | audit-device hash ID INPUT",
		'      FILE: {"kind": "file"|"syslog"|"socket"|"http", "options": {…}, "hmacFields": true, "enabled": true}',
		"  quota list | quota delete NAME",
		[
			"quota set NAME --rate N [--interval 1m] [--block 5m] [--path auth/]",
			tr("Rate limit per client"),
		],
		[
			"quota set NAME --max-leases N --role GLOB",
			tr("Cap live dynamic-secret leases"),
		],
		"  control-group list | control-group show ID | control-group authorize ID",
		[
			"control-group redeem ID TOKEN",
			tr("Print a value a control group released (single use)"),
		],
		{
			prose: tr(
				"get on a gated value opens a request and exits 3 with the redeem command"
			),
			indent: 6,
		},
		"  status | seal | unseal [SHARE]",
		[
			"lockout list | lockout unlock IDENTITY",
			tr("Machine identities locked after failed logins"),
		],
		"  lockout config [--threshold N] [--window 15m] [--duration 15m] [--enable|--disable]",
		[
			"overrides [status|on|off]",
			tr(
				"Whether your personal values override shared team, organization and project values (on by default)"
			),
		],
	];
}

function broker({ tr }: HelpTranslator): HelpEntry[] {
	return [
		"",
		tr("Credential broker:"),
		"  broker services [--env E] | broker sessions [revoke ID] | broker logs [--service S] [--limit N]",
		"  broker service show NAME [--format yaml|json] | apply FILE [--dry-run] | enable|disable|delete NAME",
		[
			"broker review",
			tr("Walk pending agent proposals: approve, reject, or skip each"),
		],
		"  broker service add --template T [--name N] [--env E] [--credential-ref REF]",
		"  broker proposals [--status S] | broker proposals approve ID [--grant G] | broker proposals reject ID [--reason R]",
		["broker ca", tr("Print the broker CA certificate (PEM)")],
		`  ${tr("Agents (RYU_VAULT_TOKEN, or the broker session the agent runs under):")}`,
		[
			"broker discover [--env E]",
			tr("List the services and placeholders this agent may use"),
		],
		"  broker propose --message WHY [--host H [--name N] [--auth bearer|api_key|passthrough] [--header H]]",
		[
			"[--credential secret:NAME [--instructions TEXT]]…",
			tr("Ask a person for a host or credential"),
			6,
		],
		[
			"broker proposal ID",
			tr("Show a proposal (exit 3 while pending, 1 if rejected)"),
		],
	];
}

function stores({ tr }: HelpTranslator): HelpEntry[] {
	return [
		"",
		tr("Password managers (1Password, Bitwarden Secrets Manager):"),
		"  pm accounts | pm test NAME | pm remove NAME",
		[
			"pm add NAME --provider 1password-connect|1password-service-account|bitwarden-sm [--address URL]",
			tr("Token on stdin, never as an argument"),
		],
		["pm reconnect NAME", tr("Replace the token (stdin)")],
		[
			"pm read REF [--env E]",
			tr("Read op://… or bws://… (exit 3 while approval is pending)"),
		],
		"  pm approvals [--status S] | pm approvals approve ID [--grant once|1h|24h|30d] | pm approvals reject ID",
		"  pm grants [--all] | pm grants revoke ID",
		"",
		tr(
			"External stores and secret syncs (credentials come from FILE or stdin, never arguments):"
		),
		"  external stores | external add FILE|- | external test STORE | external remove STORE",
		'      FILE: {"name": "ci", "kind": "github-actions"|"vercel"|"aws-secrets-manager"|"gcp-secret-manager"|',
		'             "openbao"|"hashicorp-vault"|"infisical", "authMethod": …, "credentials": {…}, …}',
		[
			"external sync STORE --env E [--path P] [--remote PREFIX] [--interval 1h]",
			tr("Push a folder to the store after every write and on an interval"),
		],
		"  external syncs | external push ID | external unsync ID",
		"  external source STORE --env E [--path P] [--remote R] [--mode live|sync]",
		"  external sources | external pull ID | external unsource ID",
	];
}

function dynamicAndShare({ tr }: HelpTranslator): HelpEntry[] {
	return [
		"",
		tr("Dynamic secrets and leases:"),
		"  dynamic roles | dynamic put ROLE FILE | dynamic delete ROLE | dynamic revoke-all ROLE",
		'      FILE: {"provider": {"kind": "postgres", …}, "defaultTtl": "1h", "maxTtl": "24h"}',
		"      kinds: postgres mysql mssql mongodb redis rabbitmq aws-sts aws-iam gcp azure",
		"             kubernetes kubernetes-rules webhook random",
		[
			"dynamic issue ROLE [--ttl 1h]",
			tr("Print a new credential and its lease id"),
		],
		"  lease list [--name ROLE] [--all] | lease renew ID [--increment 1h] | lease revoke ID",
		[
			"lease force-revoke ID --acknowledge-credential-may-be-live",
			tr(
				"Mark a retry lease revoked without revoking it at the provider (configuration manager)"
			),
		],
		"",
		tr("Share and request links (opened in a browser, once):"),
		[
			"share NAME [--label L] [--ttl 1h] | share --wrap-token T",
			tr("Print a one-time link to a value"),
		],
		[
			"share request NAME --label L [--ttl 1h]",
			tr("Print a link that asks someone for NAME's value"),
		],
		[
			"share request-credential SITE --label L [--agent A] [--username U] [--totp] [--submit-url URL]",
			tr("Print a link that asks someone for an agent's sign-in to SITE"),
		],
		"  share list | share claim ID | share revoke ID",
	];
}

/** Administration through share links, described in the translator's locale. */
export function adminHelpEntries(
	translator: HelpTranslator = CLI_TRANSLATOR
): HelpEntry[] {
	return [
		...administration(translator),
		...broker(translator),
		...stores(translator),
		...dynamicAndShare(translator),
	];
}
