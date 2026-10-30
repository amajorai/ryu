import { z } from "zod";

export const SECTIONS = [
	"firewall",
	"firewall_org_overlays",
	"firewall_agent_overlays",
	"custom_evaluators",
	"claude-gateway-routing",
	"codex-gateway-routing",
	"agent-gateway-routing",
] as const;
export type Section = (typeof SECTIONS)[number];
export const LABELS = [
	"Node firewall",
	"Organization overlays",
	"Agent overlays",
	"Custom evaluator catalog",
	"Claude egress preference",
	"Codex egress preference",
	"Agent egress preference map",
];
export const policyJsonSchema = z.json();
export type PolicyValue = z.infer<typeof policyJsonSchema> | undefined;
export const policyRecordSchema = z.record(z.string(), policyJsonSchema);
export type PolicyRecord = z.infer<typeof policyRecordSchema>;
export const policyScalarSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
]);
export const policyBooleanSchema = z.boolean();
export const policyBooleanMapSchema = z.record(z.string(), policyBooleanSchema);
export const policyStringSchema = z.string();
export const policyInspectorModelSchema = policyStringSchema.trim().min(1);
export const policyCatalogSchema = z.object({
	evaluators: policyJsonSchema.optional(),
});
export const policyPreferenceSchema = z.object({
	value: policyJsonSchema.optional(),
});
export const policyRestartSchema = z.object({
	success: z.boolean().optional().catch(undefined),
});
export type Snapshot = Partial<Record<Section, PolicyValue>>;
export function record(value: PolicyValue): value is PolicyRecord {
	return (
		value !== undefined &&
		!Array.isArray(value) &&
		!policyScalarSchema.safeParse(value).success
	);
}
export function canonical(value: PolicyValue): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(",")}]`;
	}
	if (record(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
// Gateway may add serde defaults, but every authored value must survive readback.
export function confirms(expected: PolicyValue, actual: PolicyValue): boolean {
	if (expected === null) {
		return actual === null || actual === undefined;
	}
	if (Array.isArray(expected)) {
		return (
			Array.isArray(actual) &&
			expected.length === actual.length &&
			expected.every((item, index) => confirms(item, actual[index]))
		);
	}
	if (record(expected)) {
		return (
			record(actual) &&
			Object.entries(expected).every(([key, value]) =>
				confirms(value, actual[key])
			)
		);
	}
	return expected === actual;
}
export function confirmsSection(
	section: Section,
	expected: PolicyValue,
	actual: PolicyValue
): boolean {
	if (
		(section === "firewall_org_overlays" ||
			section === "firewall_agent_overlays" ||
			section === "agent-gateway-routing") &&
		record(expected) &&
		record(actual) &&
		canonical(Object.keys(expected).sort()) !==
			canonical(Object.keys(actual).sort())
	) {
		return false;
	}
	return confirms(expected, actual);
}
export function validate(
	section: Section,
	value: PolicyValue,
	before: PolicyValue
): void {
	if (
		section === "claude-gateway-routing" ||
		section === "codex-gateway-routing"
	) {
		if (!policyBooleanSchema.safeParse(value).success) {
			throw new Error(
				"Use true for Gateway routing or false for direct routing."
			);
		}
		return;
	}
	if (section === "agent-gateway-routing") {
		if (!policyBooleanMapSchema.safeParse(value).success) {
			throw new Error(
				"Use an agent ID to boolean map. Missing IDs inherit Gateway routing."
			);
		}
		return;
	}
	if (section === "custom_evaluators") {
		if (!Array.isArray(value)) {
			throw new Error("Provide the complete evaluator array.");
		}
		return;
	}
	if (!record(value)) {
		throw new Error("Provide the complete section object.");
	}
	if (section === "firewall" && record(before)) {
		for (const key of Object.keys(before)) {
			if (!(key in value)) {
				throw new Error(`Keep served field ${key}; edit its value explicitly.`);
			}
		}
	}
	const rows = section === "firewall" ? [value] : Object.values(value);
	for (const row of rows) {
		if (!record(row)) {
			throw new Error("Every overlay must be an object.");
		}
		if (
			row.inspector !== undefined &&
			row.inspector !== null &&
			!(
				record(row.inspector) &&
				policyInspectorModelSchema.safeParse(row.inspector.model).success
			)
		) {
			throw new Error("Inspector requires an explicit nonblank model ID.");
		}
		if (
			section !== "firewall" &&
			(row.wrap_untrusted_tool_results != null ||
				(Array.isArray(row.locked_fields) &&
					row.locked_fields.includes("wrap_untrusted_tool_results")))
		) {
			throw new Error("Tool-result wrapping and its lock are node-only.");
		}
	}
}
