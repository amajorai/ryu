import { z } from "zod";

const EXTENSION_QUICK_MESSAGE_KEY = "ryu_quick_message";
export const EXTENSION_QUICK_MESSAGE_EVENT = "ryu:extension-quick-message-seed";
export const EXTENSION_DESKTOP_LAYOUT_READY_EVENT = "ryu:desktop-layout-ready";

export interface ExtensionQuickMessageEventDetail {
	seed: string;
}

export function takeExtensionQuickMessageSeed(
	storage: Pick<Storage, "getItem" | "removeItem">
): string | undefined {
	try {
		const seed = storage.getItem(EXTENSION_QUICK_MESSAGE_KEY);
		if (seed === null) {
			return undefined;
		}
		storage.removeItem(EXTENSION_QUICK_MESSAGE_KEY);
		return seed.trim() ? seed : undefined;
	} catch {
		return undefined;
	}
}

export function extensionQuickMessageSeedFromEvent(
	event: Event
): string | undefined {
	if (!(event instanceof CustomEvent)) {
		return undefined;
	}
	const result = z
		.object({ seed: z.string().refine((seed) => Boolean(seed.trim())) })
		.safeParse(event.detail);
	return result.success ? result.data.seed : undefined;
}

export function extensionQuickMessageTab(seed: string) {
	if (!seed.trim()) {
		return undefined;
	}
	return {
		options: {
			forceNew: true,
			initialPrompt: seed,
			title: "New chat",
		},
		path: "/chat",
	} as const;
}
