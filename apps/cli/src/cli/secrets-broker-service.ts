// `ryu secrets broker service show|apply|add|delete`: read and write
// credential-broker service definitions as YAML or JSON. `show` prints the
// definition without its server timestamps, so its output can be edited and
// applied again. `apply FILE` takes one definition, a list, or
// `{ services: [...] }` and creates or replaces each one by name (`--dry-run`
// only reports what it would do). `add --template T` creates a service from a
// catalog template. `enable`/`disable` flip one service's `enabled` flag.
// A definition names a credential (`credentialRef` or the
// auth block), never holds a value, so nothing here prints a secret.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	createVaultBrokerService,
	deleteVaultBrokerService,
	getVaultBrokerService,
	listVaultBrokerServices,
	putVaultBrokerService,
	type VaultBrokerService,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import { flag, type SecretsArgs } from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

type Definition = Record<string, unknown>;

const SERVICE_USAGE =
	"Usage: ryu-cli secrets broker service show NAME [--format yaml|json] | apply FILE [--dry-run] | add --template T [--name N] [--env E] [--credential-ref REF] | enable|disable|delete NAME";
const SERVER_FIELDS = ["createdAt", "updatedAt"];
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A service as an editable definition: server timestamps removed. */
export function serviceDefinition(service: VaultBrokerService): Definition {
	const definition: Definition = { ...service };
	for (const field of SERVER_FIELDS) {
		delete definition[field];
	}
	return definition;
}

/** YAML (the default) or JSON text for a definition. */
export function renderDefinition(
	definition: Definition,
	format: string | undefined
): string {
	if (format === "json") {
		return `${JSON.stringify(definition, null, 2)}\n`;
	}
	if (format !== undefined && format !== "yaml") {
		throw new UsageError("--format must be yaml or json.");
	}
	const text = Bun.YAML.stringify(definition, null, 2);
	return text.endsWith("\n") ? text : `${text}\n`;
}

function isObject(value: unknown): value is Definition {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The definitions in a file's text (YAML, which includes JSON): one object,
 * a list of objects, or `{ services: [...] }`. Each needs a valid `name`;
 * server timestamps are dropped. Throws a UsageError naming the problem.
 */
export function parseDefinitions(text: string, file: string): Definition[] {
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(text);
	} catch {
		throw new UsageError(tf("{file} is not valid YAML or JSON.", { file }));
	}
	let list: unknown[];
	if (Array.isArray(parsed)) {
		list = parsed;
	} else if (isObject(parsed) && Array.isArray(parsed.services)) {
		list = parsed.services;
	} else {
		list = [parsed];
	}
	if (list.length === 0) {
		throw new UsageError(tf("{file} defines no broker services.", { file }));
	}
	const seen = new Set<string>();
	return list.map((entry, index) => {
		if (!isObject(entry)) {
			throw new UsageError(
				tf("Entry {index} in {file} is not a service definition.", {
					file,
					index: index + 1,
				})
			);
		}
		const name = entry.name;
		if (typeof name !== "string" || !SERVICE_NAME.test(name)) {
			throw new UsageError(
				tf("Entry {index} in {file} needs a valid name.", {
					file,
					index: index + 1,
				})
			);
		}
		if (seen.has(name)) {
			throw new UsageError(
				tf("{file} defines {name} more than once.", { file, name })
			);
		}
		seen.add(name);
		const definition: Definition = { ...entry };
		for (const field of SERVER_FIELDS) {
			delete definition[field];
		}
		return definition;
	});
}

function nameArg(args: SecretsArgs): string {
	const name = args.positional[3];
	if (!name) {
		throw new UsageError(SERVICE_USAGE);
	}
	return name;
}

async function show(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const { service } = await getVaultBrokerService(ctx.target, nameArg(args));
	const definition = serviceDefinition(service);
	if (ctx.flags.json) {
		printJson(ctx, definition);
	} else {
		ctx.io.out(renderDefinition(definition, flag(args, "--format")));
	}
	return 0;
}

async function apply(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const file = nameArg(args);
	const text = await readFile(resolve(ctx.cwd ?? process.cwd(), file), "utf8");
	const definitions = parseDefinitions(text, file);
	const { services } = await listVaultBrokerServices(ctx.target);
	const existing = new Set(services.map((service) => service.name));
	for (const definition of definitions) {
		const name = String(definition.name);
		const update = existing.has(name);
		if (ctx.flags.dryRun) {
			ctx.io.out(
				`${
					update
						? tf("Would update broker service {name}.", { name })
						: tf("Would create broker service {name}.", { name })
				}\n`
			);
			continue;
		}
		const body = definition as Parameters<typeof putVaultBrokerService>[2];
		if (update) {
			await putVaultBrokerService(ctx.target, name, body);
			ctx.io.out(`${tf("Updated broker service {name}.", { name })}\n`);
		} else {
			await createVaultBrokerService(ctx.target, body);
			ctx.io.out(`${tf("Created broker service {name}.", { name })}\n`);
		}
	}
	return 0;
}

async function add(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const template = ctx.flags.template;
	if (!template) {
		throw new UsageError(SERVICE_USAGE);
	}
	const input: Record<string, string> = { template };
	for (const [option, field] of [
		["--name", "name"],
		["--env", "environment"],
		["--credential-ref", "credentialRef"],
	] as const) {
		const value = flag(args, option);
		if (value !== undefined) {
			input[field] = value;
		}
	}
	const { service } = await createVaultBrokerService(ctx.target, input);
	if (ctx.flags.json) {
		printJson(ctx, serviceDefinition(service));
	} else {
		ctx.io.out(
			`${tf("Created broker service {name} from {template}.", { name: service.name, template })}\n`
		);
	}
	return 0;
}

/** `enable NAME` / `disable NAME`: flips `enabled`, keeping the rest. */
async function setEnabled(
	ctx: CliContext,
	args: SecretsArgs,
	enabled: boolean
): Promise<number> {
	const name = nameArg(args);
	const { service } = await getVaultBrokerService(ctx.target, name);
	if (service.enabled === enabled) {
		ctx.io.out(
			`${
				enabled
					? tf("Broker service {name} is already enabled.", { name })
					: tf("Broker service {name} is already disabled.", { name })
			}\n`
		);
		return 0;
	}
	const body = { ...serviceDefinition(service), enabled } as Parameters<
		typeof putVaultBrokerService
	>[2];
	await putVaultBrokerService(ctx.target, name, body);
	ctx.io.out(
		`${
			enabled
				? tf("Enabled broker service {name}.", { name })
				: tf("Disabled broker service {name}: sessions can no longer use it.", {
						name,
					})
		}\n`
	);
	return 0;
}

async function remove(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const name = nameArg(args);
	const { deleted } = await deleteVaultBrokerService(ctx.target, name);
	ctx.io.out(
		`${
			deleted
				? tf("Deleted broker service {name}.", { name })
				: tf("No broker service named {name}.", { name })
		}\n`
	);
	return deleted ? 0 : 1;
}

export function brokerServiceCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	switch (args.positional[2]) {
		case "show":
			return show(ctx, args);
		case "apply":
			return apply(ctx, args);
		case "add":
			return add(ctx, args);
		case "delete":
			return remove(ctx, args);
		case "enable":
			return setEnabled(ctx, args, true);
		case "disable":
			return setEnabled(ctx, args, false);
		default:
			throw new UsageError(SERVICE_USAGE);
	}
}
