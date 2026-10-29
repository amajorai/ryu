import type { z } from "zod";
import type { NativeSdkValue } from "./native-sdk-observation.ts";

/** Native synchronous admission uses the actual Zod parser but does not construct
 * a reportable ZodError. Error formatting inspects rejected opaque receivers
 * (including getPrototypeOf Proxy traps), unlike the original scalar checks.
 * These callers use only tested synchronous scalar schemas and native custom
 * raw-observation predicates. Complete ZodCustom ownership includes the actual
 * receiver/object/tagged/readback/widget publishers; no reconstructed DTO or
 * transformed schema output is asserted. Union/object/pipe
 * parsers are excluded: rejected branch formatting may inspect opaque values. */
type NativeAdmissionSchema =
	| z.ZodString
	| z.ZodNumber
	| z.ZodNaN
	| z.ZodLiteral
	| z.ZodEnum
	| z.ZodFunction
	| z.ZodCustom;
export function nativeSdkSchemaAdmits<S extends NativeAdmissionSchema>(
	schema: S,
	value: NativeSdkValue
): value is z.output<S> {
	const payload = { value, issues: [] };
	schema._zod.run(payload, { async: false });
	return payload.issues.length === 0;
}
