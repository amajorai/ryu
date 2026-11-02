// packages/ui/src/components/backdrop/backdrop-builders.ts
//
// Entry and parameter builders shared by the backdrop registry
// (`definitions.ts`) and its named entries (`named-backdrops.ts`).

import type { ShaderSizingParams } from "@paper-design/shaders-react";
import type {
	BackdropCategory,
	BackdropComponentId,
	BackdropDefinition,
} from "./definitions.ts";
import { PAPER_SHADER_DEFAULTS, type PaperShaderId } from "./paper-defaults.ts";
import {
	type BackdropParamSpec,
	type BackdropParams,
	specsFromDefaults,
} from "./params.ts";

export function paper(
	id: string,
	label: string,
	category: BackdropCategory,
	shader: PaperShaderId,
	description: string,
	overrides: BackdropParams = {},
	fixed?: ShaderSizingParams
): BackdropDefinition {
	const defaults = {
		...PAPER_SHADER_DEFAULTS[shader].params,
		...overrides,
	};
	return {
		animated: "speed" in defaults,
		category,
		description,
		id,
		label,
		params: specsFromDefaults(shader, defaults),
		render: { fixed, kind: "paper", shader },
	};
}

export function component(
	id: BackdropComponentId,
	label: string,
	category: BackdropCategory,
	description: string,
	params: BackdropParamSpec[],
	animated = true
): BackdropDefinition {
	return {
		animated,
		category,
		description,
		id,
		label,
		params,
		render: { component: id, kind: "component" },
	};
}

export const color = (
	key: string,
	label: string,
	value: string
): BackdropParamSpec => ({
	default: value,
	key,
	kind: "color",
	label,
});
export const colorList = (
	key: string,
	label: string,
	value: string[]
): BackdropParamSpec => ({
	default: value,
	key,
	kind: "colors",
	label,
	max: 8,
	min: 1,
});
export const slider = (
	key: string,
	label: string,
	value: number,
	min: number,
	max: number,
	step = 0.01
): BackdropParamSpec => ({
	default: value,
	key,
	kind: "number",
	label,
	max,
	min,
	step,
});
export const toggle = (
	key: string,
	label: string,
	value: boolean
): BackdropParamSpec => ({
	default: value,
	key,
	kind: "boolean",
	label,
});
export const select = (
	key: string,
	label: string,
	value: string,
	options: readonly string[]
): BackdropParamSpec => ({
	default: value,
	key,
	kind: "select",
	label,
	options,
});
