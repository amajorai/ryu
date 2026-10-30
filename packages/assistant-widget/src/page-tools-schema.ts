import { z } from "zod";
import type { WebMcpPageTool } from "./webmcp.ts";
import type { WebMcpRecord } from "./webmcp-contract.ts";

export interface ToolField {
	description?: string;
	enumValues?: string[];
	key: string;
	maximum?: number;
	minimum?: number;
	required: boolean;
	type: "boolean" | "integer" | "number" | "string";
}

export type ToolValue = boolean | string;

export function fieldLabel(value: string): string {
	return value
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/[-_.]+/g, " ")
		.replace(/^./, (character) => character.toUpperCase());
}

export function toolFields(tool: WebMcpPageTool): ToolField[] {
	const schema = tool.inputSchema;
	const properties = schema.properties;
	const required = new Set(schema.required ?? []);
	const fields: ToolField[] = [];
	for (const [key, value] of Object.entries(properties).slice(0, 12)) {
		const enumValues = value.enum?.slice(0, 20);
		const rawType = value.type;
		const type: ToolField["type"] =
			rawType === "boolean"
				? "boolean"
				: rawType === "integer"
					? "integer"
					: rawType === "number"
						? "number"
						: "string";
		fields.push({
			description: value.description?.slice(0, 150),
			enumValues,
			key,
			maximum: value.maximum,
			minimum: value.minimum,
			required: required.has(key),
			type,
		});
	}
	return fields;
}

export function buildToolInput(
	fields: readonly ToolField[],
	values: Record<string, ToolValue>
): WebMcpRecord {
	const input: WebMcpRecord = {};
	for (const field of fields) {
		const rawValue = values[field.key];
		if (field.type === "boolean") {
			if (rawValue === true || field.required) {
				input[field.key] = rawValue === true;
			}
			continue;
		}
		const parsedValue = z.string().safeParse(rawValue);
		if (!(parsedValue.success && parsedValue.data.trim())) {
			if (field.required) {
				throw new Error(`${fieldLabel(field.key)} is required.`);
			}
			continue;
		}
		const value = parsedValue.data;
		if (field.type === "number" || field.type === "integer") {
			const number = Number(value);
			if (!Number.isFinite(number)) {
				throw new Error(`${fieldLabel(field.key)} must be a number.`);
			}
			if (field.type === "integer" && !Number.isSafeInteger(number)) {
				throw new Error(
					`The value for ${fieldLabel(field.key)} must be a whole number.`
				);
			}
			if (
				(field.minimum !== undefined && number < field.minimum) ||
				(field.maximum !== undefined && number > field.maximum)
			) {
				throw new Error(
					`${fieldLabel(field.key)} is outside the allowed range.`
				);
			}
			input[field.key] = number;
			continue;
		}
		if (field.enumValues && !field.enumValues.includes(value)) {
			throw new Error(`${fieldLabel(field.key)} is not a supported value.`);
		}
		input[field.key] = value.trim();
	}
	return input;
}

export function toolIsWrite(tool: WebMcpPageTool): boolean {
	return (
		tool.annotations?.consequentialHint === true ||
		tool.annotations?.readOnlyHint !== true
	);
}

export function displayTitle(tool: WebMcpPageTool): string {
	return tool.title?.trim() || tool.name;
}

export function toolCategory(tool: WebMcpPageTool): string {
	const category = toolIsWrite(tool) ? "Action" : "Read-only";
	return tool.annotations?.debugging === true
		? `${category} · Developer tool`
		: category;
}
