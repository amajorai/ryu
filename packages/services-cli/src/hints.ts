// packages/services-cli/src/hints.ts
//
// Hints the CLI prints in place of (or where there is no) SDK hint, for
// errors whose next step is a `ryu-services` command or a server setting
// rather than an SDK method. The SDK's own hint names SDK calls
// (`ryu.passport.runtime.connections`), which a CLI user cannot run.
// `printError` applies them in both human and `--json` output. Hints that
// name only server settings (Mail's RYU_SMTP_* one) live in the SDK's
// `knownServerHint`, so the SDK, the MCP tools and the CLI share them.

import {
	messageWithoutHint,
	type RyuError,
	type RyuService,
} from "@ryuhq/services";
import { isSiteNotFound } from "./commands/sites.ts";

/** A CLI hint and, when it names another page, that page. */
export interface CliHint {
	readonly docs?: string;
	readonly hint: string;
}

function missingVars(error: RyuError): readonly unknown[] {
	const missing = (error.details as { missing?: unknown } | null)?.missing;
	return Array.isArray(missing) ? missing : [];
}

const SCOPED_OPTION =
	/^(?:(?<scope>mail|notify|box|gateway|connect|passport|sites|managedAgents|messaging)\.)?(?<field>apiKey|baseUrl|gatewayKey|runtimeKey|managementKey|organizationId)$/u;

/**
 * The global flag that sets `new Ryu()` option `option` for a command of
 * `service`, null when the option has no flag (organizationId, Passport's
 * runtime grant, Connect's management key), or undefined when `option` is
 * not a constructor option at all. `--api-key` and `--base-url` fill the
 * command's own service (see `buildRyuOptions`); for Mail, `--api-key` fills
 * the gateway or self-hosted key, never the account-wide `ryu_` key.
 */
function flagForOption(
	service: RyuService | null,
	option: string
): "--api-key" | "--base-url" | null | undefined {
	const match = SCOPED_OPTION.exec(option);
	if (!match?.groups) {
		return;
	}
	const { field, scope } = match.groups;
	if (scope === undefined && service === "mail") {
		return null;
	}
	if (field === "baseUrl") {
		return "--base-url";
	}
	if (field === "apiKey" || (field === "gatewayKey" && scope === "mail")) {
		return "--api-key";
	}
	return null;
}

/** The flags for an "a and b" option list, or undefined when it is not one. */
function flagsForList(
	service: RyuService | null,
	list: string
): { flags: string[]; complete: boolean } | undefined {
	const flags: string[] = [];
	let complete = true;
	for (const option of list.split(" and ")) {
		const flag = flagForOption(service, option.trim());
		if (flag === undefined) {
			return;
		}
		if (flag === null) {
			complete = false;
		} else if (!flags.includes(flag)) {
			flags.push(flag);
		}
	}
	return { flags, complete };
}

const FLAG_NOUNS: Readonly<Record<string, string>> = {
	"--api-key": "the key",
	"--base-url": "the URL",
};

/** Options for {@link cliHintText}. */
export interface CliHintTextOptions {
	/**
	 * The command that takes the flags, for output from a command that does
	 * not (`doctor`): "a `ryu-services notify` command" makes the advice
	 * "or pass --api-key to a `ryu-services notify` command".
	 */
	readonly command?: string;
}

/**
 * `hint` with the SDK's `new Ryu()` options ("(or pass notify.apiKey to
 * new Ryu())", "(or box.apiKey)", "or pass passport.apiKey") replaced by the
 * CLI's own `--api-key` / `--base-url` flags, which a shell user can pass.
 * Options with no flag are dropped, so the env var stays the only advice.
 * The SDK's `timeoutMs` option becomes the CLI's `--timeout` flag.
 */
export function cliHintText(
	service: RyuService | null,
	hint: string,
	options: CliHintTextOptions = {}
): string {
	const target = options.command === undefined ? "" : ` to ${options.command}`;
	const on = options.command === undefined ? "" : ` on ${options.command}`;
	const parenthetical = (whole: string, list: string): string => {
		const mapped = flagsForList(service, list);
		if (mapped === undefined) {
			return whole;
		}
		if (mapped.flags.length === 0) {
			return "";
		}
		if (mapped.complete) {
			return ` (or pass ${mapped.flags.join(" and ")}${target})`;
		}
		const nouns = mapped.flags.map((flag) => FLAG_NOUNS[flag]).join(" and ");
		return ` (${mapped.flags.join(" and ")}${on} can stand in for ${nouns})`;
	};
	const inline = (whole: string, list: string): string => {
		const mapped = flagsForList(service, list);
		if (mapped === undefined) {
			return whole;
		}
		return mapped.flags.length === 0
			? ""
			: ` or pass ${mapped.flags.join(" and ")}${target}`;
	};
	return hint
		.replace(/\braise timeoutMs\b/gu, "raise --timeout")
		.replace(
			/ \((?:or )?(?:pass )?(\w+(?:\.\w+)?(?: and \w+(?:\.\w+)?)*)(?: to new Ryu\(\))?\)/gu,
			parenthetical
		)
		.replace(
			/ or pass (\w+(?:\.\w+)?(?: and \w+(?:\.\w+)?)*)(?: to new Ryu\(\))?(?=[.,;]|$)/gu,
			inline
		);
}

/** What {@link mcpHintText} appends when it drops a `new Ryu()` option. */
export const MCP_ENV_ADVICE =
	"In the MCP server entry, set it in env, then restart the server.";

/**
 * `hint` for a tool result of `ryu-services mcp`: the SDK's `new Ryu()`
 * options ("(or box.baseUrl)", "(or pass notify.apiKey to new Ryu())", "or
 * pass apiKey") are dropped, because the person running the server can only
 * change the env block (and args) of its MCP client entry; when one is
 * dropped, {@link MCP_ENV_ADVICE} says where the env var goes. The SDK's
 * `timeoutMs` option becomes the server's `--timeout` flag. Pass
 * `advice: false` for a message whose hint already carries the advice.
 */
export function mcpHintText(
	service: RyuService | null,
	hint: string,
	options: { readonly advice?: boolean } = {}
): string {
	// Marks where an option was dropped, so the advice follows that sentence.
	const mark = "\u0000";
	const drop = (whole: string, list: string): string =>
		flagsForList(service, list) === undefined ? whole : mark;
	const text = hint
		.replace(
			/\braise timeoutMs\b/gu,
			"raise --timeout in the MCP server entry's args"
		)
		.replace(
			/ \((?:or )?(?:pass )?(\w+(?:\.\w+)?(?: and \w+(?:\.\w+)?)*)(?: to new Ryu\(\))?\)/gu,
			drop
		)
		.replace(
			/ or pass (\w+(?:\.\w+)?(?: and \w+(?:\.\w+)?)*)(?: to new Ryu\(\))?(?=[.,;]|$)/gu,
			drop
		);
	const last = text.lastIndexOf(mark);
	const plain = text.replaceAll(mark, "");
	if (last === -1 || options.advice === false) {
		return plain;
	}
	// The advice goes right after the sentence that named the option.
	const at = last - (text.slice(0, last).split(mark).length - 1);
	const stop = plain.slice(at).search(/\.(?:\s|$)/u);
	if (stop === -1) {
		return `${plain.replace(/[\s.]*$/u, "")}. ${MCP_ENV_ADVICE}`;
	}
	const end = at + stop + 1;
	const rest = plain.slice(end).trimStart();
	return [plain.slice(0, end), MCP_ENV_ADVICE, rest].filter(Boolean).join(" ");
}

/**
 * The message the CLI prints for `error`, without its `Hint:` suffix. A
 * configuration error's message is SDK-authored advice ("set RYU_API_KEY or
 * pass apiKey"), so its `new Ryu()` options become CLI flags; a service's
 * own message is printed as the service sent it.
 */
export function cliMessageFor(error: RyuError): string {
	const message = messageWithoutHint(error);
	return error.code === "configuration_error"
		? cliHintText(error.service, message)
		: message;
}

/** The hint the CLI prints for `error`: its own (see {@link cliHint}) or the SDK's in CLI words. */
export function cliHintFor(error: RyuError): CliHint | null {
	const override = cliHint(error);
	if (override !== null) {
		return override;
	}
	if (!error.hint) {
		return null;
	}
	const hint = cliHintText(error.service, error.hint);
	return hint === error.hint ? null : { hint };
}

/** The CLI hint for `error`, or null to keep the SDK's own. */
export function cliHint(error: RyuError): CliHint | null {
	if (
		error.service === "passport" &&
		error.code === "configuration_error" &&
		missingVars(error).includes("RYU_PASSPORT_API_KEY")
	) {
		// `connections list` names both keys when neither is set: either works.
		if (missingVars(error).includes("RYU_PASSPORT_RUNTIME_KEY")) {
			return {
				hint: "Set RYU_PASSPORT_API_KEY (the tenant administration token) to list every connection, or RYU_PASSPORT_RUNTIME_KEY to list the runtime grant's connections.",
			};
		}
		return {
			hint: "This command needs RYU_PASSPORT_API_KEY (the tenant administration token). With only RYU_PASSPORT_RUNTIME_KEY, run `ryu-services passport connections list` to see the runtime grant's connections.",
		};
	}
	// Only a 404 for the Site itself: a deploy that found the Site and then
	// missed the version (`details.step: "deploy"`) is not a wrong id.
	if (
		error.service === "sites" &&
		error.code === "not_found" &&
		isSiteNotFound(error) &&
		!error.hint
	) {
		return {
			hint: "Pass a Site id or slug from `ryu-services sites list`, or create a Site first with `ryu-services sites create --name <name> --slug <slug>`.",
		};
	}
	return null;
}
