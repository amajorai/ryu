import type { LiteralMessage } from "@ryu/i18n/react";
import type { ModelEngineChoice } from "@/src/lib/model-engine.ts";

/**
 * The line under an installed model's "Use & chat" button: what pressing it
 * will do on this node. The engine name sits inside whole sentences so each
 * language can place it where its grammar needs it.
 */
export function activeModelHelper(
	tl: LiteralMessage,
	{
		engineChoice,
		engineCheckFailed,
		unavailable,
	}: {
		engineChoice: ModelEngineChoice | null | undefined;
		engineCheckFailed: boolean;
		unavailable: boolean;
	}
): string {
	if (engineCheckFailed) {
		return tl("Could not check this node's engines. Try setup again.");
	}
	if (engineChoice?.installState === "installed") {
		return tl("Ready on {engine}.", { engine: engineChoice.displayName });
	}
	if (engineChoice?.installState === "installing") {
		return tl("{engine} is already installing on this node.", {
			engine: engineChoice.displayName,
		});
	}
	if (engineChoice) {
		return tl("{engine} will be installed if this node needs it.", {
			engine: engineChoice.displayName,
		});
	}
	if (unavailable) {
		return tl(
			"This node has no compatible local engine for this model format."
		);
	}
	return tl("Ryu will open a new chat with this model selected.");
}
