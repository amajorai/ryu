import type { StateModel } from "@json-render/core";
import { z } from "zod";

/** Native renderer inputs retain legacy node fields until SDK consumption. */
export interface RawRenderSpecCarrier {
	elements?: unknown;
	root?: unknown;
	state?: unknown;
}

// Arrays are object carriers at this boundary. Inspecting their entries would
// introduce reads absent from the installed renderer's legacy header check.
const nativeObjectSchema = z.custom<object>(
	(value) => Array.isArray(value) || z.object({}).safeParse(value).success
);
const rawSpecCarrierSchema = z.custom<RawRenderSpecCarrier>(
	(value) => nativeObjectSchema.safeParse(value).success
);
const rootKeySchema = z.string();
const elementsKindSchema = nativeObjectSchema.nullable();

/** Validate the actual native header without claiming to decode its nodes. */
export const renderSpecHeaderSchema = rawSpecCarrierSchema.refine(
	(spec) =>
		rootKeySchema.safeParse(spec.root).success &&
		elementsKindSchema.safeParse(spec.elements).success &&
		spec.elements !== null
);

const nativeStateSchema = z.custom<StateModel>(
	(value) => !Array.isArray(value) && z.object({}).safeParse(value).success
);

export function initialStateFor(
	value: Parameters<typeof rawSpecCarrierSchema.safeParse>[0]
): StateModel | undefined {
	const carrier = rawSpecCarrierSchema.safeParse(value);
	if (!carrier.success || Array.isArray(carrier.data)) {
		return undefined;
	}
	const state = nativeStateSchema.safeParse(carrier.data.state);
	return state.success ? state.data : undefined;
}
