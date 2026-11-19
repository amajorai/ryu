// `ryu secrets audit-device …` and `ryu secrets quota …`: external audit
// devices (`admin` on `sys/audit`) and request quotas (`admin` on
// `sys/quotas`). Devices are configured from a JSON file so options such as a
// signing `secretRef` never sit in shell history; quotas take flags.

import { readFile } from "node:fs/promises";
import { appJsonValueSchema } from "@ryuhq/core-client/app-request-json";
import {
	deleteVaultAuditDevice,
	deleteVaultQuota,
	hashVaultAuditIdentifier,
	listVaultAuditDevices,
	listVaultQuotas,
	putVaultAuditDevice,
	putVaultQuota,
	type VaultAuditDeviceInput,
	type VaultQuota,
	type VaultQuotaRule,
} from "@ryuhq/core-client/vault";
import { z } from "zod";
import { tf, tr } from "../i18n/translate.ts";
import { formatTable, truncate } from "./output.ts";
import {
	arg,
	flag,
	intFlag,
	parseDuration,
	type SecretsArgs,
} from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";
import { yesNo } from "./yesNo.ts";

const DEVICE_USAGE =
	"Usage: ryu-cli secrets audit-device list | set ID FILE | delete ID | hash ID INPUT";
const QUOTA_USAGE =
	"Usage: ryu-cli secrets quota list | set NAME --rate N [--interval 1m] [--block 5m] [--path P] | set NAME --max-leases N --role GLOB | delete NAME";

const deviceFileSchema = z.object({
	kind: z.enum(["file", "syslog", "socket", "http"]),
	enabled: z.boolean().optional(),
	description: z.string().optional(),
	hmacFields: z.boolean().optional(),
	options: z.record(z.string(), appJsonValueSchema).optional(),
});

/** Read a device (`{"kind": "file", "options": {"path": …}}`) from a JSON file. */
export async function readDeviceFile(
	file: string
): Promise<VaultAuditDeviceInput> {
	let parsed: ReturnType<typeof deviceFileSchema.safeParse>;
	try {
		parsed = deviceFileSchema.safeParse(
			JSON.parse(await readFile(file, "utf8"))
		);
	} catch (error) {
		throw new UsageError(
			tf("Audit device file {file} must be JSON: {reason}", {
				file,
				reason: error instanceof Error ? error.message : String(error),
			})
		);
	}
	if (!parsed.success) {
		throw new UsageError(
			tf(
				"Audit device file {file} needs a kind (file, syslog, socket, or http) and an options object.",
				{ file }
			)
		);
	}
	return parsed.data;
}

function deviceTarget(options: unknown): string {
	if (options === null || typeof options !== "object") {
		return "";
	}
	const record = options as Record<string, unknown>;
	const target = record.path ?? record.address ?? record.url;
	return typeof target === "string" ? target : "";
}

export async function auditDevices(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1] ?? "list";
	if (action === "list") {
		const listing = await listVaultAuditDevices(ctx.target);
		if (ctx.flags.json) {
			printJson(ctx, listing);
			return 0;
		}
		const rows = listing.devices.map((device) => [
			device.id,
			device.kind,
			truncate(deviceTarget(device.options), 40),
			yesNo(device.enabled),
			device.health.failing
				? truncate(device.health.lastError ?? "failing", 40)
				: "ok",
			device.source,
		]);
		ctx.io.out(
			`${formatTable(["ID", "KIND", "TARGET", "ENABLED", "HEALTH", "SOURCE"], rows)}\n`
		);
		if (listing.failClosed) {
			ctx.io.out(
				`${tr("Fail-closed auditing is on: an operation fails when no file or syslog device records it.")}\n`
			);
		}
		return 0;
	}
	const id = arg(args, 2, `audit-device ${action} ID`);
	if (action === "set") {
		const input = await readDeviceFile(
			arg(args, 3, "audit-device set ID FILE")
		);
		const { device } = await putVaultAuditDevice(ctx.target, id, input);
		if (ctx.flags.json) {
			printJson(ctx, device);
		} else {
			ctx.io.out(
				`${tf("Saved audit device {id} ({kind}).", { id: device.id, kind: device.kind })}\n`
			);
		}
		return 0;
	}
	if (action === "delete" || action === "rm") {
		await deleteVaultAuditDevice(ctx.target, id);
		ctx.io.out(`${tf("Deleted audit device {id}.", { id })}\n`);
		return 0;
	}
	if (action === "hash") {
		const input = arg(args, 3, "audit-device hash ID INPUT");
		const { hash } = await hashVaultAuditIdentifier(ctx.target, id, input);
		ctx.io.out(`${hash}\n`);
		return 0;
	}
	throw new UsageError(DEVICE_USAGE);
}

/** `quota set` flags → a rate-limit or lease-count rule. */
export function quotaRuleFrom(args: SecretsArgs): VaultQuotaRule {
	const rate = intFlag(args, "--rate");
	const maxLeases = intFlag(args, "--max-leases");
	if ((rate === undefined) === (maxLeases === undefined)) {
		throw new UsageError(QUOTA_USAGE);
	}
	if (maxLeases !== undefined) {
		const role = flag(args, "--role");
		if (!role) {
			throw new UsageError(QUOTA_USAGE);
		}
		return { kind: "lease-count", role, maxLeases };
	}
	const rule: VaultQuotaRule = { kind: "rate-limit", rate: rate ?? 0 };
	const path = flag(args, "--path");
	const interval = flag(args, "--interval");
	const block = flag(args, "--block");
	if (path !== undefined) {
		rule.path = path;
	}
	if (interval !== undefined) {
		rule.intervalSecs = parseDuration(interval);
	}
	if (block !== undefined) {
		rule.blockIntervalSecs = parseDuration(block);
	}
	return rule;
}

function quotaRow(quota: VaultQuota): string[] {
	if (quota.kind === "lease-count") {
		return [
			quota.name,
			quota.kind,
			quota.role,
			tf("{count, plural, one {# lease} other {# leases}}", {
				count: quota.maxLeases,
			}),
			yesNo(quota.builtin),
		];
	}
	return [
		quota.name,
		quota.kind,
		quota.path || "*",
		`${quota.rate}/${quota.intervalSecs}s`,
		yesNo(quota.builtin),
	];
}

export async function quotas(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1] ?? "list";
	if (action === "list") {
		const listing = await listVaultQuotas(ctx.target);
		if (ctx.flags.json) {
			printJson(ctx, listing);
			return 0;
		}
		ctx.io.out(
			`${formatTable(["NAME", "KIND", "APPLIES TO", "LIMIT", "BUILT-IN"], listing.quotas.map(quotaRow))}\n`
		);
		ctx.io.out(
			`${tf("Live leases: {count}", { count: listing.leases.total })}\n`
		);
		return 0;
	}
	const name = arg(args, 2, `quota ${action} NAME`);
	if (action === "set") {
		const { quota } = await putVaultQuota(
			ctx.target,
			name,
			quotaRuleFrom(args)
		);
		if (ctx.flags.json) {
			printJson(ctx, quota);
		} else {
			ctx.io.out(`${tf("Saved quota {name}.", { name: quota.name })}\n`);
		}
		return 0;
	}
	if (action === "delete" || action === "rm") {
		const { deleted } = await deleteVaultQuota(ctx.target, name);
		ctx.io.out(
			deleted
				? `${tf("Deleted quota {name}.", { name })}\n`
				: `${tf("No quota {name}.", { name })}\n`
		);
		return 0;
	}
	throw new UsageError(QUOTA_USAGE);
}
