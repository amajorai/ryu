import { attachedImageSchema } from "@ryu/blocks/desktop/agent-elements/attached-image.ts";
import { z } from "zod";
import type { AttachedImage } from "@/components/agent-elements/input-bar.tsx";
import type { RecentActivityBundle } from "@/src/lib/api/clips.ts";
import type { ShadowContext } from "@/src/lib/api/shadow.ts";
import { neutralize, UNTRUSTED_NOTICE } from "@/src/lib/untrusted.ts";

const MAX_CAPTURED_TEXT_CHARS = 64_000;

export const CLIPS_QUICK_ATTACH_EVENT = "ryu:clips-quick-attach";

const quickAttachDestinationSchema = z.enum([
	"automatic",
	"current_chat",
	"new_chat",
]);
export type ClipsQuickAttachDestination = z.output<
	typeof quickAttachDestinationSchema
>;
const quickAttachStatusSchema = z.object({
	destination: quickAttachDestinationSchema,
});
type QuickAttachDestinationInput = Parameters<
	typeof quickAttachDestinationSchema.parse
>[0];
type QuickAttachStatusInput = Parameters<
	typeof quickAttachStatusSchema.parse
>[0];

export type ClipsQuickAttachTarget =
	| "current_chat"
	| "new_chat"
	| "missing_current_chat";

export function parseClipsQuickAttachDestination(
	value: QuickAttachDestinationInput
): ClipsQuickAttachDestination | undefined {
	const parsed = quickAttachDestinationSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}
export function clipsQuickAttachDestinationFromStatus(
	value: QuickAttachStatusInput
): ClipsQuickAttachDestination | undefined {
	const parsed = quickAttachStatusSchema.safeParse(value);
	return parsed.success ? parsed.data.destination : undefined;
}

export interface ClipsQuickAttachRequest {
	images: AttachedImage[];
	prompt?: string;
	tabId: string;
}

const quickAttachRequestSchema = z.object({
	images: z.array(attachedImageSchema),
	prompt: z.string().optional(),
	tabId: z.string().min(1),
}) satisfies z.ZodType<ClipsQuickAttachRequest>;
type QuickAttachRequestInput = Parameters<
	typeof quickAttachRequestSchema.parse
>[0];

export function parseClipsQuickAttachRequest(
	value: QuickAttachRequestInput
): ClipsQuickAttachRequest | undefined {
	const parsed = quickAttachRequestSchema.safeParse(value);
	if (!parsed.success) {
		return undefined;
	}
	return {
		images: parsed.data.images,
		prompt: parsed.data.prompt,
		tabId: parsed.data.tabId,
	};
}

export function isChatRoute(path: string): boolean {
	return path === "/chat" || path.startsWith("/chat/agent/");
}

export function resolveClipsQuickAttachTarget(
	destination: ClipsQuickAttachDestination,
	hasCurrentChat: boolean
): ClipsQuickAttachTarget {
	if (destination === "new_chat") {
		return "new_chat";
	}
	if (destination === "current_chat") {
		return hasCurrentChat ? "current_chat" : "missing_current_chat";
	}
	return hasCurrentChat ? "current_chat" : "new_chat";
}

/** Build the visible, prompt-injection-safe context seeded into a new chat. */
export function buildClipsQuickAttachPrompt(
	bundle: Pick<RecentActivityBundle, "summary" | "transcript">,
	context: ShadowContext | null
): string | undefined {
	const sections = [
		["Activity summary", bundle.summary],
		["Window focus timeline", bundle.transcript ?? ""],
		[
			"Accessibility text from the frontmost window",
			context?.accessibility_text,
		],
		["Selected text", context?.selected_text],
		["Visible OCR text", context?.screen_text],
	]
		.map(([label, value]) => {
			const text = value?.trim().slice(0, MAX_CAPTURED_TEXT_CHARS);
			return text ? `${label}:\n${text}` : "";
		})
		.filter(Boolean);
	if (sections.length === 0) {
		return undefined;
	}
	return [
		"Ryu Clips captured this context alongside the attached images.",
		UNTRUSTED_NOTICE,
		neutralize(sections.join("\n\n")),
	].join("\n\n");
}
