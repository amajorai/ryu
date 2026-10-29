import { z } from "zod";
import { LocalizedError, localize } from "./localizedText.ts";

const gatewayJsonSchema = z.json();
type GatewayJsonValue = z.infer<typeof gatewayJsonSchema>;
const gatewayConfigValueSchema = gatewayJsonSchema.optional();
type GatewayConfigValue = z.infer<typeof gatewayConfigValueSchema>;
const gatewayConfigRecordSchema = z.record(z.string(), gatewayJsonSchema);
export type GatewayConfigPatch = z.infer<typeof gatewayConfigRecordSchema>;
const gatewayScalarSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
]);

export interface GatewayConfigChange {
	after: GatewayConfigValue;
	before: GatewayConfigValue;
	path: string;
}

const WRITABLE_FIELDS = new Map<string, readonly string[]>([
	["auth", ["api_keys", "require_auth"]],
	["budgets", ["users", "agents", "session"]],
	[
		"firewall",
		[
			"enabled",
			"scan_inbound",
			"scan_outbound",
			"policy",
			"log_detections",
			"redact_pii",
			"redact_secrets",
			"custom_patterns",
		],
	],
	["routing", ["default_provider", "fallback_chain"]],
]);

const BUDGET_RULE_FIELDS = [
	"limit",
	"action",
	"downgrade_to",
	"alert",
	"restrict_max_tokens",
	"include",
] as const;

const API_KEY_FIELDS = [
	"key",
	"name",
	"org_id",
	"team_id",
	"project_id",
	"trusted_forwarder",
] as const;

const FIREWALL_PATTERN_FIELDS = ["name", "regex", "kind"] as const;

function isGatewayRecord(
	value: GatewayConfigValue
): value is GatewayConfigPatch {
	return (
		value !== undefined &&
		!Array.isArray(value) &&
		!gatewayScalarSchema.safeParse(value).success
	);
}
function asRecord(value: GatewayConfigValue): GatewayConfigPatch | null {
	return isGatewayRecord(value) ? value : null;
}

function rejectUnknownFields(
	value: GatewayConfigPatch,
	allowed: readonly string[],
	path: string
): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) {
		throw new LocalizedError(
			localize(
				"{count, plural, one {Unsupported gateway config field} other {Unsupported gateway config fields}} at {path}: {fields}",
				{ count: unknown.length, fields: unknown.join(", "), path }
			)
		);
	}
}

function validateRecordArray(
	value: GatewayConfigValue,
	allowed: readonly string[],
	path: string
): void {
	if (!Array.isArray(value)) {
		throw new LocalizedError(localize("{path} must be an array", { path }));
	}
	for (const [index, row] of value.entries()) {
		const record = asRecord(row);
		if (!record) {
			throw new LocalizedError(
				localize("{path} must be a table", { path: `${path}[${index}]` })
			);
		}
		rejectUnknownFields(record, allowed, `${path}[${index}]`);
	}
}

function validateSection(section: string, value: GatewayConfigValue): void {
	const record = asRecord(value);
	if (!record) {
		throw new LocalizedError(
			localize("{path} must be a table", { path: `[${section}]` })
		);
	}
	rejectUnknownFields(record, WRITABLE_FIELDS.get(section) ?? [], section);
	if (section === "auth" && record.api_keys !== undefined) {
		validateRecordArray(record.api_keys, API_KEY_FIELDS, "auth.api_keys");
	}
	if (section === "firewall" && record.custom_patterns !== undefined) {
		validateRecordArray(
			record.custom_patterns,
			FIREWALL_PATTERN_FIELDS,
			"firewall.custom_patterns"
		);
	}
	if (section === "budgets") {
		for (const key of ["users", "agents"] as const) {
			if (record[key] === undefined) {
				continue;
			}
			const rules = asRecord(record[key]);
			if (!rules) {
				throw new LocalizedError(
					localize("{path} must be a table", { path: `budgets.${key}` })
				);
			}
			for (const [id, rule] of Object.entries(rules)) {
				const ruleRecord = asRecord(rule);
				if (!ruleRecord) {
					throw new LocalizedError(
						localize("{path} must be a table", { path: `budgets.${key}.${id}` })
					);
				}
				rejectUnknownFields(
					ruleRecord,
					BUDGET_RULE_FIELDS,
					`budgets.${key}.${id}`
				);
			}
		}
		if (record.session !== undefined) {
			const session = asRecord(record.session);
			if (!session) {
				throw new LocalizedError(
					localize("{path} must be a table", { path: "budgets.session" })
				);
			}
			rejectUnknownFields(session, BUDGET_RULE_FIELDS, "budgets.session");
		}
	}
}

/** Parse the documented Core-writable TOML subset and reject fields Core would ignore. */
export function parseGatewayConfigPatch(source: string): GatewayConfigPatch {
	let parsed: GatewayConfigPatch;
	try {
		parsed = gatewayConfigRecordSchema.parse(Bun.TOML.parse(source));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new LocalizedError(
			localize("Invalid gateway TOML: {message}", { message })
		);
	}
	const config = asRecord(parsed);
	if (!config) {
		throw new Error("Gateway TOML must contain a top-level table");
	}
	const sections = Object.keys(config);
	if (sections.length === 0) {
		throw new Error("Gateway TOML must include a writable section");
	}
	rejectUnknownFields(config, Array.from(WRITABLE_FIELDS.keys()), "root");
	for (const [section, value] of Object.entries(config)) {
		validateSection(section, value);
	}
	return config;
}

function stableJson(value: GatewayConfigValue): string {
	if (value === undefined) {
		return "undefined";
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}
	const record = asRecord(value);
	if (!record) {
		return JSON.stringify(value);
	}
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

function redact(value: GatewayJsonValue, key?: string): GatewayJsonValue;
function redact(value: GatewayConfigValue, key?: string): GatewayConfigValue;
function redact(value: GatewayConfigValue, key?: string): GatewayConfigValue {
	if (key && /(?:key|token|secret|password)$/i.test(key)) {
		return "[redacted]";
	}
	if (Array.isArray(value)) {
		return value.map((item) => redact(item));
	}
	const record = asRecord(value);
	if (!record) {
		return value;
	}
	return Object.fromEntries(
		Object.entries(record).map(([childKey, child]) => [
			childKey,
			redact(child, childKey),
		])
	);
}

/** Redact credential-shaped Gateway fields before any config result is printed. */
export function redactGatewayConfig(
	value: Parameters<typeof gatewayConfigValueSchema.parse>[0]
): GatewayConfigValue {
	return redact(gatewayConfigValueSchema.parse(value));
}

/** Return a safe preview of exactly the sections/fields the file would change. */
export function gatewayConfigDiff(
	patch: GatewayConfigPatch,
	current: Parameters<typeof gatewayConfigValueSchema.safeParse>[0]
): GatewayConfigChange[] {
	const parsedCurrent = gatewayConfigValueSchema.safeParse(current);
	const currentRecord = parsedCurrent.success
		? (asRecord(parsedCurrent.data) ?? {})
		: {};
	const changes: GatewayConfigChange[] = [];
	const visit = (
		next: GatewayConfigValue,
		before: GatewayConfigValue,
		path: string
	): void => {
		const nextRecord = asRecord(next);
		const beforeRecord = asRecord(before);
		// Core replaces budgets as a whole; firewall, routing, and auth are merged
		// at their supplied field paths.
		if (path !== "budgets" && nextRecord) {
			for (const [key, value] of Object.entries(nextRecord)) {
				visit(value, beforeRecord?.[key], path ? `${path}.${key}` : key);
			}
			return;
		}
		if (stableJson(next) !== stableJson(before)) {
			changes.push({
				path,
				before: before === undefined ? "(unset)" : redact(before),
				after: redact(next),
			});
		}
	};
	for (const [section, value] of Object.entries(patch)) {
		visit(value, currentRecord[section], section);
	}
	return changes;
}
