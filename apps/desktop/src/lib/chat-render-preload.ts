// The reply renderer (Streamdown, Shiki, KaTeX) is split out of the startup
// chunks; see `@ryu/blocks/desktop/agent-elements/markdown.tsx`. Warm it once
// the first paint has settled, so a restored or newly opened conversation
// renders its replies without a plain-text frame.

import { preloadMarkdown } from "@ryu/blocks/desktop/agent-elements/markdown.tsx";
import { runWhenIdle } from "@/src/lib/idle.ts";

let warmed = false;

export function warmChatRenderers(): void {
	if (warmed) {
		return;
	}
	warmed = true;
	runWhenIdle(() => {
		preloadMarkdown().catch(() => {
			// A failed warm-up is retried by the first reply that renders.
			warmed = false;
		});
	});
}
