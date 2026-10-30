// apps/desktop/src/components/settings/PrivacySettings-options.ts
//
// Option tables and defaults for the Privacy settings tab.

import type {
	DiagnosticsContentMode,
	DiagnosticsExporterField,
	DiagnosticsExporterPreset,
	DiagnosticsExporterSettings,
} from "@/src/lib/api/preferences.ts";

// Hard-expiry duration options for a support-access grant. The §6 / §5.1 design
// keeps the support tier short (the impersonation tier uses <=1 hr); the user
// picks how long this scoped local channel stays open. A grant ALWAYS writes a
// non-zero expiry so Core's startup sweep can auto-disable it (a zero expiry
// would mean "never expires", which is not what a support grant should be).
export const ONE_HOUR_MS = 60 * 60 * 1000;
export const SUPPORT_DURATION_OPTIONS = [1, 8, 24] as const;
export const DEFAULT_SUPPORT_DURATION_HOURS = 1;

// OTLP content modes. Metadata only is the default posture; full content is a
// separate opt-in that Core still gates on diagnostics export consent.
export const CONTENT_MODE_OPTIONS: ReadonlyArray<{
	label: string;
	value: DiagnosticsContentMode;
}> = [
	{ label: "Metadata only", value: "metadata_only" },
	{ label: "Full content", value: "content" },
];

// Exporter presets: hosted LLM-observability backends Core maps onto OTLP.
// `fields` lists the preset-specific inputs shown under the destination picker.
export const EXPORTER_PRESET_OPTIONS: ReadonlyArray<{
	fields: readonly DiagnosticsExporterField[];
	label: string;
	value: DiagnosticsExporterPreset;
}> = [
	{ fields: ["apiKeyRef"], label: "Any OTLP endpoint", value: "otlp" },
	{
		fields: ["publicKeyRef", "apiKeyRef", "region"],
		label: "Langfuse",
		value: "langfuse",
	},
	{
		fields: ["apiKeyRef", "project", "region"],
		label: "LangSmith",
		value: "langsmith",
	},
	{
		fields: ["apiKeyRef", "project"],
		label: "Braintrust",
		value: "braintrust",
	},
	{
		fields: ["apiKeyRef", "project"],
		label: "Arize Phoenix",
		value: "phoenix",
	},
	{ fields: ["apiKeyRef", "region"], label: "Helicone", value: "helicone" },
	{
		fields: ["apiKeyRef", "project", "region"],
		label: "Datadog",
		value: "datadog",
	},
];

export const EXPORTER_FIELD_COPY: Record<
	DiagnosticsExporterField,
	{ label: string; placeholder: string }
> = {
	apiKeyRef: {
		label: "API key reference",
		placeholder: "env:LANGSMITH_API_KEY",
	},
	project: { label: "Project", placeholder: "my-agents" },
	publicKeyRef: {
		label: "Public key reference",
		placeholder: "env:LANGFUSE_PUBLIC_KEY",
	},
	region: { label: "Region or site", placeholder: "us, eu, or us5" },
};

export const SECRET_REFERENCE_FIELDS: ReadonlySet<DiagnosticsExporterField> =
	new Set(["apiKeyRef", "publicKeyRef"]);

export const EMPTY_EXPORTER: DiagnosticsExporterSettings = {
	apiKeyRef: "",
	preset: "otlp",
	project: "",
	publicKeyRef: "",
	region: "",
};
