import { z } from "zod";

const nativeTextSchema = z.string();

import type { NativeArtifactObservation } from "@ryu/blocks/desktop/agent-elements/native-artifact-observation.ts";
import { nativeSdkSchemaAdmits } from "@ryu/blocks/desktop/agent-elements/utils/native-sdk-admission.ts";
import type { NativeSdkValue } from "@ryu/blocks/desktop/agent-elements/utils/native-sdk-observation.ts";
import type { Artifact, ArtifactKind } from "./artifacts.ts";
import { artifactKindFromMime, clampTitle, titleFor } from "./artifacts.ts";
/** The actual in-memory view produced from a live SDK artifact. Fields not yet
 * consumed remain opaque and retain their exact original references. */
export interface LiveArtifactProjection {
	actions?: NativeSdkValue;
	content: string;
	docId?: NativeSdkValue;
	filePath?: NativeSdkValue;
	id: string;
	kind: ArtifactKind;
	language?: NativeSdkValue;
	mime?: NativeSdkValue;
	sourceMessageId: string;
	spaceId?: NativeSdkValue;
	title: string;
	url?: NativeSdkValue;
}
function nativeText(value: NativeSdkValue): value is string {
	return nativeSdkSchemaAdmits(nativeTextSchema, value);
}
function nativeOptionalText(value: NativeSdkValue): string | undefined {
	return nativeText(value) ? value : undefined;
}
const kindSchema = z.enum([
	"html",
	"svg",
	"mermaid",
	"code",
	"file",
	"space",
	"database",
]);
function isArtifactKind(value: string): value is ArtifactKind {
	return nativeSdkSchemaAdmits(kindSchema, value);
}
export function artifactFromSdkObservation(
	payload: NativeArtifactObservation | null | undefined,
	id: string,
	sourceMessageId = "tool"
): LiveArtifactProjection {
	const content = nativeText(payload?.content) ? payload.content : "";
	const declared = nativeText(payload?.kind)
		? payload.kind.toLowerCase()
		: undefined;
	const kind =
		declared && isArtifactKind(declared)
			? declared
			: artifactKindFromMime(nativeOptionalText(payload?.mime));
	const title =
		nativeText(payload?.title) && payload.title.trim()
			? clampTitle(payload.title)
			: titleFor(kind, nativeOptionalText(payload?.language) ?? "", content) ||
				"Artifact";
	return {
		id,
		sourceMessageId,
		kind,
		title,
		content,
		language: payload?.language,
		filePath: payload?.filePath,
		url: payload?.url,
		mime: payload?.mime,
		spaceId: payload?.spaceId,
		docId: payload?.docId,
		actions: payload?.actions,
	};
}

/** The artifact store is in memory; transport Artifact keeps its strict owner. */
export type ArtifactView = Artifact | LiveArtifactProjection;
