import type { Badge } from "@ryu/ui/components/badge.tsx";
import type { ComponentProps } from "react";
import { z } from "zod";
import type {
	ComposioAction,
	ComposioInputProperty,
} from "@/src/lib/api/composio.ts";
import type { SpaceImportRecord } from "@/src/lib/api/space-imports.ts";

export const DOCUMENT_ACCEPT =
	".txt,.text,.md,.markdown,.mdown,.mkdn,.mkd,.rmd,.html,.htm,.docx,.pdf,.epub,.opml";
export const DATABASE_ACCEPT = ".csv,.tsv,.dsv,.xlsx,.xls,.ods";
export const ARCHIVE_ACCEPT = ".zip";

export function errorMessage<TError>(error: TError): string {
	return error instanceof Error
		? error.message
		: "The import could not be started.";
}

export function openResultLabel(title: string): string {
	return /^open\b/i.test(title.trim()) ? title : `Open ${title}`;
}

export function formatBytes(bytes: number): string {
	if (bytes <= 0) {
		return "";
	}
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatWhen(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(timestamp));
}

export const CONNECTOR_LABELS: Record<string, string> = {
	confluence: "Confluence",
	github: "GitHub",
	google_drive: "Google Drive",
	notion: "Notion",
	web: "Web",
};

export function importSourceLabel(item: SpaceImportRecord): string {
	if (item.sourceType === "composio") {
		return `Composio · ${item.sourceFormat}`;
	}
	if (item.sourceType === "connector") {
		return CONNECTOR_LABELS[item.sourceFormat] ?? item.sourceFormat;
	}
	return item.sourceFormat.toUpperCase();
}

export function statusVariant(
	status: SpaceImportRecord["status"]
): ComponentProps<typeof Badge>["variant"] {
	if (status === "completed") {
		return "secondary";
	}
	if (status === "failed") {
		return "destructive";
	}
	return "outline";
}

export function defaultArgumentValue(property: ComposioInputProperty): string {
	if (property.default === undefined || property.default === null) {
		return "";
	}
	if (
		z
			.union([z.array(z.json()), z.record(z.string(), z.json())])
			.safeParse(property.default).success
	) {
		return JSON.stringify(property.default);
	}
	return String(property.default);
}

export function buildArguments(
	action: ComposioAction,
	values: Record<string, string>
) {
	const argumentsValue: Record<string, z.infer<ReturnType<typeof z.json>>> = {};
	const required = new Set(action.inputSchema.required ?? []);
	for (const [name, property] of Object.entries(
		action.inputSchema.properties ?? {}
	)) {
		const value = (values[name] ?? defaultArgumentValue(property)).trim();
		if (!value) {
			if (required.has(name)) {
				throw new Error(
					`Enter ${property.title ?? name.replaceAll("_", " ")}.`
				);
			}
			continue;
		}
		const type = Array.isArray(property.type)
			? property.type[0]
			: property.type;
		if (type === "number" || type === "integer") {
			const number = Number(value);
			if (!Number.isFinite(number)) {
				throw new Error(`${property.title ?? name} must be a number.`);
			}
			argumentsValue[name] = number;
		} else if (type === "boolean") {
			argumentsValue[name] = value === "true";
		} else if (type === "array" || type === "object") {
			argumentsValue[name] = z.json().parse(JSON.parse(value));
		} else {
			argumentsValue[name] = value;
		}
	}
	return argumentsValue;
}
