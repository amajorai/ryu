// `ryu secrets …` — the Secret Vault developer workflow over Core's
// `/api/vault/*` projection, built on the typed `@ryuhq/core-client/vault`
// module. Every call goes through `ctx.target`, so a test injects a fake
// `target.fetch` (plus `ctx.spawn` / `ctx.readStdin`) and never touches a node.
//
// Values are printed only by the explicit `get` and `export` subcommands. `run`
// merges them into a child's environment and prints nothing about them.
// `run --broker` mints a credential-broker session instead and gives the child
// only the proxy environment, so the child never receives a value. With
// `--isolation=container` the child runs in a Docker container whose only
// egress is the broker (see `vaultIsolation.ts`).
//
// Machine-token mode: when `RYU_VAULT_TOKEN` is set, `get`, `export`, and `run`
// use the token-only `/api/vault/agent/*` routes (node-scoped values the token's
// policies may read) and send no node bearer. `ryu secrets login` exchanges an
// AppRole or OIDC/JWT credential for such a token and prints it.

import { constants } from "node:fs";
import {
	access,
	chmod,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	bindVaultPolicy,
	createVaultBrokerSession,
	createVaultPasswordManagerAccount,
	decideVaultBrokerProposal,
	decideVaultCardApproval,
	decideVaultChangeRequest,
	decideVaultPasswordManagerApproval,
	deleteVaultEnvironment,
	deleteVaultItem,
	deleteVaultPasswordManagerAccount,
	deleteVaultPolicy,
	deleteVaultSecret,
	exportVaultSecrets,
	getVaultBrokerCaPem,
	getVaultItem,
	getVaultStatus,
	getVaultTotpCode,
	importVaultSecrets,
	listVaultAudit,
	listVaultBrokerLogs,
	listVaultBrokerProposals,
	listVaultBrokerServices,
	listVaultBrokerSessions,
	listVaultCardApprovals,
	listVaultChangeRequests,
	listVaultEnvironments,
	listVaultItems,
	listVaultPasswordManagerAccounts,
	listVaultPasswordManagerApprovals,
	listVaultPasswordManagerGrants,
	listVaultPolicies,
	listVaultSecrets,
	listVaultSecretVersions,
	lookupVaultToken,
	type PutVaultItemInput,
	parseVaultJsonExport,
	putVaultCard,
	putVaultEnvironment,
	putVaultItem,
	putVaultPolicy,
	putVaultSecret,
	readVaultPasswordManagerRef,
	renewVaultToken,
	restoreVaultSecret,
	revealVaultCardField,
	revealVaultSecret,
	revokeVaultBrokerSession,
	revokeVaultPasswordManagerGrant,
	rollbackVaultSecret,
	scanForVaultSecrets,
	sealVault,
	setVaultPasswordManagerToken,
	testVaultPasswordManagerAccount,
	unbindVaultPolicy,
	unsealVault,
	type VaultAgentTarget,
	type VaultBrokerProxy,
	type VaultBrokerSessionInput,
	type VaultCardApprovalStatus,
	type VaultCardApproveInput,
	type VaultChangeRequest,
	type VaultCoords,
	type VaultExportFormat,
	type VaultExportInput,
	type VaultExportResult,
	type VaultFinding,
	type VaultImportFormat,
	type VaultItemFieldInput,
	type VaultItemFieldType,
	type VaultItemLocation,
	type VaultMachineTarget,
	type VaultPasswordManagerAccount,
	type VaultPasswordManagerGrantMode,
	type VaultPolicyRule,
	type VaultScanFile,
	type VaultSealStatus,
	type VaultSecretMetadataPatch,
	type VaultTokenInfo,
	type VaultWriteResult,
	validateVaultTotpCode,
	vaultAgentBrokerSession,
	vaultAgentExport,
	vaultAgentLookupSelf,
	vaultAgentRenewSelf,
	vaultAgentRevokeSelf,
	vaultAgentSecret,
	vaultAgentTotpCode,
	vaultAgentTotpValidate,
	vaultAgentWrapSecret,
	vaultAppRoleLogin,
	vaultJwtLogin,
	vaultUnwrap,
	verifyVaultAudit,
	wrapVaultSecret,
} from "@ryuhq/core-client/vault";
import { z } from "zod";
import {
	isPlainHttpLoopback,
	requiresCoreIdentity,
	UnverifiableCoreError,
} from "../core/coreIdentity.ts";
import { accessRefusalHint, sharedRefusalCode } from "../core/native-errors.ts";
import { formatTable, truncate } from "./output.ts";
import { type CliContext, type Command, UsageError } from "./types.ts";
import {
	defaultContainerHost,
	guardSignals,
	IsolationCancelledError,
	prepareContainer,
	runPrepared,
	type SignalGuard,
} from "./vaultIsolation.ts";
import { confirmIdentity, withStepUpHint } from "./vaultStepUp.ts";

const USAGE = "ryu-cli secrets <subcommand> …";

const SUBCOMMAND_HELP = [
	"ryu-cli secrets — manage the Secret Vault on the target Core node.",
	"",
	"Values:",
	"  list [--env E] [--path P]                 List visible values (metadata only)",
	"  get NAME [VERSION]                        Reveal one value (requires read)",
	"  confirm [CODE] [--method totp|backup|password|otp]",
	"                                            Confirm it's you so get/export/run can read shared",
	"                                            team and org values for 10 minutes (password on stdin)",
	"  set NAME [VALUE|-] [metadata flags]       Write a value (stdin when VALUE is - or omitted)",
	"      --description T --tag T (repeatable) --expires-at RFC3339 --rotate-every 30d",
	"  delete NAME                               Soft-delete (restorable)",
	"  versions NAME                             List versions (never values)",
	"  rollback NAME VERSION                     Make an older version current",
	"  restore NAME                              Undo a soft delete",
	"  Coordinates: --scope user|node|team|org --scope-id ID --env E --path /folder",
	"",
	"Developer workflow:",
	"  run [--env E] [--path P] -- CMD ARGS…     Run CMD with values in its environment",
	"  run --broker SVC[,SVC…] [--env E] [--ttl 15m] -- CMD ARGS…",
	"                                            Run CMD through the credential broker (no values in its env)",
	"      --isolation=container (or --container) [--image REF] [--mount SRC:DST[:ro]]…",
	"                                            Run it in a Docker container whose only egress is the broker",
	"  export [--format dotenv|json|yaml|shell|k8s] [--name NAME]… [--k8s-name N] [--k8s-namespace NS]",
	"  import FILE [--format dotenv|json|snapshot] [--on-conflict skip|overwrite] [--passphrase P]",
	"  scan [PATHS…] [--allow FINGERPRINT]       Find leaked credentials; exit 1 on findings",
	"",
	"Administration:",
	"  env list | env set SLUG [--name N] [--protected|--unprotected] [--approvals N] | env delete SLUG",
	"  policy list | policy set NAME FILE | policy delete NAME",
	"  policy bind POLICY SUBJECT [--expires-at T] | policy unbind BINDING_ID",
	"  approvals list [--status S] | approvals approve ID | approvals reject ID [--reason R]",
	"  audit [--verify] [--limit N] [--name NAME] [--before SEQ]",
	"  status | seal | unseal [SHARE]",
	"",
	"Credential broker:",
	"  broker services [--env E] | broker sessions [revoke ID] | broker logs [--service S] [--limit N]",
	"  broker proposals [--status S] | broker proposals approve ID [--grant G] | broker proposals reject ID [--reason R]",
	"  broker ca                                 Print the broker CA certificate (PEM)",
	"",
	"Password managers (1Password, Bitwarden Secrets Manager):",
	"  pm accounts | pm test NAME | pm remove NAME",
	"  pm add NAME --provider 1password-connect|1password-service-account|bitwarden-sm [--address URL]",
	"                                            Token on stdin, never as an argument",
	"  pm reconnect NAME                         Replace the token (stdin)",
	"  pm read REF [--env E]                     Read op://… or bws://… (exit 3 while approval is pending)",
	"  pm approvals [--status S] | pm approvals approve ID [--grant once|1h|24h|30d] | pm approvals reject ID",
	"  pm grants [--all] | pm grants revoke ID",
	"",
	"TOTP and typed items:",
	"  totp code NAME | totp validate NAME CODE  Print a current code; validate exits 1 when invalid",
	"  items list [--env E] [--path P] | items get KEY | items reveal KEY FIELD | items delete KEY",
	"  items put KEY --type T --field name=value[:plain]…   (:plain stores a non-sensitive text field)",
	"",
	"Payment cards (number and CVC are read from stdin, never from arguments):",
	'  printf \'%s\\n%s\\n\' "$NUMBER" "$CVC" | ryu secrets items put KEY --type card --cardholder NAME',
	"      --exp MM/YY --merchant HOST… [--postal-code P] [--country CC] [--address-line1 A] [--city C]",
	"  cards approvals [--status S] [--env E]     List spend approvals (default: pending)",
	"  cards approvals approve ID [--mode once|grant] [--subject session|agent] [--ttl 15m] [--max-uses N]",
	"      (once: one use within --ttl; requesters cannot approve their own fill or reveal)",
	"  cards approvals reject ID [--reason R] | cards approvals revoke ID [--reason R]",
	"",
	"Machine tokens:",
	"  login --approle ROLE_ID SECRET_ID | login --jwt IDENTITY JWT   Print a vault token",
	"  logout                                    Revoke RYU_VAULT_TOKEN",
	"  token lookup [ACCESSOR] | token renew [ACCESSOR] [--increment 1h]   (RYU_VAULT_TOKEN when omitted)",
	"  wrap NAME --ttl 5m                        Print a single-use wrapping token for one value",
	"  unwrap TOKEN                              Print the wrapped value (consumes the token)",
	"  With RYU_VAULT_TOKEN set, get/export/run/wrap/totp read node-scoped values with that token.",
	"  HashiCorp Vault/OpenBao clients: VAULT_ADDR=<node URL> VAULT_TOKEN=<vault token> (the /v1 API).",
].join("\n");

// ── Local flag parsing ───────────────────────────────────────────────────────

/** Global value flags owned by the dispatcher; skipped (with their value) here. */
const GLOBAL_VALUE_FLAGS = new Set([
	"--agent",
	"--kind",
	"--node",
	"--template",
]);

/** Global boolean flags owned by the dispatcher; skipped here. */
const GLOBAL_BOOLEAN_FLAGS = new Set([
	"--json",
	"--force",
	"--cascade",
	"--dry-run",
	"--fix",
	"--include-secrets",
]);

const VALUE_FLAGS = new Set([
	"--address-line1",
	"--address-line2",
	"--address",
	"--allow",
	"--approvals",
	"--before",
	"--broker",
	"--cardholder",
	"--city",
	"--country",
	"--description",
	"--env",
	"--exp",
	"--expires-at",
	"--field",
	"--format",
	"--grant",
	"--image",
	"--increment",
	"--isolation",
	"--k8s-name",
	"--k8s-namespace",
	"--limit",
	"--max-uses",
	"--merchant",
	"--method",
	"--mode",
	"--mount",
	"--name",
	"--on-conflict",
	"--passphrase",
	"--path",
	"--position",
	"--postal-code",
	"--provider",
	"--reason",
	"--region",
	"--rotate-every",
	"--scope",
	"--scope-id",
	"--service",
	"--status",
	"--subject",
	"--tag",
	"--ttl",
	"--type",
]);

const BOOLEAN_FLAGS = new Set([
	"--all",
	"--approle",
	"--container",
	"--jwt",
	"--no-known-values",
	"--protected",
	"--unprotected",
	"--verify",
]);

/** Card secrets are never taken as arguments (visible in `ps` and history). */
const REFUSED_CARD_FLAGS = new Set([
	"--number",
	"--card-number",
	"--pan",
	"--cvc",
	"--cvv",
]);

export interface SecretsArgs {
	booleans: Set<string>;
	/** Tokens after `--`, verbatim (the `run` command line). */
	passthrough: string[] | null;
	positional: string[];
	values: Map<string, string[]>;
}

/** Parse the raw tokens after `secrets`. Unknown flags are usage errors so a
 *  typo can never silently write to the wrong environment. */
export function parseSecretsArgs(raw: string[]): SecretsArgs {
	const parsed: SecretsArgs = {
		booleans: new Set(),
		passthrough: null,
		positional: [],
		values: new Map(),
	};
	for (let index = 0; index < raw.length; index++) {
		const token = raw[index] ?? "";
		if (token === "--") {
			parsed.passthrough = raw.slice(index + 1);
			break;
		}
		if (token === "-" || !token.startsWith("-")) {
			parsed.positional.push(token);
			continue;
		}
		const eq = token.indexOf("=");
		const name = eq === -1 ? token : token.slice(0, eq);
		if (GLOBAL_BOOLEAN_FLAGS.has(name)) {
			continue;
		}
		if (GLOBAL_VALUE_FLAGS.has(name)) {
			index += eq === -1 ? 1 : 0;
			continue;
		}
		if (BOOLEAN_FLAGS.has(name)) {
			parsed.booleans.add(name);
			continue;
		}
		if (REFUSED_CARD_FLAGS.has(name)) {
			throw new UsageError(
				`${name} is not accepted: arguments are visible to other processes and shell history. Pipe the card number and CVC on stdin.`
			);
		}
		if (!VALUE_FLAGS.has(name)) {
			throw new UsageError(`Unknown flag ${name}. Run 'ryu-cli secrets help'.`);
		}
		let value: string | undefined;
		if (eq === -1) {
			value = raw[index + 1];
			index++;
		} else {
			value = token.slice(eq + 1);
		}
		if (value === undefined) {
			throw new UsageError(`Flag ${name} needs a value.`);
		}
		parsed.values.set(name, [...(parsed.values.get(name) ?? []), value]);
	}
	return parsed;
}

function flag(args: SecretsArgs, name: string): string | undefined {
	const values = args.values.get(name);
	return values?.at(-1);
}

function intFlag(args: SecretsArgs, name: string): number | undefined {
	const value = flag(args, name);
	if (value === undefined) {
		return undefined;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed)) {
		throw new UsageError(`${name} must be an integer.`);
	}
	return parsed;
}

function arg(args: SecretsArgs, index: number, usage: string): string {
	const value = args.positional[index];
	if (!value) {
		throw new UsageError(`Usage: ryu-cli secrets ${usage}`);
	}
	return value;
}

const vaultScopeSchema = z.enum(["user", "node", "team", "org"]);

function coordsFrom(args: SecretsArgs): VaultCoords {
	const parsedScope = vaultScopeSchema.safeParse(
		flag(args, "--scope") ?? "user"
	);
	if (!parsedScope.success) {
		throw new UsageError("--scope must be user, node, team, or org.");
	}
	const coords: VaultCoords = { scope: parsedScope.data };
	const scopeId = flag(args, "--scope-id");
	const environment = flag(args, "--env");
	const path = flag(args, "--path");
	if (scopeId) {
		coords.scopeId = scopeId;
	}
	if (environment) {
		coords.environment = environment;
	}
	if (path) {
		coords.path = path;
	}
	return coords;
}

const DURATION = /^(\d+)\s*([smhdw]?)$/;
const DURATION_SECONDS = new Map<string, number>([
	["", 1],
	["s", 1],
	["m", 60],
	["h", 3600],
	["d", 86_400],
	["w", 604_800],
]);

/** `3600`, `90m`, `12h`, `30d`, `2w` → seconds. */
export function parseDuration(value: string): number {
	const match = DURATION.exec(value.trim());
	const amount = Number(match?.[1]);
	const unit = DURATION_SECONDS.get(match?.[2] ?? "x");
	if (!(match && unit && Number.isFinite(amount) && amount > 0)) {
		throw new UsageError(
			`Invalid duration '${value}'. Use seconds or a suffix: 90m, 12h, 30d, 2w.`
		);
	}
	return amount * unit;
}

function rfc3339(value: string, name: string): string {
	const millis = Date.parse(value);
	if (Number.isNaN(millis)) {
		throw new UsageError(`${name} must be an RFC 3339 timestamp.`);
	}
	return new Date(millis).toISOString();
}

function metadataFrom(args: SecretsArgs): VaultSecretMetadataPatch | undefined {
	const metadata: VaultSecretMetadataPatch = {};
	const description = flag(args, "--description");
	const tags = args.values.get("--tag");
	const expiresAt = flag(args, "--expires-at");
	const rotateEvery = flag(args, "--rotate-every");
	if (description !== undefined) {
		metadata.description = description;
	}
	if (tags) {
		metadata.tags = tags;
	}
	if (expiresAt !== undefined) {
		metadata.expiresAt = rfc3339(expiresAt, "--expires-at");
	}
	if (rotateEvery !== undefined) {
		metadata.rotationPeriodSecs = parseDuration(rotateEvery);
	}
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

// ── Output helpers ───────────────────────────────────────────────────────────

function printJson(
	ctx: CliContext,
	value: Parameters<typeof JSON.stringify>[0]
): void {
	ctx.io.out(`${JSON.stringify(value, null, 2)}\n`);
}

function policyKey(environment: string, path: string, name: string): string {
	return path === "/"
		? `${environment}/${name}`
		: `${environment}${path}/${name}`;
}

function describeChangeRequest(request: VaultChangeRequest): string {
	return `Change request ${request.id} created for ${policyKey(
		request.coords.environment,
		request.coords.path,
		request.coords.name
	)}; it needs ${request.requiredApprovals} approval(s).`;
}

function reportWrite(
	ctx: CliContext,
	result: VaultWriteResult,
	done: (version: number) => string
): number {
	if (ctx.flags.json) {
		printJson(ctx, result);
		return 0;
	}
	if (result.changeRequest) {
		ctx.io.out(`${describeChangeRequest(result.changeRequest)}\n`);
		return 0;
	}
	ctx.io.out(`${done(result.secret?.version ?? 0)}\n`);
	return 0;
}

function sealLine(seal: VaultSealStatus): string {
	if (!seal.sealed) {
		return `Unsealed (${seal.mode}, data key v${seal.activeKeyVersion}).`;
	}
	return seal.mode === "shamir"
		? `Sealed (shamir): ${seal.progress}/${seal.threshold} key shares submitted.`
		: "Sealed (auto).";
}

// ── Machine-token mode ───────────────────────────────────────────────────────

/**
 * The node as a machine-credential target. A local plain-HTTP address is only
 * trusted once it proves it holds the node token (`coreIdentity.ts`), and the
 * vault token, AppRole secret or wrapping token rides on that verified
 * connection. Without a node token there is nothing to check it with, so the
 * CLI refuses rather than hand a credential to, or take secret values and a
 * broker CA from, whatever holds the port.
 */
function machineTarget(ctx: CliContext): VaultMachineTarget {
	if (
		isPlainHttpLoopback(ctx.target.url) &&
		!requiresCoreIdentity(ctx.target)
	) {
		throw new UnverifiableCoreError(ctx.target.url);
	}
	// `ctx.target` is built through `withCoreIdentityCheck` (dispatch.ts), so a
	// local target with a node token already verifies before each request.
	const target: VaultMachineTarget = { url: ctx.target.url };
	if (ctx.target.fetch) {
		target.fetch = ctx.target.fetch;
	}
	return target;
}

/** The agent target when `RYU_VAULT_TOKEN` is set, else null (human mode). */
function agentTarget(ctx: CliContext): VaultAgentTarget | null {
	const token = ctx.env.RYU_VAULT_TOKEN?.trim();
	return token ? { ...machineTarget(ctx), vaultToken: token } : null;
}

const EXPORT_FORMATS = new Map<string, VaultExportFormat>([
	["dotenv", "dotenv"],
	["env", "dotenv"],
	["json", "json"],
	["yaml", "yaml"],
	["shell", "shell"],
	["k8s", "k8s-secret"],
	["k8s-secret", "k8s-secret"],
]);

function exportFormat(args: SecretsArgs): VaultExportFormat {
	const raw = flag(args, "--format") ?? "dotenv";
	const format = EXPORT_FORMATS.get(raw);
	if (!format) {
		throw new UsageError("--format must be dotenv, json, yaml, shell, or k8s.");
	}
	return format;
}

async function exportResult(
	ctx: CliContext,
	args: SecretsArgs,
	format: VaultExportFormat
): Promise<VaultExportResult> {
	const location: Pick<VaultExportInput, "environment" | "path"> = {};
	const environment = flag(args, "--env");
	const path = flag(args, "--path");
	if (environment) {
		location.environment = environment;
	}
	if (path) {
		location.path = path;
	}
	const names = args.values.get("--name");
	const agent = agentTarget(ctx);
	if (agent) {
		if (flag(args, "--k8s-name") || flag(args, "--k8s-namespace")) {
			throw new UsageError(
				"--k8s-name/--k8s-namespace are not supported with RYU_VAULT_TOKEN."
			);
		}
		return await vaultAgentExport(agent, { ...location, format, names });
	}
	const result = await withStepUpHint(() =>
		exportVaultSecrets(ctx.target, {
			...location,
			format,
			names,
			k8sName: flag(args, "--k8s-name"),
			k8sNamespace: flag(args, "--k8s-namespace"),
		})
	);
	if (result.sharedError) {
		// An outage or an access refusal leaves the Team and Organization
		// values out; say so on stderr so `export` output and the `run`
		// child's env stay clean.
		ctx.io.err(sharedValuesMissingWarning(result.sharedError));
	}
	return result;
}

/** The stderr warning for an export that left the shared values out. */
function sharedValuesMissingWarning(sharedError: string): string {
	const code = sharedRefusalCode(sharedError);
	if (!code) {
		return `Warning: Team and Organization values are missing because the control plane couldn't be reached (${sharedError}). Only your own and this node's values were used.\n`;
	}
	const hint = accessRefusalHint({ code })?.hint;
	return `Warning: Team and Organization values are missing because the control plane refused this request (${code}).${hint ? ` ${hint}` : ""} Only your own and this node's values were used.\n`;
}

// ── Values ───────────────────────────────────────────────────────────────────

async function listSecrets(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const result = await listVaultSecrets(ctx.target, {
		environment: flag(args, "--env"),
		path: flag(args, "--path"),
	});
	if (ctx.flags.json) {
		printJson(ctx, result);
		return 0;
	}
	if (result.sharedError) {
		ctx.io.err(`Shared values unavailable: ${result.sharedError}\n`);
	}
	if (result.secrets.length === 0) {
		ctx.io.out("No secrets.\n");
		return 0;
	}
	const rows = result.secrets.map((secret) => [
		secret.name,
		secret.environment,
		secret.path,
		secret.scope,
		String(secret.version),
		secret.status,
		truncate(secret.metadata.description, 40),
	]);
	ctx.io.out(
		`${formatTable(["NAME", "ENV", "PATH", "SCOPE", "VERSION", "STATUS", "DESCRIPTION"], rows)}\n`
	);
	return 0;
}

async function getSecret(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const name = arg(args, 1, "get NAME [VERSION]");
	const rawVersion = args.positional[2];
	const version = rawVersion === undefined ? undefined : Number(rawVersion);
	if (version !== undefined && !(Number.isInteger(version) && version > 0)) {
		throw new UsageError("VERSION must be a positive integer.");
	}
	if (version !== undefined && agentTarget(ctx)) {
		throw new UsageError("VERSION is not supported with RYU_VAULT_TOKEN.");
	}
	const agent = agentTarget(ctx);
	let result:
		| Awaited<ReturnType<typeof vaultAgentSecret>>
		| Awaited<ReturnType<typeof revealVaultSecret>>;
	if (agent) {
		result = await vaultAgentSecret(agent, name, {
			environment: flag(args, "--env"),
			path: flag(args, "--path"),
		});
	} else {
		const coords: Parameters<typeof revealVaultSecret>[2] = coordsFrom(args);
		if (version !== undefined) {
			coords.version = version;
		}
		result = await withStepUpHint(() =>
			revealVaultSecret(ctx.target, name, coords)
		);
	}
	if (ctx.flags.json) {
		printJson(ctx, result);
	} else {
		ctx.io.out(`${result.value}\n`);
	}
	return 0;
}

async function readValue(
	ctx: CliContext,
	args: SecretsArgs
): Promise<string | undefined> {
	const given = args.positional[2];
	if (given !== undefined && given !== "-") {
		return given;
	}
	const piped = await ctx.readStdin();
	if (piped === null) {
		if (given === "-") {
			throw new UsageError(
				"'-' reads the value from stdin, but stdin is a terminal. Pipe the value in."
			);
		}
		return undefined;
	}
	// `echo value | ryu secrets set NAME` should not store the trailing newline.
	const value = piped.replace(/\r?\n$/, "");
	// An omitted VALUE with empty non-interactive stdin (CI) is a metadata-only
	// update, not an attempt to store "".
	return given === undefined && value === "" ? undefined : value;
}

async function setSecret(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const name = arg(args, 1, "set NAME [VALUE|-]");
	const metadata = metadataFrom(args);
	const value = await readValue(ctx, args);
	if (value === "") {
		throw new UsageError(
			"Refusing to store an empty value (Core treats it as a delete). Use 'ryu-cli secrets delete'."
		);
	}
	if (value === undefined && !metadata) {
		throw new UsageError(
			"Usage: ryu-cli secrets set NAME [VALUE|-] — pass a value, '-' to read stdin, or metadata flags."
		);
	}
	const input: Parameters<typeof putVaultSecret>[2] = coordsFrom(args);
	if (value !== undefined) {
		input.value = value;
	}
	if (metadata) {
		input.metadata = metadata;
	}
	const result = await putVaultSecret(ctx.target, name, input);
	return reportWrite(
		ctx,
		result,
		(version) => `Set ${name} (version ${version}).`
	);
}

async function deleteSecret(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const name = arg(args, 1, "delete NAME");
	const result = await deleteVaultSecret(ctx.target, name, coordsFrom(args));
	if (ctx.flags.json) {
		printJson(ctx, result);
	} else if (result.changeRequest) {
		ctx.io.out(`${describeChangeRequest(result.changeRequest)}\n`);
	} else {
		ctx.io.out(
			`Deleted ${name} (restore with 'ryu-cli secrets restore ${name}').\n`
		);
	}
	return 0;
}

async function listVersions(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const name = arg(args, 1, "versions NAME");
	const { versions } = await listVaultSecretVersions(
		ctx.target,
		name,
		coordsFrom(args)
	);
	if (ctx.flags.json) {
		printJson(ctx, versions);
		return 0;
	}
	const rows = versions.map((version) => [
		`${version.version}${version.current ? " *" : ""}`,
		String(version.createdAt ?? ""),
		version.createdBy ?? "",
		version.source,
		version.destroyed ? "destroyed" : "",
	]);
	ctx.io.out(
		`${formatTable(["VERSION", "CREATED", "BY", "SOURCE", "STATE"], rows)}\n`
	);
	return 0;
}

async function rollback(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const name = arg(args, 1, "rollback NAME VERSION");
	const version = Number(arg(args, 2, "rollback NAME VERSION"));
	if (!Number.isInteger(version) || version < 1) {
		throw new UsageError("VERSION must be a positive integer.");
	}
	const result = await rollbackVaultSecret(ctx.target, name, {
		...coordsFrom(args),
		version,
	});
	return reportWrite(
		ctx,
		result,
		(current) =>
			`Rolled ${name} back to version ${version} (now version ${current}).`
	);
}

async function restore(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const name = arg(args, 1, "restore NAME");
	const result = await restoreVaultSecret(ctx.target, name, coordsFrom(args));
	return reportWrite(ctx, result, () => `Restored ${name}.`);
}

// ── Developer workflow ───────────────────────────────────────────────────────

const CHILD_RUNTIME_ENV_KEYS = new Set([
	"APPDATA",
	"COLORTERM",
	"COMSPEC",
	"FORCE_COLOR",
	"HOME",
	"HOMEDRIVE",
	"HOMEPATH",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"LOCALAPPDATA",
	"LOGNAME",
	"NODE_EXTRA_CA_CERTS",
	"NO_COLOR",
	"PATH",
	"PATHEXT",
	"PROGRAMDATA",
	"SHELL",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"SYSTEMROOT",
	"TEMP",
	"TERM",
	"TMP",
	"TMPDIR",
	"TZ",
	"USER",
	"USERPROFILE",
	"WINDIR",
]);

/** Network routing the child needs to reach anything from a proxied host.
 *  Forwarded only while the value carries no credential of its own. */
const CHILD_NETWORK_ENV_KEYS = new Set([
	"ALL_PROXY",
	"CURL_CA_BUNDLE",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"NODE_USE_ENV_PROXY",
	"NO_PROXY",
	"REQUESTS_CA_BUNDLE",
]);

/** A proxy URL with userinfo (`http://user:pass@proxy`) is an ambient
 *  credential, so it stays with the CLI rather than reaching the child. */
function carriesUrlCredential(value: string): boolean {
	return /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]*@/i.test(value.trim());
}

function childRuntimeEnvironment(
	environment: Readonly<Record<string, string | undefined>>
): Record<string, string> {
	const runtime: Record<string, string> = {};
	for (const [key, value] of Object.entries(environment)) {
		if (value === undefined) {
			continue;
		}
		const name = key.toUpperCase();
		if (CHILD_RUNTIME_ENV_KEYS.has(name)) {
			runtime[key] = value;
		} else if (
			CHILD_NETWORK_ENV_KEYS.has(name) &&
			!carriesUrlCredential(value)
		) {
			runtime[key] = value;
		}
	}
	return runtime;
}

/** Environment for the trusted host `docker` CLI in container isolation. The
 *  container itself receives only explicit `-e`/`--env-file` values. */
function dockerCliEnvironment(
	environment: Readonly<Record<string, string | undefined>>
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(environment)) {
		// The vault token authenticates this CLI, not Docker or the child.
		if (value !== undefined && key !== "RYU_VAULT_TOKEN") {
			env[key] = value;
		}
	}
	return env;
}

async function runWithSecrets(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const command = args.passthrough ?? [];
	if (command.length === 0) {
		throw new UsageError(
			"Usage: ryu-cli secrets run [--env E] [--path P] [--broker SVC,…] -- CMD ARGS…"
		);
	}
	const container = isolationMode(args) === "container";
	if (
		!container &&
		(args.values.has("--image") || args.values.has("--mount"))
	) {
		throw new UsageError("--image and --mount need --isolation=container.");
	}
	if (args.values.has("--broker")) {
		if (brokerServices(args).length === 0) {
			throw new UsageError("--broker needs at least one service name.");
		}
		// Container mode hands this environment to the host `docker` CLI (which
		// needs DOCKER_* configuration), never to the isolated command. A host
		// child gets only the reviewed runtime allowlist plus the proxy env.
		const baseEnv = container
			? dockerCliEnvironment(ctx.env)
			: childRuntimeEnvironment(ctx.env);
		return await runWithBroker(ctx, args, command, baseEnv, container);
	}
	if (container) {
		throw new UsageError(
			"--isolation=container needs --broker: the container reaches the network only through the credential broker."
		);
	}
	if (flag(args, "--ttl") !== undefined) {
		throw new UsageError("--ttl applies to 'run --broker' only.");
	}
	const values = parseVaultJsonExport(await exportResult(ctx, args, "json"));
	return await ctx.spawn(command, {
		...childRuntimeEnvironment(ctx.env),
		...values,
	});
}

async function exportSecrets(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const result = await exportResult(ctx, args, exportFormat(args));
	if (ctx.flags.json) {
		printJson(ctx, result);
		return 0;
	}
	ctx.io.out(
		result.content.endsWith("\n") ? result.content : `${result.content}\n`
	);
	return 0;
}

const vaultImportFormatSchema = z.enum(["dotenv", "json", "snapshot"]);

function importFormat(
	file: string,
	explicit: string | undefined
): VaultImportFormat {
	const inferred = file.endsWith(".json") ? "json" : "dotenv";
	const format = vaultImportFormatSchema.safeParse(explicit ?? inferred);
	if (!format.success) {
		throw new UsageError("--format must be dotenv, json, or snapshot.");
	}
	return format.data;
}

async function importSecrets(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const file = arg(args, 1, "import FILE [--format dotenv|json|snapshot]");
	const format = importFormat(file, flag(args, "--format"));
	const onConflict = flag(args, "--on-conflict") ?? "skip";
	if (onConflict !== "skip" && onConflict !== "overwrite") {
		throw new UsageError("--on-conflict must be skip or overwrite.");
	}
	const passphrase = flag(args, "--passphrase") ?? ctx.env.RYU_VAULT_PASSPHRASE;
	if (format === "snapshot" && !passphrase) {
		throw new UsageError(
			"A snapshot import needs --passphrase or RYU_VAULT_PASSPHRASE."
		);
	}
	const content = await readFile(file, "utf8");
	const input: Parameters<typeof importVaultSecrets>[1] = {
		...coordsFrom(args),
		format,
		content,
		onConflict,
	};
	if (format === "snapshot" && passphrase) {
		input.passphrase = passphrase;
	}
	const { report } = await importVaultSecrets(ctx.target, input);
	if (ctx.flags.json) {
		printJson(ctx, report);
	} else {
		ctx.io.out(
			`Imported ${file}: ${report.created} created, ${report.updated} updated, ${report.skipped} skipped, ${report.unchanged} unchanged.\n`
		);
	}
	return 0;
}

const SKIP_DIRECTORIES = new Set([".git", "node_modules", "target"]);
const MAX_SCAN_FILE_BYTES = 1024 * 1024;
/** Core accepts 4 MiB per scan request; JSON escaping can inflate content. */
const MAX_SCAN_BATCH_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_BATCH_FILES = 200;
const BINARY_SNIFF_BYTES = 8000;

function isBinary(bytes: Uint8Array): boolean {
	return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** Collect scannable text files under `root` (a file or a directory). */
export async function collectScanFiles(
	root: string,
	cwd: string
): Promise<VaultScanFile[]> {
	const files: VaultScanFile[] = [];
	const visit = async (path: string): Promise<void> => {
		const info = await stat(path);
		if (info.isDirectory()) {
			const entries = await readdir(path, { withFileTypes: true });
			entries.sort((a, b) => a.name.localeCompare(b.name));
			for (const entry of entries) {
				if (entry.isSymbolicLink()) {
					continue;
				}
				if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) {
					continue;
				}
				await visit(join(path, entry.name));
			}
			return;
		}
		if (!info.isFile() || info.size > MAX_SCAN_FILE_BYTES) {
			return;
		}
		const bytes = await readFile(path);
		if (isBinary(bytes)) {
			return;
		}
		files.push({
			path: relative(cwd, path) || path,
			content: new TextDecoder().decode(bytes),
		});
	};
	await visit(root);
	return files;
}

/** Split files into request-sized batches. */
export function scanBatches(files: VaultScanFile[]): VaultScanFile[][] {
	const batches: VaultScanFile[][] = [];
	let current: VaultScanFile[] = [];
	let size = 0;
	for (const file of files) {
		const bytes = file.content.length;
		if (
			current.length > 0 &&
			(size + bytes > MAX_SCAN_BATCH_BYTES ||
				current.length >= MAX_SCAN_BATCH_FILES)
		) {
			batches.push(current);
			current = [];
			size = 0;
		}
		current.push(file);
		size += bytes;
	}
	if (current.length > 0) {
		batches.push(current);
	}
	return batches;
}

function findingLine(finding: VaultFinding): string {
	const where = `${finding.source ?? "<input>"}:${finding.line}:${finding.column}`;
	const leaked = finding.secret ? ` (${finding.secret})` : "";
	return `${where} ${finding.rule} ${finding.preview}${leaked}`;
}

async function scan(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const roots = args.positional.slice(1);
	const cwd = process.cwd();
	const files: VaultScanFile[] = [];
	for (const root of roots.length > 0 ? roots : ["."]) {
		files.push(...(await collectScanFiles(root, cwd)));
	}
	const findings: VaultFinding[] = [];
	for (const batch of scanBatches(files)) {
		const result = await scanForVaultSecrets(ctx.target, {
			files: batch,
			allow: args.values.get("--allow") ?? [],
			knownValues: !args.booleans.has("--no-known-values"),
		});
		findings.push(...result.findings);
	}
	if (ctx.flags.json) {
		printJson(ctx, { files: files.length, findings });
	} else if (findings.length === 0) {
		ctx.io.out(`No secrets found in ${files.length} file(s).\n`);
	} else {
		ctx.io.out(`${findings.map(findingLine).join("\n")}\n`);
		ctx.io.err(
			`${findings.length} finding(s) in ${files.length} file(s). Suppress a reviewed finding with --allow <fingerprint>.\n`
		);
	}
	return findings.length > 0 ? 1 : 0;
}

// ── Administration ───────────────────────────────────────────────────────────

async function environments(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1] ?? "list";
	if (action === "list") {
		const result = await listVaultEnvironments(ctx.target);
		if (ctx.flags.json) {
			printJson(ctx, result);
			return 0;
		}
		const rows = result.environments.map((env) => [
			`${env.slug}${env.slug === result.active ? " *" : ""}`,
			env.name,
			env.protected ? `yes (${env.requiredApprovals})` : "no",
		]);
		ctx.io.out(`${formatTable(["SLUG", "NAME", "PROTECTED"], rows)}\n`);
		return 0;
	}
	const slug = arg(args, 2, `env ${action} SLUG`);
	if (action === "delete") {
		await deleteVaultEnvironment(ctx.target, slug);
		ctx.io.out(`Deleted environment ${slug}.\n`);
		return 0;
	}
	if (action !== "set") {
		throw new UsageError("Usage: ryu-cli secrets env list|set|delete");
	}
	// PUT replaces the record; start from the current one so `env set prod
	// --approvals 2` does not silently unprotect or rename it.
	const { environments: current } = await listVaultEnvironments(ctx.target);
	const existing = current.find((env) => env.slug === slug);
	const protectedFlag = args.booleans.has("--protected")
		? true
		: args.booleans.has("--unprotected")
			? false
			: undefined;
	const { environment } = await putVaultEnvironment(ctx.target, slug, {
		name: flag(args, "--name") ?? existing?.name ?? slug,
		protected: protectedFlag ?? existing?.protected ?? false,
		requiredApprovals:
			intFlag(args, "--approvals") ?? existing?.requiredApprovals ?? 1,
		position: intFlag(args, "--position") ?? existing?.position ?? 0,
	});
	if (ctx.flags.json) {
		printJson(ctx, environment);
	} else {
		ctx.io.out(`Saved environment ${environment.slug}.\n`);
	}
	return 0;
}

const vaultPolicyRuleSchema = z.looseObject({
	path: z.string(),
	capabilities: z.array(
		z.enum(["list", "use", "read", "write", "delete", "admin", "approve"])
	),
	deny: z.boolean().optional(),
}) satisfies z.ZodType<VaultPolicyRule>;
const vaultPolicyFileSchema = z.union([
	z.array(vaultPolicyRuleSchema).transform((rules) => ({ rules })),
	z.object({
		rules: z.array(vaultPolicyRuleSchema),
		description: z.string().optional().catch(undefined),
	}),
]);
type VaultPolicyFile = z.infer<typeof vaultPolicyFileSchema>;
async function readPolicyFile(file: string): Promise<VaultPolicyFile> {
	let parsed: ReturnType<typeof vaultPolicyFileSchema.safeParse>;
	try {
		parsed = vaultPolicyFileSchema.safeParse(
			JSON.parse(await readFile(file, "utf8"))
		);
	} catch (error) {
		throw new UsageError(
			`Policy file ${file} must be JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (!parsed.success) {
		throw new UsageError(
			`Policy file ${file} must be {"rules": [...]} or a valid rules array.`
		);
	}
	return parsed.data;
}

async function policies(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const action = args.positional[1] ?? "list";
	if (action === "list") {
		const result = await listVaultPolicies(ctx.target);
		if (ctx.flags.json) {
			printJson(ctx, result);
			return 0;
		}
		const policyRows = result.policies.map((policy) => [
			policy.name,
			String(policy.rules.length),
			truncate(policy.description, 50),
		]);
		const bindingRows = result.bindings.map((binding) => [
			binding.id,
			binding.policy,
			binding.subject,
			String(binding.expiresAt ?? ""),
		]);
		ctx.io.out(
			`${formatTable(["POLICY", "RULES", "DESCRIPTION"], policyRows)}\n\n${formatTable(["BINDING", "POLICY", "SUBJECT", "EXPIRES"], bindingRows)}\n`
		);
		return 0;
	}
	if (action === "set") {
		const name = arg(args, 2, "policy set NAME FILE");
		const body = await readPolicyFile(arg(args, 3, "policy set NAME FILE"));
		await putVaultPolicy(ctx.target, name, body);
		ctx.io.out(`Saved policy ${name}.\n`);
		return 0;
	}
	if (action === "delete") {
		const name = arg(args, 2, "policy delete NAME");
		await deleteVaultPolicy(ctx.target, name);
		ctx.io.out(`Deleted policy ${name}.\n`);
		return 0;
	}
	if (action === "bind") {
		const policy = arg(args, 2, "policy bind POLICY SUBJECT [--expires-at T]");
		const subject = arg(args, 3, "policy bind POLICY SUBJECT [--expires-at T]");
		const expiresAt = flag(args, "--expires-at");
		const input: Parameters<typeof bindVaultPolicy>[1] = { policy, subject };
		if (expiresAt) {
			input.expiresAt = rfc3339(expiresAt, "--expires-at");
		}
		const { binding } = await bindVaultPolicy(ctx.target, input);
		if (ctx.flags.json) {
			printJson(ctx, binding);
		} else {
			ctx.io.out(`Bound ${policy} to ${subject} (binding ${binding.id}).\n`);
		}
		return 0;
	}
	if (action === "unbind") {
		const id = arg(args, 2, "policy unbind BINDING_ID");
		await unbindVaultPolicy(ctx.target, id);
		ctx.io.out(`Removed binding ${id}.\n`);
		return 0;
	}
	throw new UsageError(
		"Usage: ryu-cli secrets policy list|set|delete|bind|unbind"
	);
}

const vaultChangeStatusSchema = z.enum([
	"pending",
	"applied",
	"rejected",
	"canceled",
]);

async function approvals(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const action = args.positional[1] ?? "list";
	if (action === "list") {
		const status = vaultChangeStatusSchema.safeParse(
			flag(args, "--status") ?? "pending"
		);
		if (!status.success) {
			throw new UsageError(
				"--status must be pending, applied, rejected, or canceled."
			);
		}
		const { changeRequests } = await listVaultChangeRequests(
			ctx.target,
			status.data
		);
		if (ctx.flags.json) {
			printJson(ctx, changeRequests);
			return 0;
		}
		if (changeRequests.length === 0) {
			ctx.io.out(`No ${status} change requests.\n`);
			return 0;
		}
		const rows = changeRequests.map((request) => [
			request.id,
			request.status,
			request.operation,
			policyKey(
				request.coords.environment,
				request.coords.path,
				request.coords.name
			),
			`${request.approvals.length}/${request.requiredApprovals}`,
			request.requestedBy,
		]);
		ctx.io.out(
			`${formatTable(["ID", "STATUS", "OP", "KEY", "APPROVALS", "REQUESTED BY"], rows)}\n`
		);
		return 0;
	}
	if (action !== "approve" && action !== "reject") {
		throw new UsageError(
			"Usage: ryu-cli secrets approvals list|approve ID|reject ID"
		);
	}
	const id = arg(args, 2, `approvals ${action} ID`);
	const { changeRequest } = await decideVaultChangeRequest(
		ctx.target,
		id,
		action,
		flag(args, "--reason")
	);
	if (ctx.flags.json) {
		printJson(ctx, changeRequest);
	} else {
		ctx.io.out(`Change request ${id} is now ${changeRequest.status}.\n`);
	}
	return 0;
}

async function audit(ctx: CliContext, args: SecretsArgs): Promise<number> {
	if (args.booleans.has("--verify")) {
		const { report } = await verifyVaultAudit(ctx.target);
		if (ctx.flags.json) {
			printJson(ctx, report);
		} else if (report.ok) {
			ctx.io.out(`Audit chain intact (${report.rows} rows).\n`);
		} else {
			ctx.io.out(
				`Audit chain BROKEN at seq ${report.firstBadSeq ?? "?"} (${report.rows} rows checked).\n`
			);
		}
		return report.ok ? 0 : 1;
	}
	const result = await listVaultAudit(ctx.target, {
		limit: intFlag(args, "--limit"),
		before: intFlag(args, "--before"),
		name: flag(args, "--name"),
		environment: flag(args, "--env"),
	});
	if (ctx.flags.json) {
		printJson(ctx, result);
		return 0;
	}
	const rows = result.events.map((event) => [
		String(event.seq),
		event.at,
		`${event.actor.kind}${event.actor.id ? `:${event.actor.id}` : ""}`,
		event.action,
		event.outcome,
		event.name
			? policyKey(event.environment ?? "?", event.path ?? "/", event.name)
			: "",
	]);
	ctx.io.out(
		`${formatTable(["SEQ", "AT", "ACTOR", "ACTION", "OUTCOME", "KEY"], rows)}\n`
	);
	if (result.nextBefore !== null && result.events.length > 0) {
		ctx.io.out(`More: ryu-cli secrets audit --before ${result.nextBefore}\n`);
	}
	return 0;
}

async function sealCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[0];
	if (action === "status") {
		const status = await getVaultStatus(ctx.target);
		if (ctx.flags.json) {
			printJson(ctx, status);
		} else {
			ctx.io.out(
				`${sealLine(status.seal)}\nActive environment: ${status.activeEnvironment}\nShared values: ${status.sharedRemote ? "control plane" : "local"}\n`
			);
		}
		return 0;
	}
	const { seal } =
		action === "seal"
			? await sealVault(ctx.target)
			: await unsealVault(ctx.target, args.positional[1]);
	if (ctx.flags.json) {
		printJson(ctx, seal);
	} else {
		ctx.io.out(`${sealLine(seal)}\n`);
	}
	return 0;
}

// ── Machine login ────────────────────────────────────────────────────────────

async function login(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const target = machineTarget(ctx);
	let result: Awaited<ReturnType<typeof vaultAppRoleLogin>>;
	if (args.booleans.has("--approle")) {
		result = await vaultAppRoleLogin(target, {
			roleId: arg(args, 1, "login --approle ROLE_ID SECRET_ID"),
			secretId: arg(args, 2, "login --approle ROLE_ID SECRET_ID"),
		});
	} else if (args.booleans.has("--jwt")) {
		result = await vaultJwtLogin(target, {
			identity: arg(args, 1, "login --jwt IDENTITY JWT"),
			jwt: arg(args, 2, "login --jwt IDENTITY JWT"),
		});
	} else {
		throw new UsageError(
			"Usage: ryu-cli secrets login --approle ROLE_ID SECRET_ID | --jwt IDENTITY JWT"
		);
	}
	if (ctx.flags.json) {
		printJson(ctx, result.token);
	} else {
		ctx.io.out(`${result.token.token}\n`);
		ctx.io.err(
			`Vault token for ${result.token.identityId} expires ${result.token.expiresAt}. Export it as RYU_VAULT_TOKEN.\n`
		);
		ctx.io.err(
			`Vault/OpenBao CLIs work too (Ryu serves the /v1 API): export VAULT_ADDR=${ctx.target.url.replace(/\/+$/, "")} VAULT_TOKEN=<this token>\n`
		);
	}
	return 0;
}

async function logout(ctx: CliContext): Promise<number> {
	const agent = agentTarget(ctx);
	if (!agent) {
		throw new UsageError("RYU_VAULT_TOKEN is not set; nothing to revoke.");
	}
	await vaultAgentRevokeSelf(agent);
	ctx.io.out("Revoked RYU_VAULT_TOKEN.\n");
	return 0;
}

// ── Credential broker ────────────────────────────────────────────────────────

/** `--isolation host|container`, with `--container` as an alias. */
function isolationMode(args: SecretsArgs): "host" | "container" {
	const value = flag(args, "--isolation");
	if (value !== undefined && value !== "host" && value !== "container") {
		throw new UsageError("--isolation must be 'host' or 'container'.");
	}
	if (args.booleans.has("--container")) {
		if (value === "host") {
			throw new UsageError("--container conflicts with --isolation=host.");
		}
		return "container";
	}
	return value ?? "host";
}

/** The broker CA PEM: Core's file when this user can read it, else the
 *  public certificate from the node. */
async function brokerCaPem(
	ctx: CliContext,
	proxy: VaultBrokerProxy
): Promise<string> {
	if (proxy.caPath && (await isReadableFile(proxy.caPath))) {
		return await readFile(proxy.caPath, "utf8");
	}
	return await getVaultBrokerCaPem(machineTarget(ctx));
}

/** `--broker a,b --broker c` → `["a", "b", "c"]`. */
function brokerServices(args: SecretsArgs): string[] {
	return (args.values.get("--broker") ?? [])
		.flatMap((value) => value.split(","))
		.map((name) => name.trim())
		.filter((name) => name !== "");
}

/** Where a host trust store usually lives; the broker CA is appended to it. */
const SYSTEM_CA_BUNDLES = [
	"/etc/ssl/certs/ca-certificates.crt",
	"/etc/pki/tls/certs/ca-bundle.crt",
	"/etc/ssl/cert.pem",
];

async function isReadableFile(path: string): Promise<boolean> {
	try {
		if (!(await stat(path)).isFile()) {
			return false;
		}
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/** True for `localhost`, `127.0.0.0/8`, and `::1` host names. */
function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "::1" ||
		/^127(?:\.\d{1,3}){3}$/.test(host)
	);
}

function urlHostname(value: string | undefined): string | null {
	if (!value) {
		return null;
	}
	try {
		return new URL(value).hostname;
	} catch {
		return null;
	}
}

/** Core renders the proxy URL on its own loopback interface. When this CLI
 *  talks to a node on another host, that URL would point at this machine
 *  instead, and the child would send the session token to whatever listens
 *  there. Returns true when the proxy is reachable from this host. */
function brokerProxyReachable(
	ctx: CliContext,
	proxy: VaultBrokerProxy
): boolean {
	const proxyHost =
		urlHostname(proxy.url) ??
		urlHostname(proxy.env.HTTPS_PROXY ?? proxy.env.https_proxy);
	if (proxyHost === null || !isLoopbackHost(proxyHost)) {
		return true;
	}
	const targetHost = urlHostname(ctx.target.url);
	return targetHost !== null && isLoopbackHost(targetHost);
}

async function systemCaBundle(): Promise<string> {
	for (const path of SYSTEM_CA_BUNDLES) {
		try {
			return await readFile(path, "utf8");
		} catch {
			// Try the next conventional location.
		}
	}
	return "";
}

interface BrokerCaFiles {
	/** Removes the temporary directory, if one was written. */
	cleanup: () => Promise<void>;
	/** Replacements for CA paths Core reported but this user cannot read. */
	replacements: Map<string, string>;
}

/** Core writes the CA files on its own host, which is this host (see
 *  `brokerProxyReachable`). When Core runs as another user and those paths are
 *  not readable, fetch the public PEM and write the CA-only and the combined
 *  bundle to a private temporary directory (0700, files 0600). */
async function localBrokerCa(
	ctx: CliContext,
	proxy: VaultBrokerProxy
): Promise<BrokerCaFiles> {
	const replacements = new Map<string, string>();
	const missing: string[] = [];
	for (const path of [proxy.caPath, proxy.caBundlePath]) {
		if (path && !(await isReadableFile(path))) {
			missing.push(path);
		}
	}
	if (missing.length === 0) {
		return { cleanup: () => Promise.resolve(), replacements };
	}
	const pem = await getVaultBrokerCaPem(machineTarget(ctx));
	const dir = await mkdtemp(join(tmpdir(), "ryu-broker-"));
	await chmod(dir, 0o700);
	const caOnly = join(dir, "ca.pem");
	const combined = join(dir, "ca-bundle.pem");
	const system = await systemCaBundle();
	await writeFile(caOnly, pem, { mode: 0o600 });
	await writeFile(combined, system ? `${system.trimEnd()}\n${pem}` : pem, {
		mode: 0o600,
	});
	if (proxy.caPath) {
		replacements.set(proxy.caPath, caOnly);
	}
	if (proxy.caBundlePath) {
		replacements.set(proxy.caBundlePath, combined);
	}
	return {
		cleanup: () => rm(dir, { recursive: true, force: true }),
		replacements,
	};
}

type BrokerGrant = Awaited<ReturnType<typeof createVaultBrokerSession>>;

/** Mints the broker session, checks that its proxy is usable from here, runs
 *  `body`, and always revokes a human-minted session afterwards. */
async function withBrokerSession(
	ctx: CliContext,
	args: SecretsArgs,
	command: string[],
	body: (grant: BrokerGrant, proxy: VaultBrokerProxy) => Promise<number>
): Promise<number> {
	const input: VaultBrokerSessionInput = {
		services: brokerServices(args),
		label: `ryu secrets run ${command[0] ?? ""}`.trim(),
	};
	const environment = flag(args, "--env");
	const ttl = flag(args, "--ttl");
	if (environment) {
		input.environment = environment;
	}
	if (ttl !== undefined) {
		input.ttlSecs = parseDuration(ttl);
	}
	const agent = agentTarget(ctx);
	const grant = agent
		? await vaultAgentBrokerSession(agent, input)
		: await createVaultBrokerSession(ctx.target, input);
	try {
		const { proxy } = grant;
		if (!proxy) {
			ctx.io.err(
				"The credential broker is not listening on this node, so no proxy environment is available.\n"
			);
			return 1;
		}
		if (!brokerProxyReachable(ctx, proxy)) {
			ctx.io.err(
				"The broker proxy listens only on the node's loopback interface, so it is not reachable from this host.\n" +
					"Run this command on the node, or tunnel the proxy port (for example `ssh -L`) and target the node through that tunnel.\n"
			);
			return 1;
		}
		return await body(grant, proxy);
	} finally {
		// The revoke route is human-only; a machine-minted session ends with
		// its TTL or its token.
		if (!agent) {
			try {
				await revokeVaultBrokerSession(ctx.target, grant.session.id);
			} catch {
				ctx.io.err(
					`Could not revoke broker session ${grant.session.id}; it expires at ${grant.session.expiresAt}.\n`
				);
			}
		}
	}
}

/** `run --broker`: the child reaches the named services through the broker
 *  proxy and never receives a credential value or the session token in
 *  anything but the proxy URL Core rendered for it. */
async function runWithBroker(
	ctx: CliContext,
	args: SecretsArgs,
	command: string[],
	baseEnv: Record<string, string>,
	container: boolean
): Promise<number> {
	if (container) {
		return await runWithBrokerInContainer(ctx, args, command, baseEnv);
	}
	// Installed before minting, so a signal at any point unwinds through the
	// `finally` blocks below (CA cleanup, session revoke) instead of the
	// default action killing the CLI with the session still live.
	const guard = guardSignals(ctx.containerHost ?? defaultContainerHost());
	try {
		return await withBrokerSession(
			ctx,
			args,
			command,
			async (_grant, proxy) => {
				guard.throwIfCancelled();
				const ca = await localBrokerCa(ctx, proxy);
				const env = { ...baseEnv };
				for (const [key, value] of Object.entries(proxy.env)) {
					env[key] = ca.replacements.get(value) ?? value;
				}
				try {
					guard.throwIfCancelled();
					return await spawnUntilStopped(ctx, guard, command, env);
				} finally {
					await ca.cleanup();
				}
			}
		);
	} catch (error) {
		if (error instanceof IsolationCancelledError) {
			ctx.io.err(`ryu: stopped by ${error.signal}.\n`);
			return error.exitCode;
		}
		throw error;
	} finally {
		guard.dispose();
	}
}

/** Runs the host-mode child under `guard`. Ctrl-C reaches the child through
 *  the terminal (same process group), so the CLI waits for its exit code.
 *  The runner exposes no child handle to pass SIGTERM/SIGHUP on, so on those
 *  the CLI stops waiting and unwinds, which revokes the session. */
async function spawnUntilStopped(
	ctx: CliContext,
	guard: SignalGuard,
	command: string[],
	env: Record<string, string>
): Promise<number> {
	const stopped = new Promise<never>((_resolve, reject) => {
		guard.forwardTo((signal) => {
			if (signal !== "SIGINT") {
				reject(new IsolationCancelledError(signal));
			}
		});
	});
	try {
		return await Promise.race([ctx.spawn(command, env), stopped]);
	} finally {
		guard.forwardTo(null);
	}
}

/** `run --broker --isolation=container`. Docker checks, path validation, and
 *  images come first, so a run that cannot start mints no session. A signal
 *  at any point before the command starts cancels setup, tears down what was
 *  created, revokes the session, and exits 128 + the signal number. */
async function runWithBrokerInContainer(
	ctx: CliContext,
	args: SecretsArgs,
	command: string[],
	baseEnv: Record<string, string>
): Promise<number> {
	const host = ctx.containerHost ?? defaultContainerHost();
	const guard = guardSignals(host);
	const containerCtx = { err: ctx.io.err, guard, host };
	try {
		const prepared = await prepareContainer(containerCtx, {
			env: ctx.env,
			image: flag(args, "--image"),
			mounts: args.values.get("--mount") ?? [],
		});
		return await withBrokerSession(ctx, args, command, async (grant, proxy) => {
			guard.throwIfCancelled();
			return await runPrepared(
				{ ...containerCtx, spawn: ctx.spawn },
				prepared,
				{
					brokerPort: proxy.port,
					caPem: await brokerCaPem(ctx, proxy),
					command,
					dockerEnv: baseEnv,
					expiresAt: grant.session.expiresAt,
					token: grant.token,
				}
			);
		});
	} catch (error) {
		if (error instanceof IsolationCancelledError) {
			ctx.io.err(`ryu: ${error.message}; the container setup was removed.\n`);
			return error.exitCode;
		}
		throw error;
	} finally {
		guard.dispose();
	}
}

async function brokerServicesCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const { services } = await listVaultBrokerServices(ctx.target, {
		environment: flag(args, "--env"),
	});
	if (ctx.flags.json) {
		printJson(ctx, services);
		return 0;
	}
	if (services.length === 0) {
		ctx.io.out("No broker services.\n");
		return 0;
	}
	const rows = services.map((service) => [
		service.name,
		service.environment,
		`${service.host}${service.port ? `:${service.port}` : ""}${service.pathPrefix === "/" ? "" : service.pathPrefix}`,
		service.enabled ? "enabled" : "disabled",
		truncate(service.description ?? "", 40),
	]);
	ctx.io.out(
		`${formatTable(["NAME", "ENV", "UPSTREAM", "STATE", "DESCRIPTION"], rows)}\n`
	);
	return 0;
}

async function brokerSessionsCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	if (args.positional[2] === "revoke") {
		const id = arg(args, 3, "broker sessions revoke ID");
		const result = await revokeVaultBrokerSession(ctx.target, id);
		if (ctx.flags.json) {
			printJson(ctx, result);
		} else {
			ctx.io.out(
				result.revoked ? `Revoked ${id}.\n` : `${id} was already revoked.\n`
			);
		}
		return 0;
	}
	const { sessions } = await listVaultBrokerSessions(ctx.target);
	if (ctx.flags.json) {
		printJson(ctx, sessions);
		return 0;
	}
	if (sessions.length === 0) {
		ctx.io.out("No live broker sessions.\n");
		return 0;
	}
	const rows = sessions.map((session) => [
		session.id,
		session.environment,
		session.services.join(","),
		session.mintedBy,
		String(session.expiresAt),
		truncate(session.label, 30),
	]);
	ctx.io.out(
		`${formatTable(["ID", "ENV", "SERVICES", "BY", "EXPIRES", "LABEL"], rows)}\n`
	);
	return 0;
}

async function brokerLogsCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const { logs } = await listVaultBrokerLogs(ctx.target, {
		environment: flag(args, "--env"),
		service: flag(args, "--service"),
		limit: intFlag(args, "--limit"),
		before: intFlag(args, "--before"),
	});
	if (ctx.flags.json) {
		printJson(ctx, logs);
		return 0;
	}
	if (logs.length === 0) {
		ctx.io.out("No brokered requests.\n");
		return 0;
	}
	const rows = logs.map((row) => [
		String(row.id),
		String(row.at),
		row.service ?? "-",
		row.method,
		truncate(`${row.host}${row.path}`, 50),
		String(row.status),
		row.outcome,
	]);
	ctx.io.out(
		`${formatTable(["ID", "AT", "SERVICE", "METHOD", "URL", "STATUS", "OUTCOME"], rows)}\n`
	);
	return 0;
}

const brokerProposalStatusSchema = z.enum([
	"pending",
	"approved",
	"rejected",
	"expired",
]);

async function brokerProposalsCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[2];
	if (action === "approve" || action === "reject") {
		const id = arg(args, 3, `broker proposals ${action} ID [--reason R]`);
		const note = flag(args, "--reason");
		const grant = grantFlag(args);
		const result = await decideVaultBrokerProposal(ctx.target, id, action, {
			...(note ? { note } : {}),
			...(grant ? { grant } : {}),
		});
		if (ctx.flags.json) {
			printJson(ctx, result);
		} else {
			ctx.io.out(
				`${action === "approve" ? "Approved" : "Rejected"} proposal ${id}.\n`
			);
		}
		return 0;
	}
	if (action !== undefined && action !== "list") {
		throw new UsageError(
			"Usage: ryu secrets broker proposals [list [--status S] | approve ID | reject ID [--reason R]]"
		);
	}
	const status = brokerProposalStatusSchema.safeParse(
		flag(args, "--status") ?? "pending"
	);
	if (!status.success) {
		throw new UsageError(
			"--status must be pending, approved, rejected, or expired."
		);
	}
	const { proposals } = await listVaultBrokerProposals(ctx.target, {
		status: status.data,
	});
	if (ctx.flags.json) {
		printJson(ctx, proposals);
		return 0;
	}
	if (proposals.length === 0) {
		ctx.io.out(`No ${status.data} proposals.\n`);
		return 0;
	}
	const rows = proposals.map((proposal) => [
		proposal.id,
		proposal.environment,
		proposal.requestedBy,
		String(proposal.services.length),
		proposal.credentialUse
			? `${proposal.credentialUse.ref} (${proposal.credentialUse.subject})`
			: proposal.credentials.map((credential) => credential.ref).join(","),
		truncate(proposal.message, 40),
	]);
	ctx.io.out(
		`${formatTable(["ID", "ENV", "FROM", "SERVICES", "CREDENTIALS", "MESSAGE"], rows)}\n`
	);
	return 0;
}

async function brokerCaCommand(ctx: CliContext): Promise<number> {
	const pem = await getVaultBrokerCaPem(machineTarget(ctx));
	ctx.io.out(pem.endsWith("\n") ? pem : `${pem}\n`);
	return 0;
}

const BROKER_USAGE =
	"Usage: ryu secrets broker services|sessions [revoke ID]|logs|proposals [approve|reject ID]|ca";

async function broker(ctx: CliContext, args: SecretsArgs): Promise<number> {
	switch (args.positional[1]) {
		case "services":
			return await brokerServicesCommand(ctx, args);
		case "sessions":
			return await brokerSessionsCommand(ctx, args);
		case "logs":
			return await brokerLogsCommand(ctx, args);
		case "proposals":
			return await brokerProposalsCommand(ctx, args);
		case "ca":
			return await brokerCaCommand(ctx);
		default:
			throw new UsageError(BROKER_USAGE);
	}
}

// ── Password managers ────────────────────────────────────────────────────────

const pmProviderSchema = z.enum([
	"1password-connect",
	"1password-service-account",
	"bitwarden-sm",
]);
const pmGrantSchema = z.enum(["once", "1h", "24h", "30d"]);

/** Exit code of `pm read` while the caller's use awaits a human approval. */
export const PM_PENDING_EXIT = 3;

function grantFlag(
	args: SecretsArgs
): VaultPasswordManagerGrantMode | undefined {
	const value = flag(args, "--grant");
	if (value === undefined) {
		return undefined;
	}
	const parsed = pmGrantSchema.safeParse(value);
	if (!parsed.success) {
		throw new UsageError("--grant must be once, 1h, 24h, or 30d.");
	}
	return parsed.data;
}

/** A provider token from piped stdin. Tokens are never accepted as
 *  arguments (they would land in shell history and the process table). */
async function readToken(ctx: CliContext): Promise<string> {
	const piped = await ctx.readStdin();
	const token = piped?.replace(/\r?\n$/, "").trim() ?? "";
	if (!token) {
		throw new UsageError(
			"Pipe the provider token on stdin (for example from your password manager's CLI); it is never accepted as an argument."
		);
	}
	return token;
}

async function pmAccountByName(
	ctx: CliContext,
	name: string
): Promise<VaultPasswordManagerAccount> {
	const { accounts } = await listVaultPasswordManagerAccounts(ctx.target);
	const account = accounts.find((candidate) => candidate.name === name);
	if (!account) {
		throw new UsageError(`No password-manager account named '${name}'.`);
	}
	return account;
}

async function pmAccounts(ctx: CliContext): Promise<number> {
	const { accounts } = await listVaultPasswordManagerAccounts(ctx.target);
	if (ctx.flags.json) {
		printJson(ctx, accounts);
		return 0;
	}
	if (accounts.length === 0) {
		ctx.io.out("No password-manager accounts.\n");
		return 0;
	}
	const rows = accounts.map((account) => [
		account.name,
		account.provider,
		account.state,
		account.address ?? "",
		truncate(account.lastError ?? "", 40),
	]);
	ctx.io.out(
		`${formatTable(["NAME", "PROVIDER", "STATE", "ADDRESS", "LAST ERROR"], rows)}\n`
	);
	return 0;
}

async function pmAdd(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const usage =
		"pm add NAME --provider 1password-connect|1password-service-account|bitwarden-sm [--address URL]";
	const name = arg(args, 2, usage);
	const provider = pmProviderSchema.safeParse(flag(args, "--provider"));
	if (!provider.success) {
		throw new UsageError(`Usage: ryu secrets ${usage}`);
	}
	const address = flag(args, "--address");
	const token = await readToken(ctx);
	const { account } = await createVaultPasswordManagerAccount(ctx.target, {
		name,
		provider: provider.data,
		token,
		...(address ? { address } : {}),
	});
	if (ctx.flags.json) {
		printJson(ctx, account);
	} else {
		ctx.io.out(
			`Added ${account.provider} account ${account.name}. Run 'ryu secrets pm test ${account.name}' to check it.\n`
		);
	}
	return 0;
}

async function pmTest(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const account = await pmAccountByName(ctx, arg(args, 2, "pm test NAME"));
	const result = await testVaultPasswordManagerAccount(ctx.target, account.id);
	if (ctx.flags.json) {
		printJson(ctx, result);
	} else if (result.ok) {
		ctx.io.out(`${account.name}: connected.\n`);
	} else {
		ctx.io.err(
			`${account.name}: ${result.account?.state ?? "error"}: ${result.error ?? "check failed"}\n`
		);
	}
	return result.ok ? 0 : 1;
}

async function pmReconnect(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const account = await pmAccountByName(ctx, arg(args, 2, "pm reconnect NAME"));
	const token = await readToken(ctx);
	await setVaultPasswordManagerToken(ctx.target, account.id, token);
	ctx.io.out(`Replaced the token for ${account.name}.\n`);
	return 0;
}

async function pmRemove(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const account = await pmAccountByName(ctx, arg(args, 2, "pm remove NAME"));
	await deleteVaultPasswordManagerAccount(ctx.target, account.id);
	ctx.io.out(
		`Removed ${account.name}, its grants, and its pending approvals.\n`
	);
	return 0;
}

async function pmRead(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const ref = arg(args, 2, "pm read REF [--env E]");
	const environment = flag(args, "--env");
	const result = await readVaultPasswordManagerRef(
		ctx.target,
		ref,
		environment ? { environment } : {}
	);
	if (result.pending) {
		if (ctx.flags.json) {
			printJson(ctx, result);
		}
		ctx.io.err(
			`Approval required: request ${result.approval.id} is pending. Approve it with 'ryu secrets pm approvals approve ${result.approval.id}' (or in Desktop), then read again.\n`
		);
		return PM_PENDING_EXIT;
	}
	if (ctx.flags.json) {
		printJson(ctx, result);
	} else {
		ctx.io.out(`${result.value}\n`);
	}
	return 0;
}

const pmStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);

async function pmApprovals(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[2] ?? "list";
	if (action === "approve" || action === "reject") {
		const id = arg(args, 3, `pm approvals ${action} ID`);
		const note = flag(args, "--reason");
		const grant = grantFlag(args);
		const result = await decideVaultPasswordManagerApproval(
			ctx.target,
			id,
			action,
			{ ...(note ? { note } : {}), ...(grant ? { grant } : {}) }
		);
		if (ctx.flags.json) {
			printJson(ctx, result);
		} else if ("grant" in result) {
			ctx.io.out(
				`Approved ${id}: ${result.grant.subject} may use ${result.grant.ref} (${result.grant.mode}).\n`
			);
		} else {
			ctx.io.out(`Rejected ${id}.\n`);
		}
		return 0;
	}
	if (action !== "list") {
		throw new UsageError(
			"Usage: ryu secrets pm approvals [list [--status S] | approve ID [--grant G] | reject ID [--reason R]]"
		);
	}
	const status = pmStatusSchema.safeParse(flag(args, "--status") ?? "pending");
	if (!status.success) {
		throw new UsageError(
			"--status must be pending, approved, rejected, or expired."
		);
	}
	const { approvals } = await listVaultPasswordManagerApprovals(ctx.target, {
		status: status.data,
	});
	if (ctx.flags.json) {
		printJson(ctx, approvals);
		return 0;
	}
	if (approvals.length === 0) {
		ctx.io.out(`No ${status.data} password-manager approvals.\n`);
		return 0;
	}
	const rows = approvals.map((approval) => [
		approval.id,
		approval.credentialUse?.subject ?? "",
		approval.credentialUse?.ref ?? "",
		approval.requestedBy,
		String(approval.expiresAt),
	]);
	ctx.io.out(
		`${formatTable(["ID", "SUBJECT", "REF", "REQUESTED BY", "EXPIRES"], rows)}\n`
	);
	return 0;
}

async function pmGrants(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const action = args.positional[2] ?? "list";
	if (action === "revoke") {
		const id = arg(args, 3, "pm grants revoke ID");
		const { grant } = await revokeVaultPasswordManagerGrant(ctx.target, id);
		ctx.io.out(`Revoked ${grant.id}; ${grant.subject} must ask again.\n`);
		return 0;
	}
	if (action !== "list") {
		throw new UsageError(
			"Usage: ryu secrets pm grants [--all] | pm grants revoke ID"
		);
	}
	const { grants } = await listVaultPasswordManagerGrants(ctx.target, {
		all: args.booleans.has("--all"),
	});
	if (ctx.flags.json) {
		printJson(ctx, grants);
		return 0;
	}
	if (grants.length === 0) {
		ctx.io.out("No password-manager grants.\n");
		return 0;
	}
	const rows = grants.map((grant) => [
		grant.id,
		grant.subject,
		grant.ref,
		grant.mode,
		grant.usesRemaining === null ? "" : String(grant.usesRemaining),
		String(grant.expiresAt),
	]);
	ctx.io.out(
		`${formatTable(["ID", "SUBJECT", "REF", "MODE", "USES LEFT", "EXPIRES"], rows)}\n`
	);
	return 0;
}

const PM_USAGE =
	"Usage: ryu secrets pm accounts|add|test|reconnect|remove|read|approvals|grants";

async function passwordManagers(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	switch (args.positional[1]) {
		case "accounts":
			return await pmAccounts(ctx);
		case "add":
			return await pmAdd(ctx, args);
		case "test":
			return await pmTest(ctx, args);
		case "reconnect":
			return await pmReconnect(ctx, args);
		case "remove":
		case "rm":
			return await pmRemove(ctx, args);
		case "read":
			return await pmRead(ctx, args);
		case "approvals":
			return await pmApprovals(ctx, args);
		case "grants":
			return await pmGrants(ctx, args);
		default:
			throw new UsageError(PM_USAGE);
	}
}

// ── TOTP ─────────────────────────────────────────────────────────────────────

async function totp(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const action = args.positional[1];
	const agent = agentTarget(ctx);
	if (action === "code") {
		const name = arg(args, 2, "totp code NAME");
		const code = agent
			? await vaultAgentTotpCode(agent, name)
			: await getVaultTotpCode(ctx.target, name);
		if (ctx.flags.json) {
			printJson(ctx, code);
		} else {
			ctx.io.out(`${code.code}\n`);
			ctx.io.err(`Valid for ${code.remainingSecs}s.\n`);
		}
		return 0;
	}
	if (action === "validate") {
		const usage = "totp validate NAME CODE";
		const name = arg(args, 2, usage);
		const code = arg(args, 3, usage);
		const { valid } = agent
			? await vaultAgentTotpValidate(agent, name, code)
			: await validateVaultTotpCode(ctx.target, name, code);
		if (ctx.flags.json) {
			printJson(ctx, { valid });
		} else {
			ctx.io.out(valid ? "valid\n" : "invalid\n");
		}
		return valid ? 0 : 1;
	}
	throw new UsageError(
		"Usage: ryu secrets totp code NAME | totp validate NAME CODE"
	);
}

// ── Typed items ──────────────────────────────────────────────────────────────

const ITEM_FIELD_TYPES: readonly VaultItemFieldType[] = [
	"text",
	"email",
	"url",
	"password",
	"totp",
	"note",
];
const PLAIN_SUFFIX = ":plain";

/** `--field name=value[:plain]`. A name that is a field type (`email`, `url`,
 *  `totp`, …) uses that type; otherwise the field is a sensitive `password`,
 *  or non-sensitive `text` with `:plain`. */
export function parseItemField(spec: string): {
	field: VaultItemFieldInput;
	value: string;
} {
	const eq = spec.indexOf("=");
	const name = eq === -1 ? "" : spec.slice(0, eq).trim();
	if (!name) {
		throw new UsageError(
			`Invalid --field '${spec}'. Use --field name=value[:plain].`
		);
	}
	let value = spec.slice(eq + 1);
	const plain = value.endsWith(PLAIN_SUFFIX);
	if (plain) {
		value = value.slice(0, -PLAIN_SUFFIX.length);
	}
	const named = ITEM_FIELD_TYPES.find((type) => type === name);
	const type: VaultItemFieldType = named ?? (plain ? "text" : "password");
	return { field: { name, type, sensitive: !plain }, value };
}

function itemLocation(args: SecretsArgs): VaultItemLocation {
	const location: VaultItemLocation = {};
	const environment = flag(args, "--env");
	const path = flag(args, "--path");
	if (environment) {
		location.environment = environment;
	}
	if (path) {
		location.path = path;
	}
	return location;
}

async function itemsList(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const { items } = await listVaultItems(ctx.target, itemLocation(args));
	if (ctx.flags.json) {
		printJson(ctx, items);
		return 0;
	}
	if (items.length === 0) {
		ctx.io.out("No items.\n");
		return 0;
	}
	const rows = items.map((item) => [
		item.key,
		item.environment,
		item.path,
		item.kind,
		String(item.version),
		item.status,
		String(item.fieldCount),
	]);
	ctx.io.out(
		`${formatTable(["KEY", "ENV", "PATH", "TYPE", "VERSION", "STATUS", "FIELDS"], rows)}\n`
	);
	return 0;
}

async function itemsGet(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const key = arg(args, 2, "items get KEY");
	const { item } = await getVaultItem(ctx.target, key, itemLocation(args));
	if (ctx.flags.json) {
		printJson(ctx, item);
		return 0;
	}
	ctx.io.out(
		`${item.key} (${item.kind}, version ${item.version}, ${item.status})\n`
	);
	const rows = item.fields.map((field) => {
		let shown = "(empty)";
		if (field.value !== undefined) {
			shown = field.value;
		} else if (field.hasValue) {
			shown = "(hidden)";
		}
		return [field.name, field.type, field.sensitive ? "yes" : "no", shown];
	});
	ctx.io.out(`${formatTable(["FIELD", "TYPE", "SENSITIVE", "VALUE"], rows)}\n`);
	return 0;
}

const CARD_PUT_USAGE =
	'Usage: printf \'%s\\n%s\\n\' "$NUMBER" "$CVC" | ryu secrets items put KEY --type card --cardholder NAME --exp MM/YY --merchant HOST…';

/** `MM/YY` or `MM/YYYY`. */
export function parseCardExpiry(value: string): {
	expMonth: string;
	expYear: string;
} {
	const match = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(value.trim());
	if (!(match?.[1] && match[2])) {
		throw new UsageError("--exp must be MM/YY or MM/YYYY.");
	}
	return { expMonth: match[1], expYear: match[2] };
}

/** The number (first line) and optional CVC (second line) from stdin. */
export function parseCardStdin(text: string): { cvc?: string; number: string } {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const [number, cvc, ...rest] = lines;
	if (!number || rest.length > 0) {
		throw new UsageError(
			"stdin must hold the card number on the first line and, optionally, the CVC on the second."
		);
	}
	return cvc === undefined ? { number } : { number, cvc };
}

const CARD_BILLING_FLAGS = [
	["--postal-code", "postalCode"],
	["--country", "country"],
	["--address-line1", "addressLine1"],
	["--address-line2", "addressLine2"],
	["--city", "city"],
	["--region", "region"],
] as const;

async function itemsPutCard(
	ctx: CliContext,
	args: SecretsArgs,
	key: string
): Promise<number> {
	if (args.values.has("--field")) {
		throw new UsageError(
			"Card items have a fixed schema; use --cardholder, --exp, and billing flags instead of --field."
		);
	}
	const cardholder = flag(args, "--cardholder");
	const exp = flag(args, "--exp");
	const merchants = args.values.get("--merchant") ?? [];
	if (!(cardholder && exp) || merchants.length === 0) {
		throw new UsageError(CARD_PUT_USAGE);
	}
	const piped = await ctx.readStdin();
	if (piped === null) {
		throw new UsageError(
			`The card number and CVC are read from stdin, which is a terminal. ${CARD_PUT_USAGE}`
		);
	}
	const { number, cvc } = parseCardStdin(piped);
	const input: Parameters<typeof putVaultCard>[2] = {
		...itemLocation(args),
		cardholder,
		number,
		...parseCardExpiry(exp),
		merchants,
	};
	if (cvc !== undefined) {
		input.cvc = cvc;
	}
	for (const [name, field] of CARD_BILLING_FLAGS) {
		const value = flag(args, name);
		if (value !== undefined) {
			input[field] = value;
		}
	}
	const description = flag(args, "--description");
	if (description !== undefined) {
		input.description = description;
	}
	const { item } = await putVaultCard(ctx.target, key, input);
	if (ctx.flags.json) {
		printJson(ctx, item);
	} else {
		const brand = item.card?.brand ?? "card";
		const last4 = item.card?.last4 ?? "????";
		ctx.io.out(
			`Stored card ${item.key} (${brand} ending ${last4}, version ${item.version}).\n`
		);
	}
	return 0;
}

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
		ctx.io.out(`Stored item ${item.key} (version ${item.version}).\n`);
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
					`Approval required (${result.approval.id}). Approve with: ryu secrets cards approvals approve ${result.approval.id}, then run this again.\n`
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
				result.deleted ? `Deleted item ${key}.\n` : `No item ${key}.\n`
			);
		}
		return 0;
	}
	throw new UsageError(
		"Usage: ryu secrets items list|get KEY|put KEY --type T --field name=value[:plain]|reveal KEY FIELD|delete KEY"
	);
}

// ── Payment card approvals ───────────────────────────────────────────────────

const cardApprovalStatusSchema = z.enum([
	"pending",
	"approved",
	"rejected",
	"expired",
	"consumed",
	"revoked",
]);
const cardApprovalModeSchema = z.enum(["once", "grant"]);
const cardGrantSubjectSchema = z.enum(["session", "agent"]);

const CARD_APPROVALS_USAGE =
	"Usage: ryu secrets cards approvals [list [--status S] [--env E] | approve ID [--mode once|grant] [--subject session|agent] [--ttl 15m] [--max-uses N] | reject ID | revoke ID]";

function cardApproveInput(args: SecretsArgs): VaultCardApproveInput {
	const input: VaultCardApproveInput = {};
	const mode = flag(args, "--mode");
	if (mode !== undefined) {
		const parsed = cardApprovalModeSchema.safeParse(mode);
		if (!parsed.success) {
			throw new UsageError("--mode must be once or grant.");
		}
		input.mode = parsed.data;
	}
	const subject = flag(args, "--subject");
	if (subject !== undefined) {
		const parsed = cardGrantSubjectSchema.safeParse(subject);
		if (!parsed.success) {
			throw new UsageError("--subject must be session or agent.");
		}
		input.subject = parsed.data;
	}
	const ttl = flag(args, "--ttl");
	if (ttl !== undefined) {
		input.ttlSecs = parseDuration(ttl);
	}
	const maxUses = intFlag(args, "--max-uses");
	if (maxUses !== undefined) {
		input.maxUses = maxUses;
	}
	const note = flag(args, "--reason");
	if (note) {
		input.note = note;
	}
	return input;
}

async function cardApprovalsList(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const status = cardApprovalStatusSchema.safeParse(
		flag(args, "--status") ?? "pending"
	);
	if (!status.success) {
		throw new UsageError(
			"--status must be pending, approved, rejected, expired, consumed, or revoked."
		);
	}
	const filter: { environment?: string; status: VaultCardApprovalStatus } = {
		status: status.data,
	};
	const environment = flag(args, "--env");
	if (environment) {
		filter.environment = environment;
	}
	const { approvals } = await listVaultCardApprovals(ctx.target, filter);
	if (ctx.flags.json) {
		printJson(ctx, approvals);
		return 0;
	}
	if (approvals.length === 0) {
		ctx.io.out(`No ${status.data} card approvals.\n`);
		return 0;
	}
	const rows = approvals.map((approval) => [
		approval.id,
		approval.key,
		`${approval.brand ?? "card"} ${approval.last4 ?? ""}`.trim(),
		approval.channel,
		approval.merchantHost || (approval.field ? `field ${approval.field}` : "-"),
		approval.requester,
		approval.status,
	]);
	ctx.io.out(
		`${formatTable(["ID", "CARD", "BRAND", "VIA", "MERCHANT", "REQUESTER", "STATUS"], rows)}\n`
	);
	return 0;
}

async function cards(ctx: CliContext, args: SecretsArgs): Promise<number> {
	if (args.positional[1] !== "approvals") {
		throw new UsageError(CARD_APPROVALS_USAGE);
	}
	const action = args.positional[2];
	if (action === undefined || action === "list") {
		return await cardApprovalsList(ctx, args);
	}
	if (action !== "approve" && action !== "reject" && action !== "revoke") {
		throw new UsageError(CARD_APPROVALS_USAGE);
	}
	const id = arg(args, 3, `cards approvals ${action} ID`);
	const input: VaultCardApproveInput =
		action === "approve" ? cardApproveInput(args) : {};
	const note = flag(args, "--reason");
	if (action !== "approve" && note) {
		input.note = note;
	}
	const { approval } = await decideVaultCardApproval(
		ctx.target,
		id,
		action,
		input
	);
	if (ctx.flags.json) {
		printJson(ctx, approval);
		return 0;
	}
	const verb = {
		approve: "Approved",
		reject: "Rejected",
		revoke: "Revoked",
	}[action];
	const scope =
		action === "approve" && approval.mode === "grant"
			? ` (grant for ${approval.grantSubject ?? "the requester"} at ${approval.merchantHost}${approval.maxUses ? `, ${approval.maxUses} uses` : ""})`
			: "";
	ctx.io.out(`${verb} card approval ${id}${scope}.\n`);
	return 0;
}

// ── Token lifecycle and response wrapping ────────────────────────────────────

function describeToken(ctx: CliContext, token: VaultTokenInfo): void {
	ctx.io.out(
		`${formatTable(
			["ACCESSOR", "IDENTITY", "POLICIES", "EXPIRES", "TTL", "RENEWABLE"],
			[
				[
					token.accessor,
					token.identityId,
					token.policies.join(","),
					String(token.expiresAt),
					`${token.ttlSecs}s`,
					token.renewable ? "yes" : "no",
				],
			]
		)}\n`
	);
}

async function tokenCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1];
	const agent = agentTarget(ctx);
	const accessor = args.positional[2];
	let token: VaultTokenInfo;
	if (action === "lookup") {
		if (agent && !accessor) {
			token = (await vaultAgentLookupSelf(agent)).token;
		} else {
			token = (
				await lookupVaultToken(
					ctx.target,
					arg(args, 2, "token lookup [ACCESSOR]")
				)
			).token;
		}
	} else if (action === "renew") {
		const increment = flag(args, "--increment");
		const options =
			increment === undefined
				? {}
				: { incrementSecs: parseDuration(increment) };
		if (agent && !accessor) {
			token = (await vaultAgentRenewSelf(agent, options)).token;
		} else {
			token = (
				await renewVaultToken(
					ctx.target,
					arg(args, 2, "token renew [ACCESSOR] [--increment S]"),
					options
				)
			).token;
		}
	} else {
		throw new UsageError(
			"Usage: ryu secrets token lookup [ACCESSOR] | token renew [ACCESSOR] [--increment S]"
		);
	}
	if (ctx.flags.json) {
		printJson(ctx, token);
	} else {
		describeToken(ctx, token);
	}
	return 0;
}

async function wrap(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const name = arg(args, 1, "wrap NAME --ttl S");
	const ttl = flag(args, "--ttl");
	if (ttl === undefined) {
		throw new UsageError("Usage: ryu secrets wrap NAME --ttl S (e.g. 5m)");
	}
	const agent = agentTarget(ctx);
	const { wrapInfo } = agent
		? await vaultAgentWrapSecret(
				agent,
				name,
				{ environment: flag(args, "--env"), path: flag(args, "--path") },
				ttl
			)
		: await wrapVaultSecret(ctx.target, name, coordsFrom(args), ttl);
	if (ctx.flags.json) {
		printJson(ctx, wrapInfo);
		return 0;
	}
	ctx.io.out(`${wrapInfo.token ?? ""}\n`);
	ctx.io.err(
		`Single-use wrapping token for ${name}; expires ${wrapInfo.expiresAt}. Recipient: ryu secrets unwrap TOKEN\n`
	);
	return 0;
}

async function unwrap(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const token = arg(args, 1, "unwrap TOKEN");
	const payload = await vaultUnwrap(machineTarget(ctx), token);
	const value = payload.value;
	if (!ctx.flags.json && typeof value === "string") {
		ctx.io.out(`${value}\n`);
		return 0;
	}
	printJson(ctx, payload);
	return 0;
}

// ── Registry ─────────────────────────────────────────────────────────────────

type SecretsHandler = (ctx: CliContext, args: SecretsArgs) => Promise<number>;

const SUBCOMMANDS = new Map<string, SecretsHandler>([
	["approvals", approvals],
	["audit", audit],
	["broker", broker],
	["cards", cards],
	["confirm", confirmIdentity],
	["delete", deleteSecret],
	["env", environments],
	["export", exportSecrets],
	["get", getSecret],
	["import", importSecrets],
	["items", items],
	["list", listSecrets],
	["login", login],
	["logout", (ctx) => logout(ctx)],
	["ls", listSecrets],
	["pm", passwordManagers],
	["policy", policies],
	["restore", restore],
	["rm", deleteSecret],
	["rollback", rollback],
	["run", runWithSecrets],
	["scan", scan],
	["seal", sealCommand],
	["set", setSecret],
	["status", sealCommand],
	["token", tokenCommand],
	["totp", totp],
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
		return await handler(ctx, args);
	},
};
