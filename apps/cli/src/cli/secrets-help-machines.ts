// Help entries for SSH CAs and identity tokens, TOTP and typed items, payment
// cards, machine identities and machine tokens, spread into
// `ryu-cli secrets help` (`secrets-help.ts`).

import { CLI_TRANSLATOR, type CliTranslator } from "../i18n/translate.ts";
import type { HelpEntry } from "./secrets-help-format.ts";

type HelpTranslator = Pick<CliTranslator, "tr">;

function identityAndItems({ tr }: HelpTranslator): HelpEntry[] {
	return [
		"",
		tr("SSH certificate authorities and identity tokens:"),
		"  ssh cas | ssh ca create NAME [--key-type ed25519|rsa|ecdsa] [--key-bits N]",
		"  ssh roles | ssh role set NAME --ca CA --principal P… [--cert-type user|host] | ssh role delete NAME",
		"  ssh sign ROLE --public-key FILE|- [--principal P…] [--key-id ID] [--ttl T] [--out FILE]",
		"  ssh certs CA | ssh revoke CA --serial N|--key-id ID | ssh krl CA --out FILE",
		"  identity config [--issuer URL] [--algorithm ES256|RS256|EdDSA] [--rotation-period 30d]",
		["identity token ROLE", tr("Print a signed identity JWT for ROLE")],
		[
			"identity verify [TOKEN|-] [--algorithm A] [--audience AUD] [--issuer URL]",
			tr("Check a token against the JWKS; exit 1 when invalid"),
		],
		"",
		tr("TOTP and typed items:"),
		[
			"totp code NAME | totp validate NAME CODE",
			tr("Print a current code; validate exits 1 when invalid"),
		],
		"  items list [--env E] [--path P] | items get KEY | items reveal KEY FIELD | items delete KEY",
		[
			"items put KEY --type T --field name=value[:plain]…",
			tr("(:plain stores a non-sensitive text field)"),
		],
		"",
		tr(
			"Payment cards (number and CVC are read from stdin, never from arguments):"
		),
		'  printf \'%s\\n%s\\n\' "$NUMBER" "$CVC" | ryu-cli secrets items put KEY --type card --cardholder NAME',
		"      --exp MM/YY --merchant HOST… [--postal-code P] [--country CC] [--address-line1 A] [--city C]",
		[
			"cards approvals [--status S] [--env E]",
			tr("List spend approvals (default: pending)"),
		],
		"  cards approvals approve ID [--mode once|grant] [--subject session|agent] [--ttl 15m] [--max-uses N]",
		{
			prose: tr(
				"(once: one use within --ttl; requesters cannot approve their own fill or reveal)"
			),
			indent: 6,
		},
		"  cards approvals reject ID [--reason R] | cards approvals revoke ID [--reason R]",
	];
}

function machineIdentities({ tr }: HelpTranslator): HelpEntry[] {
	return [
		"",
		tr("Machine identities (admin on sys/machines):"),
		"  machine list | machine delete NAME",
		[
			"machine create NAME [AUTH_FILE] [--policy P]… [--ttl 15m]",
			tr("AppRole without AUTH_FILE"),
		],
		'      AUTH_FILE: {"kind": "jwt"|"cert"|"aws-iam"|"kubernetes", …}',
		"  machine update NAME [--policy P]… [--ttl D] [--disable|--enable]",
		"  machine token-config NAME [--max-ttl D] [--explicit-max-ttl D] [--period D] [--uses N] [--cidr C]…",
		[
			"[--renewable|--not-renewable]",
			tr("Replaces the identity's token settings"),
			6,
		],
		"  machine secret-ids NAME | machine revoke-secret-id ACCESSOR",
		[
			"machine secret-id NAME [--ttl D] [--uses N] [--cidr C]…",
			tr("Print a new AppRole secret id once"),
		],
	];
}

function machineTokens({ tr }: HelpTranslator): HelpEntry[] {
	return [
		"",
		tr("Machine tokens:"),
		[
			"login --approle ROLE_ID SECRET_ID | login --jwt IDENTITY JWT",
			tr("Print a vault token"),
		],
		[
			"login --cert IDENTITY --cert-file PEM --key-file PEM",
			tr("Sign a proof with the certificate key"),
		],
		[
			"login --aws IDENTITY --server-id ID [--sts-endpoint URL] [--region R]",
			tr("Sign sts:GetCallerIdentity with AWS_* credentials"),
		],
		[
			"login --k8s IDENTITY [--jwt-file PATH]",
			tr("Service-account token (default: the pod's token)"),
		],
		[
			"login --azure IDENTITY [--resource URI] [--client-id ID]",
			tr("Managed-identity token (JWT auth)"),
		],
		[
			"login --gcp IDENTITY [--audience AUD]",
			tr("Metadata-server identity token (JWT auth)"),
		],
		[
			"login … --no-store -- CMD ARGS…",
			tr("Give the token to CMD only (RYU_VAULT_TOKEN); revoke on exit"),
		],
		"  token list [--identity I] | token revoke ACCESSOR [--orphan]",
		"  token create IDENTITY [--policy P]… [--ttl D] [--role R] [--period D] [--uses N] [--cidr C]…",
		["[--orphan] [--not-renewable]", tr("Print a new token once"), 6],
		"  token roles | token role show NAME | token role set NAME FILE | token role delete NAME",
		["logout", tr("Revoke RYU_VAULT_TOKEN")],
		[
			"token lookup [ACCESSOR] | token renew [ACCESSOR] [--increment 1h]",
			tr("(RYU_VAULT_TOKEN when omitted)"),
		],
		[
			"wrap NAME --ttl 5m",
			tr("Print a single-use wrapping token for one value"),
		],
		["unwrap TOKEN", tr("Print the wrapped value (consumes the token)")],
		{
			prose: tr(
				"With RYU_VAULT_TOKEN set, get/export/run/wrap/totp read node-scoped values with that token."
			),
		},
		{
			prose: tr(
				"HashiCorp Vault/OpenBao clients: VAULT_ADDR=<node URL> VAULT_TOKEN=<token> (the /v1 API)."
			),
		},
	];
}

/** SSH, items, cards and machine sections in the translator's locale. */
export function machineHelpEntries(
	translator: HelpTranslator = CLI_TRANSLATOR
): HelpEntry[] {
	return [
		...identityAndItems(translator),
		...machineIdentities(translator),
		...machineTokens(translator),
	];
}
