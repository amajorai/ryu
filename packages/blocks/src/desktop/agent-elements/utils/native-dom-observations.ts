import type { DynamicToolUIPart } from "ai";
import { z } from "zod";
import { nativeSdkSchemaAdmits } from "./native-sdk-admission.ts";

const callableSchema = z.function();
/** Native callable admission only; no wrapping or binding changes the actual
 * DOM method. The caller retains its original second read/call receiver. */
export function nativeSdkCallable(
	value: DynamicToolUIPart["input"] | DynamicToolUIPart["output"]
): value is z.output<typeof callableSchema> {
	return nativeSdkSchemaAdmits(callableSchema, value);
}
