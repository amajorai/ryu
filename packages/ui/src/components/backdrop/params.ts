// packages/ui/src/components/backdrop/params.ts
//
// The customization schema every backdrop exposes. A backdrop declares its
// params once; the controls UI renders sliders, colour pickers, toggles and
// selects from the same list, and every stored value is re-validated through
// `resolveBackdropParams` before it reaches a renderer. Stored params can come
// from localStorage, a shared marketplace listing or a pasted component, so
// nothing here trusts its input: numbers are clamped, colours must parse, and
// unknown keys are dropped.

import { z } from "zod";
import { PAPER_SHADER_OPTIONS } from "./paper-defaults.ts";

const paperShaderOptionsByKey = new Map(Object.entries(PAPER_SHADER_OPTIONS));

interface ParamBase {
	key: string;
	label: string;
}

export type BackdropParamSpec =
	| (ParamBase & { kind: "color"; default: string })
	| (ParamBase & {
			kind: "colors";
			default: readonly string[];
			max: number;
			min: number;
	  })
	| (ParamBase & {
			kind: "number";
			default: number;
			max: number;
			min: number;
			step: number;
	  })
	| (ParamBase & { kind: "boolean"; default: boolean })
	| (ParamBase & {
			kind: "select";
			default: string;
			options: readonly string[];
	  });

/** Values produced by the declared backdrop controls after input resolution. */
export const backdropParamValueSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.array(z.string()),
	z.undefined(),
]);
export type BackdropParamValue = z.output<typeof backdropParamValueSchema>;
export const backdropParamsSchema = z.record(
	z.string(),
	backdropParamValueSchema
);
export type BackdropParams = z.output<typeof backdropParamsSchema>;

// Stored JSON and SDK shader defaults are inspected before individual controls
// apply their own colour, range and option contracts.
const rawBackdropFieldsSchema = z.record(z.string(), z.unknown());
const rawBackdropEntriesSchema = z.custom<
	z.output<typeof rawBackdropFieldsSchema>
>(
	(value) =>
		z
			.union([
				rawBackdropFieldsSchema,
				z.array(z.unknown()),
				z
					.instanceof(Object)
					.refine((value) => !z.function().safeParse(value).success),
			])
			.safeParse(value).success
);
const rawBackdropPaletteSchema = z.array(z.unknown());
const backdropNumberInputSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const rawBackdropParamSchema = z
	.union([
		z.string(),
		backdropNumberInputSchema,
		z.boolean(),
		rawBackdropPaletteSchema,
		z.undefined(),
	])
	.catch(undefined);

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION_COLOR =
	/^(?:rgba?|hsla?)\(\s*[\d.]+%?\s*,?\s*[\d.]+%?\s*,?\s*[\d.]+%?\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i;

/** Colours reach CSS and WebGL sinks, so only plain colour literals pass. */
export const backdropColorSchema = z
	.string()
	.max(40)
	.pipe(
		z
			.string()
			.refine(
				(value) =>
					HEX_COLOR.test(value.trim()) || FUNCTION_COLOR.test(value.trim())
			)
	);
export function isSafeColor(
	value: Parameters<typeof backdropColorSchema.safeParse>[0]
): value is string {
	return backdropColorSchema.safeParse(value).success;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function resolveOne(
	spec: BackdropParamSpec,
	raw: z.output<typeof rawBackdropParamSchema>
): BackdropParamValue {
	switch (spec.kind) {
		case "color": {
			const parsed = backdropColorSchema.safeParse(raw);
			return parsed.success ? parsed.data.trim() : spec.default;
		}
		case "colors": {
			const parsed = rawBackdropPaletteSchema.safeParse(raw);
			if (!parsed.success) {
				return [...spec.default];
			}
			const colors = parsed.data.filter(isSafeColor).slice(0, spec.max);
			return colors.length >= spec.min ? colors : [...spec.default];
		}
		case "number": {
			const parsed = z.number().safeParse(raw);
			return parsed.success
				? clamp(parsed.data, spec.min, spec.max)
				: spec.default;
		}
		case "boolean": {
			const parsed = z.boolean().safeParse(raw);
			return parsed.success ? parsed.data : spec.default;
		}
		case "select": {
			const parsed = z
				.string()
				.refine((value) => spec.options.includes(value))
				.safeParse(raw);
			return parsed.success ? parsed.data : spec.default;
		}
		default:
			return undefined;
	}
}

/** Defaults overlaid with whatever valid values `raw` carries. */
export function resolveBackdropParams(
	specs: readonly BackdropParamSpec[],
	raw: Parameters<typeof rawBackdropEntriesSchema.safeParse>[0]
): BackdropParams {
	const parsed = rawBackdropEntriesSchema.safeParse(raw);
	const source = parsed.success ? parsed.data : {};
	const resolved: BackdropParams = {};
	for (const spec of specs) {
		resolved[spec.key] = resolveOne(
			spec,
			rawBackdropParamSchema.parse(source[spec.key])
		);
	}
	return resolved;
}

export function defaultBackdropParams(
	specs: readonly BackdropParamSpec[]
): BackdropParams {
	return resolveBackdropParams(specs, {});
}

/** Known ranges for shader params whose default alone can't imply one. */
type BackdropNumberRange = readonly [
	minimum: number,
	maximum: number,
	step: number,
];
const numberRanges = {
	angle: [0, 360, 1],
	angle1: [-1, 1, 0.01],
	angle2: [-1, 1, 0.01],
	bandCount: [1, 12, 1],
	count: [1, 20, 1],
	noiseIterations: [1, 10, 1],
	noiseScale: [0.1, 10, 0.1],
	repetition: [1, 10, 0.1],
	scale: [0.1, 4, 0.01],
	size: [0.01, 2, 0.01],
	speed: [0, 3, 0.01],
	stepsPerColor: [1, 7, 1],
	swirlIterations: [0, 20, 1],
} satisfies Record<string, BackdropNumberRange>;
const NUMBER_RANGES = new Map(Object.entries(numberRanges));

export function humanizeKey(key: string): string {
	const spaced = key.replace(/([a-z])([A-Z0-9])/g, "$1 $2").toLowerCase();
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function numberSpec(key: string, value: number): BackdropParamSpec {
	const known = NUMBER_RANGES.get(key);
	if (known) {
		return {
			default: value,
			key,
			kind: "number",
			label: humanizeKey(key),
			max: known[1],
			min: known[0],
			step: known[2],
		};
	}
	const max = value <= 1 ? 1 : Math.max(10, Math.ceil(value * 2));
	const min = value < 0 ? -max : 0;
	return {
		default: value,
		key,
		kind: "number",
		label: humanizeKey(key),
		max,
		min,
		step: max <= 1 ? 0.01 : 0.1,
	};
}

/**
 * Derive a param schema from a shader's default params: colours become colour
 * pickers, colour lists become swatch lists, numbers get sliders, booleans get
 * toggles, and enum strings get selects when their options are known.
 */
export function specsFromDefaults(
	shader: string,
	defaults: Parameters<typeof rawBackdropEntriesSchema.safeParse>[0]
): BackdropParamSpec[] {
	const specs: BackdropParamSpec[] = [];
	const parsed = rawBackdropEntriesSchema.safeParse(defaults);
	for (const [key, value] of Object.entries(
		parsed.success ? parsed.data : {}
	)) {
		const label = humanizeKey(key);
		const palette = z.array(backdropColorSchema).safeParse(value);
		if (palette.success) {
			specs.push({
				default: palette.data,
				key,
				kind: "colors",
				label,
				max: 10,
				min: 1,
			});
		} else if (isSafeColor(value)) {
			specs.push({ default: value, key, kind: "color", label });
		} else {
			const number = backdropNumberInputSchema.safeParse(value);
			if (number.success) {
				specs.push(numberSpec(key, number.data));
				continue;
			}
			const boolean = z.boolean().safeParse(value);
			if (boolean.success) {
				specs.push({ default: boolean.data, key, kind: "boolean", label });
				continue;
			}
			const text = z.string().safeParse(value);
			const options = paperShaderOptionsByKey.get(`${shader}.${key}`);
			if (text.success && options) {
				specs.push({ default: text.data, key, kind: "select", label, options });
			}
		}
	}
	return specs;
}
