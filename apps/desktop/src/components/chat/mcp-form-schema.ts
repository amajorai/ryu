import {
	isNativeBoolean,
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
export interface FormChoice {
	description?: string;
	label: string;
	thumbnail?: string;
	value: string;
}
export interface FormField {
	choices: FormChoice[];
	defaultValue?: string | number | boolean | string[];
	description?: string;
	format?: string;
	maxItems?: number;
	maximum?: number;
	maxLength?: number;
	minItems?: number;
	minimum?: number;
	minLength?: number;
	name: string;
	required: boolean;
	resource?: boolean;
	suggestions?: boolean;
	title: string;
	type: "string" | "boolean" | "number" | "integer" | "array";
}
export interface McpForm {
	conversationId: string;
	fields: FormField[];
	id: string;
	message: string;
	server: string;
}
export type FormValues = Record<string, string | number | boolean | string[]>;

export function nextFormPollDelay(
	previousDelay: number,
	hasPendingForms: boolean
): number {
	return hasPendingForms ? 1500 : Math.min(previousDelay * 2, 8000);
}
export type FormResponse =
	| { action: "accept"; content: FormValues }
	| { action: "cancel" | "decline" };

export function initialFormValues(fields: FormField[]): FormValues {
	return Object.fromEntries(
		fields.flatMap((field) =>
			field.defaultValue === undefined
				? field.type === "boolean"
					? [[field.name, false]]
					: field.type === "array"
						? [[field.name, []]]
						: []
				: [[field.name, field.defaultValue]]
		)
	);
}

const formObjectSchema = z.record(z.string(), z.json());
function object<TValue>(value: TValue) {
	const parsed = formObjectSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}
export function safeThumbnail<TValue>(value: TValue): string | undefined {
	const icon = object(value);
	const source = icon ? icon.src : value;
	if (!isNativeText(source)) {
		return;
	}
	if (
		source.length < 2_000_000 &&
		/^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/u.test(source)
	) {
		return source;
	}
	try {
		const url = new URL(source);
		if (url.protocol === "https:" && !url.username && !url.password) {
			return url.href;
		}
	} catch {
		return;
	}
}
function number<TValue>(value: TValue): number | undefined {
	return isNativeNumber(value) && Number.isFinite(value) ? value : undefined;
}
export function parseMcpForms<TValue>(value: TValue): McpForm[] {
	const payload = object(value);
	if (!Array.isArray(payload?.forms)) {
		throw new Error("Invalid form response");
	}
	return payload.forms.map(<TRaw>(raw: TRaw) => {
		const form = object(raw);
		const conversationId = form?.conversationId ?? form?.conversation_id;
		const schema = object(form?.requestedSchema ?? form?.requested_schema);
		const properties = object(schema?.properties);
		if (
			!(
				form &&
				schema &&
				properties &&
				isNativeText(form.id) &&
				isNativeText(conversationId) &&
				isNativeText(form.server) &&
				isNativeText(form.message)
			)
		) {
			throw new Error("Invalid form");
		}
		const required = Array.isArray(schema.required) ? schema.required : [];
		const fields = Object.entries(properties).map(
			([name, rawField]): FormField => {
				const field = object(rawField);
				if (
					!(
						field &&
						(field.type === "string" ||
							field.type === "boolean" ||
							field.type === "number" ||
							field.type === "integer" ||
							field.type === "array")
					)
				) {
					throw new Error("Unsupported form field");
				}
				const itemSchema = field.type === "array" ? object(field.items) : field;
				if (
					!itemSchema ||
					(field.type === "array" && itemSchema.type !== "string")
				) {
					throw new Error("Unsupported array field");
				}
				const resource = object(field["x-openai-input"]);
				const suggestionValues = itemSchema["x-openai-suggestions"];
				const choices: FormChoice[] = [];
				if (resource) {
					if (
						(resource.type !== "resource" && resource.type !== "file") ||
						resource.userOptions ||
						resource.selection === "implicit" ||
						!Array.isArray(resource.options)
					) {
						throw new Error("Unsupported resource form");
					}
					for (const rawChoice of resource.options) {
						const choice = object(rawChoice);
						if (
							!(choice && isNativeText(choice.uri) && isNativeText(choice.name))
						) {
							throw new Error("Invalid resource choice");
						}
						const meta = object(choice._meta);
						choices.push({
							value: choice.uri,
							label: isNativeText(choice.title) ? choice.title : choice.name,
							description: isNativeText(choice.description)
								? choice.description
								: undefined,
							thumbnail: safeThumbnail(meta?.["openai/thumbnail"]),
						});
					}
				} else if (
					Array.isArray(itemSchema.oneOf) ||
					Array.isArray(suggestionValues) ||
					Array.isArray(itemSchema.anyOf)
				) {
					const options = Array.isArray(itemSchema.oneOf)
						? itemSchema.oneOf
						: Array.isArray(itemSchema.anyOf)
							? itemSchema.anyOf
							: suggestionValues;
					if (!Array.isArray(options)) {
						throw new Error("Invalid form options");
					}
					for (const rawChoice of options) {
						const choice = object(rawChoice);
						if (!(choice && isNativeText(choice.const))) {
							throw new Error("Invalid form choice");
						}
						choices.push({
							value: choice.const,
							label: isNativeText(choice.title) ? choice.title : choice.const,
							description: isNativeText(choice.description)
								? choice.description
								: undefined,
							thumbnail: safeThumbnail(choice["x-openai-thumbnail"]),
						});
					}
				} else if (Array.isArray(itemSchema.enum)) {
					for (const choice of itemSchema.enum) {
						if (!isNativeText(choice)) {
							throw new Error("Invalid form choice");
						}
						choices.push({ value: choice, label: choice });
					}
				}
				return {
					name,
					title: isNativeText(field.title) ? field.title : name,
					description: isNativeText(field.description)
						? field.description
						: undefined,
					type: field.type,
					required: required.includes(name),
					choices,
					suggestions: Array.isArray(suggestionValues),
					resource: Boolean(resource),
					defaultValue:
						isNativeText(field.default) ||
						isNativeNumber(field.default) ||
						isNativeBoolean(field.default) ||
						(Array.isArray(field.default) &&
							field.default.every(<TDefault>(value: TDefault) =>
								isNativeText(value)
							))
							? field.default
							: undefined,
					minimum: number(field.minimum),
					maximum: number(field.maximum),
					minLength: number(itemSchema.minLength),
					maxLength: number(itemSchema.maxLength),
					minItems: number(field.minItems),
					maxItems: number(field.maxItems),
					format: isNativeText(itemSchema.format)
						? itemSchema.format
						: undefined,
				};
			}
		);
		return {
			id: form.id,
			conversationId,
			server: form.server,
			message: form.message,
			fields,
		};
	});
}

export function validateFormValues(
	fields: FormField[],
	values: FormValues
): string | undefined {
	for (const field of fields) {
		const value = values[field.name];
		if (value === undefined || value === "") {
			if (field.required) {
				return `${field.title} is required`;
			}
			continue;
		}
		if (field.type === "array") {
			if (
				!Array.isArray(value) ||
				(field.minItems !== undefined && value.length < field.minItems) ||
				(field.maxItems !== undefined && value.length > field.maxItems)
			) {
				return `${field.title} has an invalid selection`;
			}
			if (
				!field.suggestions &&
				field.choices.length &&
				value.some(
					(item) => !field.choices.some((choice) => choice.value === item)
				)
			) {
				return `Choose options for ${field.title}`;
			}
			if (
				value.some(
					(item) =>
						(field.minLength !== undefined &&
							[...item].length < field.minLength) ||
						(field.maxLength !== undefined &&
							[...item].length > field.maxLength)
				)
			) {
				return `${field.title} has an invalid length`;
			}
			continue;
		}
		if (field.type === "number" || field.type === "integer") {
			if (
				!(isNativeNumber(value) && Number.isFinite(value)) ||
				(field.type === "integer" && !Number.isInteger(value))
			) {
				return `${field.title} needs a valid number`;
			}
			if (
				(field.minimum !== undefined && value < field.minimum) ||
				(field.maximum !== undefined && value > field.maximum)
			) {
				return `${field.title} is outside the allowed range`;
			}
		}
		if (
			isNativeText(value) &&
			((field.minLength !== undefined && [...value].length < field.minLength) ||
				(field.maxLength !== undefined && [...value].length > field.maxLength))
		) {
			return `${field.title} has an invalid length`;
		}
		if (
			!field.suggestions &&
			field.choices.length &&
			!field.choices.some((choice) => choice.value === value)
		) {
			return `Choose an option for ${field.title}`;
		}
	}
}
