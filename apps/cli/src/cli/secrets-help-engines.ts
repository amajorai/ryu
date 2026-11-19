// Help entries for the secrets engines (`transit`, `pki`), `rekey`, and
// service-account reads of shared values (`cloud`), spread into
// `SUBCOMMAND_HELP` (`secrets-help.ts`).

import { CLI_TRANSLATOR, type CliTranslator } from "../i18n/translate.ts";
import { type HelpEntry, renderHelpEntries } from "./secrets-help-format.ts";

/** The engine help entries, described in the translator's locale. */
export function engineHelpEntries(
	translator: Pick<CliTranslator, "tr"> = CLI_TRANSLATOR
): HelpEntry[] {
	const { tr } = translator;
	return [
		"",
		tr(
			"Transit (encryption as a service; text is UTF-8 unless --base64; pipe secret text in with -):"
		),
		"  transit keys | transit key create NAME [--type T] | key rotate NAME | key delete NAME",
		"  transit encrypt KEY [TEXT|-] | transit decrypt KEY CIPHERTEXT | transit rewrap KEY CIPHERTEXT",
		"  transit sign KEY [TEXT|-] | transit hmac KEY [TEXT|-] | transit datakey KEY",
		[
			"transit verify KEY [TEXT|-] --signature S | --hmac H",
			tr("Exit 1 when invalid"),
		],
		"      --context C --key-version N --associated-data A --signature-algorithm pss|pkcs1v15",
		"",
		tr(
			"Shared values with a service-account key (RYU_SERVICE_ACCOUNT_KEY, no node needed):"
		),
		"  cloud list --org ORG [--env E] | cloud get NAME --org ORG [--env E] [--path P] [--project ID]",
		"",
		tr("PKI (certificate authorities and certificates):"),
		"  pki issuers | pki issuer create NAME --common-name CN [--ttl 3650d]",
		"  pki roles | pki role set NAME --issuer I --domain D… [--ttl T] [--max-ttl T]",
		"      [--allow-ip-sans] [--server] [--client] | pki role delete NAME",
		[
			"pki issue ROLE --common-name CN [--alt-name N…] [--ip-san IP…] [--ttl T] [--key-out FILE]",
			tr("The new private key goes to FILE (0600), or stdout"),
		],
		"  pki sign ROLE --csr FILE|- [--ttl T] | pki certs ISSUER | pki crl ISSUER | pki revoke SERIAL",
		"",
		tr("Rekey (replace the Shamir key shares; admin on sys/rekey):"),
		"  rekey [status] | rekey init [--shares 5] [--threshold 3] | rekey cancel",
		[
			"rekey update [--nonce N] [--out FILE]",
			tr(
				"Submit one current share from stdin; the last one prints the new shares once (or writes FILE, 0600)"
			),
		],
	];
}

export const ENGINE_HELP_LINES = renderHelpEntries(engineHelpEntries());
