import { z } from "zod";
import { nativeSdkSchemaAdmits } from "./utils/native-sdk-admission.ts";
import {
	type NativeSdkValue,
	nativeSdkObjectSchema,
} from "./utils/native-sdk-observation.ts";
/** A selected live SDK receiver, not a fully decoded HostArtifact. Getters are
 * intentionally deferred until the actual field consumer reads them. */
export interface NativeArtifactObservation {
	actions?: NativeSdkValue;
	content?: NativeSdkValue;
	docId?: NativeSdkValue;
	filePath?: NativeSdkValue;
	kind?: NativeSdkValue;
	language?: NativeSdkValue;
	mime?: NativeSdkValue;
	spaceId?: NativeSdkValue;
	title?: NativeSdkValue;
	url?: NativeSdkValue;
}
interface NativeArtifactInputObservation extends NativeArtifactObservation {
	artifact?: NativeSdkValue;
}
const inputCarrier = z.custom<NativeArtifactInputObservation>((value) =>
	nativeSdkSchemaAdmits(nativeSdkObjectSchema, value)
);
/** Admission proves only that the selected value is the original native object
 * receiver. It does not inspect, enumerate, or validate optional fields. */
const artifactObservation = z.custom<NativeArtifactObservation>((value) =>
	nativeSdkSchemaAdmits(nativeSdkObjectSchema, value)
);
export function artifactObservationFromInput(
	input: NativeSdkValue
): NativeArtifactObservation | null {
	const parsed = inputCarrier.safeParse(input);
	if (!parsed.success) {
		return null;
	}
	const value = parsed.data;
	const nested = value.artifact;
	const selected = artifactObservation.safeParse(nested);
	if (selected.success) {
		return selected.data;
	}
	if (value.kind || value.content || value.title || value.url) {
		const result = artifactObservation.safeParse(value);
		return result.success ? result.data : null;
	}
	return null;
}
