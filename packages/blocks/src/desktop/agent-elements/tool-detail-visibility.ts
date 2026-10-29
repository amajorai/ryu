import {
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
// What the transcript still renders at Detail level "None" — the rung of the
// ladder that shows no tool calls and no file edits at all, leaving a pure
// messaging view. See `ChatDisplayPrefs.hideToolDetail` for the product rules.
//
// Pure (no React; shared native scalar observations only) so `bun test` can cover it, for the same reason as
// planning-visibility.ts: this predicate does not merely decide how a row looks,
// it decides whether a TURN renders at all. Getting it wrong has a specific and
// ugly failure mode — a turn kept because this said "has content" that then
// renders nothing leaves an EMPTY `MessageScrollerItem` in the transcript, which
// still occupies a scroll slot and still carries a content-visibility
// placeholder. A blank gap between two messages reads as a rendering bug, which
// is exactly what None is supposed to remove.
//
// So the same module answers both questions with one set of rules:
//   • per part — `isHiddenAtNoDetail`, used by the message list's render loop;
//   • per message — `hasVisibleContentAtNoDetail`, used to drop turns and to
//     decide whether the live "Thinking" row still belongs.
// Keep them in step with the render loop in `message-list.tsx`
// (`AssistantParts`): everything it can draw for a NON-tool part is listed in
// `rendersRegardlessOfDetail` below, and the tests pin both directions.
//
// One thing this module deliberately cannot see: the `_interrupted` flag. It is
// stamped on the MESSAGE, not into `parts`, so an interrupted turn is counted as
// visible by the caller (`isInterruptedMessage` in message-list.tsx) rather than
// here. That split is the point — turn status is not part content.

import { z } from "zod";
import { consentRequestKind } from "./tools/consent-tool.ts";
import { hasTurnEndCards } from "./turn-end-cards.ts";
import { nativeSdkSchemaAdmits } from "./utils/native-sdk-admission.ts";
import type { NativeSdkValue } from "./utils/native-sdk-observation.ts";
import { normalizeAssistantToolParts } from "./utils/tool-part-normalizer.ts";

/** The fields observed by transcript visibility, not a whole SDK part DTO.
 * Each value remains opaque until the existing scalar/business comparison. */
interface VisibilityPartObservation {
	data?: NativeSdkValue;
	errorText?: NativeSdkValue;
	mediaType?: NativeSdkValue;
	message?: NativeSdkValue;
	mimeType?: NativeSdkValue;
	state?: NativeSdkValue;
	text?: NativeSdkValue;
	toolName?: NativeSdkValue;
	type?: NativeSdkValue;
	url?: NativeSdkValue;
}
const visibilityPartObservationSchema =
	z.custom<VisibilityPartObservation>(isNativeObjectLike);
function isRecord(value: NativeSdkValue): value is VisibilityPartObservation {
	return nativeSdkSchemaAdmits(visibilityPartObservationSchema, value);
}

/**
 * Any part the transcript draws as a TOOL row: an AI SDK v5 `tool-<Name>` part,
 * a `dynamic-tool` part (ACP bridges and MCP servers arrive this way), or the
 * `data-tool-widget-available` part carrying the live app widget minted for a
 * completed tool call. The widget is tool detail too — it exists only because a
 * tool ran.
 */
export function isToolLikePart(part: NativeSdkValue): boolean {
	if (!isRecord(part)) {
		return false;
	}
	const partType = part.type;
	if (
		partType === "dynamic-tool" ||
		partType === "data-tool-widget-available"
	) {
		return true;
	}
	return isNativeText(partType) && partType.startsWith("tool-");
}

/**
 * A tool call that ended in failure. `state: "output-error"` is the AI SDK v5
 * shape; a non-empty `errorText` covers transports that set the text without
 * moving the state (the same two surfaces `ToolRenderer` reads to decide it
 * should render an error card).
 */
export function isFailedToolPart(part: NativeSdkValue): boolean {
	if (!(isRecord(part) && isToolLikePart(part))) {
		return false;
	}
	if (part.state === "output-error") {
		return true;
	}
	return isNativeText(part.errorText) && part.errorText.trim().length > 0;
}

/** A consent card part, typed or carried by a `dynamic-tool` name. */
function isConsentPart(part: NativeSdkValue): boolean {
	if (!(isRecord(part) && isNativeText(part.type))) {
		return false;
	}
	const toolName = isNativeText(part.toolName) ? part.toolName : undefined;
	return consentRequestKind(part.type, toolName) !== null;
}

/**
 * Does Detail level "None" hide this part?
 *
 * Every tool part except a failed one. `tool-TaskOutput` is hidden even when it
 * failed, because the render loop drops it unconditionally at every level (its
 * content belongs to the parent Task row) — counting it as visible here would
 * produce exactly the empty turn this module exists to prevent.
 *
 * Consent requests (`consent.connect_app` / `consent.install_plugin`) always
 * show: they are a question to the user, not tool detail, and the agent is
 * waiting on the answer.
 */
export function isHiddenAtNoDetail(part: NativeSdkValue): boolean {
	if (!isToolLikePart(part)) {
		return false;
	}
	if (isRecord(part) && part.type === "tool-TaskOutput") {
		return true;
	}
	if (isConsentPart(part)) {
		return false;
	}
	return !isFailedToolPart(part);
}

/**
 * Everything the render loop draws for a part that is NOT a tool row: assistant
 * text, an error, an inline image generation, and `file` parts (images, audio,
 * any other attachment). Deliberately an allow-list, not "anything unknown
 * renders": a normal assistant message also carries inert bookkeeping parts
 * (`step-start` and friends) that draw nothing, and treating those as content
 * would keep every empty turn on screen.
 */
function rendersRegardlessOfDetail(part: NativeSdkValue): boolean {
	if (!isRecord(part)) {
		return false;
	}
	if (part.type === "text") {
		return isNativeText(part.text) && part.text.trim().length > 0;
	}
	if (part.type === "error") {
		return isNativeText(part.message);
	}
	// Both generation surfaces, always together. Adding a media part type without
	// adding it here is silent: the part renders fine at full detail and vanishes
	// the moment tool detail is hidden, because this predicate also decides
	// whether the message counts as having content at all.
	if (
		part.type === "data-image-generation" ||
		part.type === "data-video-generation"
	) {
		return true;
	}
	if (part.type === "file") {
		// Mirrors both `file` branches of the render loop: an image part needs a
		// media type and a body, and so does the audio/attachment fallback.
		const media = part.mediaType ?? part.mimeType;
		const hasBody = isNativeText(part.url) || isNativeText(part.data);
		return isNativeText(media) && media.length > 0 && hasBody;
	}
	return false;
}

/**
 * Would this message render anything at Detail level "None"?
 *
 * Normalises first, exactly as the render loop does, so the two can never
 * disagree about a part whose input/output arrived as a JSON string.
 */
export function hasVisibleContentAtNoDetail(parts: NativeSdkValue[]): boolean {
	if (hasTurnEndCards(parts)) {
		return true;
	}
	for (const part of normalizeAssistantToolParts(parts ?? [])) {
		if (isToolLikePart(part)) {
			if (!isHiddenAtNoDetail(part)) {
				return true;
			}
			continue;
		}
		if (rendersRegardlessOfDetail(part)) {
			return true;
		}
	}
	return false;
}
