// `ryu secrets …` — the Secret Vault developer workflow over Core's
// `/api/vault/*` projection, built on the typed `@ryuhq/core-client/vault`
// module. Every call goes through `ctx.target`, so a test injects a fake
// `target.fetch` (plus `ctx.spawn` / `ctx.readStdin`) and never touches a node.
//
// Values are printed only by the explicit `get`, `export`, and `dynamic issue`
// subcommands (`snapshot` prints them sealed under a passphrase). `run`
// (`secrets-run.ts`) merges them into a child's environment and prints nothing
// about them. A `.ryu-vault.json` from `ryu secrets init` in the working
// directory or a parent supplies the default environment, folder, and tag
// filter (`secrets-project.ts`).
// `run --broker` mints a credential-broker session instead and gives the child
// only the proxy environment, so the child never receives a value. With
// `--isolation=container` the child runs in a Docker container whose only
// egress is the broker (see `vaultIsolation.ts`).
//
// AI agent sessions (`secrets-agent-guard.ts`): when a coding agent's marker
// is set, `get` and `export` show `config` values only and the other
// value-printing subcommands refuse (`secrets-agent-redaction.ts`), `set`
// refuses a metadata-only change to `config`, `rollback` refuses, `run`
// defaults to the broker, and `run` refuses environment dumps, unless a
// person confirms `--human`.
//
// Machine-token mode: when `RYU_VAULT_TOKEN` is set, `get`, `export`, and `run`
// use the token-only `/api/vault/agent/*` routes (node-scoped values the token's
// policies may read) and send no node bearer. `ryu secrets login` exchanges an
// AppRole or OIDC/JWT credential for such a token and prints it.

import {
	deleteVaultItem,
	type PutVaultItemInput,
	putVaultItem,
	revealVaultCardField,
	type VaultItemFieldInput,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import { accessRequests } from "./secrets-access.ts";
import {
	approvals,
	audit,
	environments,
	logout,
	policies,
	sealCommand,
} from "./secrets-admin.ts";
import {
	guardedAgentSession,
	prepareAgentRun,
	printsSecretValues,
	refuseValueOutput,
} from "./secrets-agent-guard.ts";
import { agentExport, agentGet } from "./secrets-agent-redaction.ts";
import { agentCommand } from "./secrets-agentd.ts";
import {
	arg,
	flag,
	parseSecretsArgs,
	type SecretsArgs,
} from "./secrets-args.ts";
import { broker } from "./secrets-broker-admin.ts";
import { cards } from "./secrets-cards.ts";
import { cloud } from "./secrets-cloud.ts";
import { controlGroups } from "./secrets-control-groups.ts";
import { devServer } from "./secrets-dev-server.ts";
import { dynamic, leases } from "./secrets-dynamic.ts";
import { exampleEnv } from "./secrets-example-env.ts";
import { external } from "./secrets-external.ts";
import { SUBCOMMAND_HELP } from "./secrets-help.ts";
import { identity } from "./secrets-identity.ts";
import {
	itemLocation,
	itemsGet,
	itemsList,
	itemsPutCard,
	parseItemField,
	totp,
} from "./secrets-items.ts";
import { lockouts } from "./secrets-lockouts.ts";
import { login } from "./secrets-login.ts";
import { machines } from "./secrets-machines.ts";
import { printJson } from "./secrets-output.ts";
import { overrides } from "./secrets-overrides.ts";
import { pki } from "./secrets-pki.ts";
import { passwordManagers } from "./secrets-pm.ts";
import { applyProjectDefaults, init } from "./secrets-project.ts";
import { rekey } from "./secrets-rekey.ts";
import { runWithSecrets } from "./secrets-run.ts";
import { scan } from "./secrets-scan.ts";
import { share } from "./secrets-share.ts";
import { shell } from "./secrets-shell.ts";
import { ssh } from "./secrets-ssh.ts";
import { auditDevices, quotas } from "./secrets-sys-admin.ts";
import { tokenCommand, unwrap, wrap } from "./secrets-tokens.ts";
import { transit } from "./secrets-transit.ts";
import {
	deleteSecret,
	destroySecret,
	exportSecrets,
	getSecret,
	importSecrets,
	listSecrets,
	listVersions,
	restore,
	rollback,
	setSecret,
	snapshot,
} from "./secrets-values.ts";
import { type CliContext, type Command, UsageError } from "./types.ts";
import { confirmIdentity } from "./vaultStepUp.ts";

export {
	parseDuration,
	parseSecretsArgs,
	type SecretsArgs,
} from "./secrets-args.ts";
export {
	parseCardExpiry,
	parseCardStdin,
	parseItemField,
} from "./secrets-items.ts";
export { PM_PENDING_EXIT } from "./secrets-pm.ts";
export { collectScanFiles, scanBatches } from "./secrets-scan.ts";

const USAGE = "ryu-cli secrets <subcommand> …";

async function itemsPut(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const key = arg(args, 2, "items put KEY --type T --field name=value[:plain]");
	if (flag(args, "--type") === "card") {
		return await itemsPutCard(ctx, args, key);
	}
	const specs = args.values.get("--field") ?? [];
	if (specs.length === 0) {
		throw new UsageError(
			"Usage: ryu secrets items put KEY --type T --field name=value[:plain]…"
		);
	}
	const fields: VaultItemFieldInput[] = [];
	const values: Record<string, string> = {};
	for (const spec of specs) {
		const parsed = parseItemField(spec);
		fields.push(parsed.field);
		if (parsed.value !== "") {
			values[parsed.field.name] = parsed.value;
		}
	}
	const input: PutVaultItemInput = { ...itemLocation(args), fields, values };
	const kind = flag(args, "--type");
	const description = flag(args, "--description");
	if (kind) {
		input.kind = kind;
	}
	if (description !== undefined) {
		input.description = description;
	}
	const { item } = await putVaultItem(ctx.target, key, input);
	if (ctx.flags.json) {
		printJson(ctx, item);
	} else {
		ctx.io.out(
			`${tf("Stored item {key} (version {version}).", { key: item.key, version: String(item.version) })}\n`
		);
	}
	return 0;
}

async function items(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const action = args.positional[1];
	if (action === "list" || action === "ls") {
		return await itemsList(ctx, args);
	}
	if (action === "get") {
		return await itemsGet(ctx, args);
	}
	if (action === "put" || action === "set") {
		return await itemsPut(ctx, args);
	}
	if (action === "reveal") {
		const usage = "items reveal KEY FIELD";
		// A card's number and CVC need a single-use approval per reveal.
		const result = await revealVaultCardField(
			ctx.target,
			arg(args, 2, usage),
			arg(args, 3, usage),
			itemLocation(args)
		);
		if (result.status === "approval_required") {
			if (ctx.flags.json) {
				printJson(ctx, result);
			} else {
				ctx.io.err(
					`${tf("Approval required ({id}). Approve with: ryu secrets cards approvals approve {id}, then run this again.", { id: result.approval.id })}\n`
				);
			}
			return 1;
		}
		if (ctx.flags.json) {
			printJson(ctx, { field: result.field, value: result.value });
		} else {
			ctx.io.out(`${result.value}\n`);
		}
		return 0;
	}
	if (action === "delete" || action === "rm") {
		const key = arg(args, 2, "items delete KEY");
		const result = await deleteVaultItem(ctx.target, key, itemLocation(args));
		if (ctx.flags.json) {
			printJson(ctx, result);
		} else {
			ctx.io.out(
				result.deleted
					? `${tf("Deleted item {key}.", { key })}\n`
					: `${tf("No item {key}.", { key })}\n`
			);
		}
		return 0;
	}
	throw new UsageError(
		"Usage: ryu secrets items list|get KEY|put KEY --type T --field name=value[:plain]|reveal KEY FIELD|delete KEY"
	);
}

// ── Registry ─────────────────────────────────────────────────────────────────

type SecretsHandler = (ctx: CliContext, args: SecretsArgs) => Promise<number>;

const SUBCOMMANDS = new Map<string, SecretsHandler>([
	["access", accessRequests],
	["agent", agentCommand],
	["approvals", approvals],
	["audit", audit],
	["audit-device", auditDevices],
	["audit-devices", auditDevices],
	["broker", broker],
	["cards", cards],
	["cg", controlGroups],
	["cloud", cloud],
	["confirm", confirmIdentity],
	["control-group", controlGroups],
	["control-groups", controlGroups],
	["delete", deleteSecret],
	["destroy", destroySecret],
	["dynamic", dynamic],
	["env", environments],
	["example-env", exampleEnv],
	["export", exportSecrets],
	["external", external],
	["get", getSecret],
	["identity", identity],
	["import", importSecrets],
	["init", init],
	["items", items],
	["lease", leases],
	["leases", leases],
	["list", listSecrets],
	["lockout", lockouts],
	["lockouts", lockouts],
	["login", login],
	["logout", (ctx) => logout(ctx)],
	["ls", listSecrets],
	["machine", machines],
	["machines", machines],
	["overrides", overrides],
	["pki", pki],
	["pm", passwordManagers],
	["policy", policies],
	["quota", quotas],
	["quotas", quotas],
	["rekey", rekey],
	["restore", restore],
	["rm", deleteSecret],
	["rollback", rollback],
	["run", runWithSecrets],
	["scan", scan],
	["shell", shell],
	["seal", sealCommand],
	["set", setSecret],
	["server", devServer],
	["share", share],
	["snapshot", snapshot],
	["ssh", ssh],
	["status", sealCommand],
	["token", tokenCommand],
	["totp", totp],
	["transit", transit],
	["unseal", sealCommand],
	["unwrap", unwrap],
	["versions", listVersions],
	["wrap", wrap],
]);

export const secretsCommand: Command = {
	name: "secrets",
	aliases: ["secret", "vault"],
	summary:
		"Manage Secret Vault values, run commands with them, and scan for leaks",
	usage: "ryu-cli secrets <list|get|set|run|export|import|scan|…>",
	run: async (ctx) => {
		const args = parseSecretsArgs(ctx.rawArgs);
		const subcommand = args.positional[0];
		if (!subcommand || subcommand === "help") {
			ctx.io.out(`${SUBCOMMAND_HELP}\n`);
			return 0;
		}
		const handler = SUBCOMMANDS.get(subcommand);
		if (!handler) {
			throw new UsageError(
				`Unknown subcommand '${subcommand}'. Usage: ${USAGE} (see 'ryu-cli secrets help').`
			);
		}
		await applyProjectDefaults(ctx, args);
		const agentSession = await guardedAgentSession(ctx, args);
		if (agentSession && printsSecretValues(args)) {
			if (subcommand === "get") {
				return await agentGet(ctx, args, agentSession);
			}
			if (subcommand === "export") {
				return await agentExport(ctx, args, agentSession);
			}
			return refuseValueOutput(ctx, agentSession);
		}
		// The client agent writes values to files an AI agent could read.
		if (agentSession && subcommand === "agent") {
			ctx.io.err(
				`${tf("Refusing to start the vault agent in an AI agent session ({marker} is set): it writes secret values to files. A person at a terminal can add --human.", { marker: agentSession })}\n`
			);
			return 1;
		}
		if (agentSession && subcommand === "shell") {
			ctx.io.err(
				`${tf("Refusing to start an interactive shell in an AI agent session ({marker} is set). Run one command with 'ryu-cli secrets run --broker SERVICE -- CMD'. A person at a terminal can add --human.", { marker: agentSession })}\n`
			);
			return 1;
		}
		if (
			agentSession &&
			subcommand === "broker" &&
			args.positional[1] === "review"
		) {
			ctx.io.err(
				`${tf("Refusing to review broker proposals in an AI agent session ({marker} is set): a person decides them. A person at a terminal can add --human.", { marker: agentSession })}\n`
			);
			return 1;
		}
		// Starting or cancelling a rekey discards the share holders' progress.
		if (
			agentSession &&
			subcommand === "rekey" &&
			(args.positional[1] === "init" || args.positional[1] === "cancel")
		) {
			ctx.io.err(
				`${tf("Refusing to start or cancel a rekey in an AI agent session ({marker} is set): the key share holders run it. A person at a terminal can add --human.", { marker: agentSession })}\n`
			);
			return 1;
		}
		if (agentSession && subcommand === "access") {
			return await accessRequests(ctx, args, agentSession);
		}
		if (agentSession && subcommand === "set") {
			return await setSecret(ctx, args, agentSession);
		}
		// Rollback makes an earlier version current under today's type, so a
		// version written as a secret would become readable as config.
		if (agentSession && subcommand === "rollback") {
			ctx.io.err(
				`${tf("Refusing to roll back a value in an AI agent session ({marker} is set): an earlier version may have been written as a secret. A person at a terminal can add --human.", { marker: agentSession })}\n`
			);
			return 1;
		}
		if (agentSession && subcommand === "run") {
			const refused = await prepareAgentRun(ctx, args, agentSession);
			if (refused !== null) {
				return refused;
			}
		}
		return await handler(ctx, args);
	},
};
