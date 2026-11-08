// `ryu secrets external …`: external secret stores (OpenBao, HashiCorp Vault,
// Infisical) and secret syncs to GitHub Actions, Vercel, AWS Secrets Manager
// and Google Cloud Secret Manager.
//
// A store is created from a JSON file (or stdin with `-`) so its credentials
// never appear as arguments. Core never returns credentials or values here;
// these commands print connection metadata and sync status only.

import { readFile } from "node:fs/promises";
import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	createVaultExternalDestination,
	createVaultExternalSource,
	createVaultExternalStore,
	deleteVaultExternalDestination,
	deleteVaultExternalSource,
	deleteVaultExternalStore,
	listVaultExternalDestinations,
	listVaultExternalSources,
	listVaultExternalStores,
	pushVaultExternalDestination,
	syncVaultExternalSource,
	testVaultExternalStore,
	type VaultExternalStore,
	type VaultExternalStoreInput,
} from "@ryuhq/core-client/vault-external";
import { tf } from "../i18n/translate.ts";
import { formatTable } from "./output.ts";
import { arg, flag, parseDuration, type SecretsArgs } from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

const USAGE =
	"Usage: ryu-cli secrets external stores | add FILE|- | test STORE | remove STORE | " +
	"syncs | sync STORE --env E [--path P] [--remote R] [--interval 1h] | push ID | unsync ID | " +
	"sources | source STORE --env E [--path P] [--remote R] [--mode live|sync] | pull ID | unsource ID";

type Handler = (ctx: CliContext, args: SecretsArgs) => Promise<number>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a store file. `credentials.serviceAccountKey` may be the key file's
 * object, which is sent as its JSON text. Errors never echo a value.
 */
export function parseStoreFile(
	text: string,
	file: string
): VaultExternalStoreInput {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new UsageError(tf("{file} is not valid JSON.", { file }));
	}
	if (!isRecord(raw)) {
		throw new UsageError(tf("{file} must hold a JSON object.", { file }));
	}
	for (const field of ["name", "kind", "authMethod"]) {
		if (typeof raw[field] !== "string" || raw[field] === "") {
			throw new UsageError(
				tf("{file} is not a valid store: {field} is required.", {
					file,
					field,
				})
			);
		}
	}
	const credentials = isRecord(raw.credentials) ? { ...raw.credentials } : {};
	if (isRecord(credentials.serviceAccountKey)) {
		credentials.serviceAccountKey = JSON.stringify(
			credentials.serviceAccountKey
		);
	}
	for (const [field, value] of Object.entries(credentials)) {
		if (typeof value !== "string") {
			throw new UsageError(
				tf("{file} is not a valid store: credentials.{field} is invalid.", {
					file,
					field,
				})
			);
		}
	}
	return { ...raw, credentials } as unknown as VaultExternalStoreInput;
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** A store by id or name. */
async function resolveStore(
	target: ApiTarget,
	reference: string
): Promise<VaultExternalStore> {
	const { stores } = await listVaultExternalStores(target);
	const store = stores.find(
		(candidate) => candidate.id === reference || candidate.name === reference
	);
	if (!store) {
		throw new UsageError(
			tf("No external store {store}.", { store: reference })
		);
	}
	return store;
}

function folderFlags(args: SecretsArgs, usage: string) {
	const environment = flag(args, "--env");
	if (!environment) {
		throw new UsageError(`Usage: ryu-cli secrets external ${usage}`);
	}
	return {
		environment,
		path: flag(args, "--path") ?? "/",
		remotePath: flag(args, "--remote") ?? "",
	};
}

function status(
	lastStatus: string | null,
	lastError: string | null,
	at: number | null
): string {
	if (at === null) {
		return "pending";
	}
	return lastStatus === "error" ? `error: ${lastError ?? ""}` : "ok";
}

const stores: Handler = async (ctx) => {
	const result = await listVaultExternalStores(ctx.target);
	if (ctx.flags.json) {
		printJson(ctx, result);
		return 0;
	}
	const rows = result.stores.map((store) => [
		store.name,
		store.kind,
		store.authMethod,
		store.repository ?? (store.projectId || store.region || store.address),
		store.id,
	]);
	ctx.io.out(
		`${formatTable(["NAME", "KIND", "AUTH", "TARGET", "ID"], rows)}\n`
	);
	return 0;
};

const add: Handler = async (ctx, args) => {
	const file = arg(args, 2, "external add FILE|-");
	const text = file === "-" ? await readStdin() : await readFile(file, "utf8");
	const { store } = await createVaultExternalStore(
		ctx.target,
		parseStoreFile(text, file)
	);
	if (ctx.flags.json) {
		printJson(ctx, { store });
	} else {
		ctx.io.out(
			`${tf("Added {kind} store {name} ({id}).", { kind: store.kind, name: store.name, id: store.id })}\n`
		);
	}
	return 0;
};

const testStore: Handler = async (ctx, args) => {
	const store = await resolveStore(
		ctx.target,
		arg(args, 2, "external test STORE")
	);
	const result = await testVaultExternalStore(ctx.target, store.id);
	if (ctx.flags.json) {
		printJson(ctx, result);
	} else if (result.ok) {
		ctx.io.out(`${tf("{name} is reachable.", { name: store.name })}\n`);
	} else {
		ctx.io.err(
			`${tf("{name} failed: {error}", { name: store.name, error: result.error ?? "" })}\n`
		);
	}
	return result.ok ? 0 : 1;
};

const removeStore: Handler = async (ctx, args) => {
	const store = await resolveStore(
		ctx.target,
		arg(args, 2, "external remove STORE")
	);
	const result = await deleteVaultExternalStore(ctx.target, store.id);
	if (ctx.flags.json) {
		printJson(ctx, result);
	} else {
		ctx.io.out(`${tf("Removed store {name}.", { name: store.name })}\n`);
	}
	return 0;
};

const syncs: Handler = async (ctx) => {
	const [result, { stores: all }] = await Promise.all([
		listVaultExternalDestinations(ctx.target),
		listVaultExternalStores(ctx.target),
	]);
	if (ctx.flags.json) {
		printJson(ctx, result);
		return 0;
	}
	const names = new Map(all.map((store) => [store.id, store.name]));
	const rows = result.destinations.map((destination) => [
		destination.id,
		`${destination.environment}:${destination.path}`,
		names.get(destination.storeId) ?? destination.storeId,
		destination.remotePath,
		String(destination.lastCount),
		status(
			destination.lastStatus,
			destination.lastError,
			destination.lastPushAt
		),
	]);
	ctx.io.out(
		`${formatTable(["ID", "FOLDER", "STORE", "REMOTE", "KEYS", "STATUS"], rows)}\n`
	);
	return 0;
};

const sync: Handler = async (ctx, args) => {
	const usage = "sync STORE --env E [--path P] [--remote R] [--interval 1h]";
	const store = await resolveStore(ctx.target, arg(args, 2, usage));
	const interval = flag(args, "--interval");
	const { destination } = await createVaultExternalDestination(ctx.target, {
		storeId: store.id,
		...folderFlags(args, usage),
		...(interval === undefined
			? {}
			: { intervalSecs: parseDuration(interval) }),
	});
	if (ctx.flags.json) {
		printJson(ctx, { destination });
	} else {
		ctx.io.out(
			`${tf("Syncing {folder} to {name} ({id}).", {
				folder: `${destination.environment}:${destination.path}`,
				name: store.name,
				id: destination.id,
			})}\n`
		);
	}
	return 0;
};

const push: Handler = async (ctx, args) => {
	const id = arg(args, 2, "external push ID");
	const result = await pushVaultExternalDestination(ctx.target, id);
	if (ctx.flags.json) {
		printJson(ctx, result);
	} else {
		ctx.io.out(
			`${tf("Pushed {count, plural, one {# key} other {# keys}}.", {
				count: result.pushed,
			})}\n`
		);
	}
	return 0;
};

const unsync: Handler = async (ctx, args) => {
	const id = arg(args, 2, "external unsync ID");
	const result = await deleteVaultExternalDestination(ctx.target, id);
	if (ctx.flags.json) {
		printJson(ctx, result);
	} else {
		ctx.io.out(
			`${tf("Stopped sync {id}; remote values were left in place.", { id })}\n`
		);
	}
	return 0;
};

const sources: Handler = async (ctx) => {
	const result = await listVaultExternalSources(ctx.target);
	if (ctx.flags.json) {
		printJson(ctx, result);
		return 0;
	}
	const rows = result.sources.map((source) => [
		source.id,
		`${source.environment}:${source.path}`,
		source.mode,
		source.remotePath,
		status(source.lastStatus, source.lastError, source.lastSyncAt),
	]);
	ctx.io.out(
		`${formatTable(["ID", "FOLDER", "MODE", "REMOTE", "STATUS"], rows)}\n`
	);
	return 0;
};

const source: Handler = async (ctx, args) => {
	const usage =
		"source STORE --env E [--path P] [--remote R] [--mode live|sync]";
	const store = await resolveStore(ctx.target, arg(args, 2, usage));
	const mode = flag(args, "--mode") ?? "live";
	if (mode !== "live" && mode !== "sync") {
		throw new UsageError(`Usage: ryu-cli secrets external ${usage}`);
	}
	const { source: created } = await createVaultExternalSource(ctx.target, {
		storeId: store.id,
		mode,
		...folderFlags(args, usage),
	});
	if (ctx.flags.json) {
		printJson(ctx, { source: created });
	} else {
		ctx.io.out(
			`${tf("Sourcing {folder} from {name} ({id}).", {
				folder: `${created.environment}:${created.path}`,
				name: store.name,
				id: created.id,
			})}\n`
		);
	}
	return 0;
};

const pull: Handler = async (ctx, args) => {
	const id = arg(args, 2, "external pull ID");
	const { report } = await syncVaultExternalSource(ctx.target, id);
	if (ctx.flags.json) {
		printJson(ctx, { report });
	} else {
		ctx.io.out(
			`${tf("Wrote {written}, removed {removed}, unchanged {unchanged}.", { ...report })}\n`
		);
	}
	return 0;
};

const unsource: Handler = async (ctx, args) => {
	const id = arg(args, 2, "external unsource ID");
	const result = await deleteVaultExternalSource(ctx.target, id);
	if (ctx.flags.json) {
		printJson(ctx, result);
	} else {
		ctx.io.out(`${tf("Removed source {id}.", { id })}\n`);
	}
	return 0;
};

const ACTIONS = new Map<string, Handler>([
	["stores", stores],
	["add", add],
	["test", testStore],
	["remove", removeStore],
	["syncs", syncs],
	["destinations", syncs],
	["sync", sync],
	["push", push],
	["unsync", unsync],
	["sources", sources],
	["source", source],
	["pull", pull],
	["unsource", unsource],
]);

export async function external(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const handler = ACTIONS.get(args.positional[1] ?? "stores");
	if (!handler) {
		throw new UsageError(USAGE);
	}
	return await handler(ctx, args);
}
