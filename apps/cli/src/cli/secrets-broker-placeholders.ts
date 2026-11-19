// Dummy credentials for `ryu secrets run --broker`. Many SDKs refuse to start
// without an API key in the environment even though the broker adds the real
// one on the way out, so each brokered service's variable is set to
// `__ryu_broker__`. Names come from the `secret:NAME` references in the
// services' auth (read from Core when this user may list services), else from
// the catalog service of the same name, plus every `--placeholder NAME`.
// `--no-placeholders` turns this off. A variable the child already gets
// (proxy settings, `config` values) is never replaced.

import {
	listVaultBrokerServices,
	VAULT_BROKER_PLACEHOLDER,
	type VaultBrokerService,
	vaultBrokerCatalogEnvNames,
	vaultBrokerPlaceholderNames,
} from "@ryuhq/core-client/vault";
import { flag, type SecretsArgs } from "./secrets-args.ts";
import { agentTarget } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `--placeholder A,B --placeholder C` → `["A", "B", "C"]`. */
export function explicitPlaceholders(args: SecretsArgs): string[] {
	const names = (args.values.get("--placeholder") ?? [])
		.flatMap((value) => value.split(","))
		.map((name) => name.trim())
		.filter((name) => name !== "");
	for (const name of names) {
		if (!ENV_NAME.test(name)) {
			throw new UsageError(
				`--placeholder ${name} is not an environment variable name.`
			);
		}
	}
	return names;
}

/** Service definitions for services the catalog does not name, or the bare
 *  names when this caller cannot list them (a machine token, or no `read` on
 *  `sys/broker`). Catalog names need no request. */
async function serviceDefinitions(
	ctx: CliContext,
	args: SecretsArgs,
	services: string[]
): Promise<Array<string | VaultBrokerService>> {
	const custom = services.some(
		(name) => vaultBrokerCatalogEnvNames(name).length === 0
	);
	if (!custom || agentTarget(ctx)) {
		return services;
	}
	try {
		const environment = flag(args, "--env");
		const { services: defined } = await listVaultBrokerServices(
			ctx.target,
			environment ? { environment } : {}
		);
		const byName = new Map(defined.map((service) => [service.name, service]));
		return services.map((name) => byName.get(name) ?? name);
	} catch {
		return services;
	}
}

/** Variables to add to a broker run's environment, skipping `taken` names. */
export async function brokerPlaceholderEnv(
	ctx: CliContext,
	args: SecretsArgs,
	services: string[],
	taken: Readonly<Record<string, string>>
): Promise<Record<string, string>> {
	const explicit = explicitPlaceholders(args);
	if (args.booleans.has("--no-placeholders")) {
		if (explicit.length > 0) {
			throw new UsageError("--placeholder conflicts with --no-placeholders.");
		}
		return {};
	}
	const derived = vaultBrokerPlaceholderNames(
		await serviceDefinitions(ctx, args, services)
	);
	const env: Record<string, string> = {};
	for (const name of new Set([...derived, ...explicit])) {
		if (!(name in taken)) {
			env[name] = VAULT_BROKER_PLACEHOLDER;
		}
	}
	return env;
}
