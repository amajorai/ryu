import type { BentoDrawings } from "../card.ts";
import { drawing as fourChannels } from "./four-channels.tsx";
import { drawing as optOutsAndLimits } from "./opt-outs-and-limits.tsx";
import { drawing as quoteBeforeYouSend } from "./quote-before-you-send.tsx";
import { drawing as safeRetries } from "./safe-retries.tsx";
import { drawing as signedWebhooks } from "./signed-webhooks.tsx";
import { drawing as yourOwnNumbers } from "./your-own-numbers.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Your own numbers": yourOwnNumbers,
	"Four channels": fourChannels,
	"Quote before you send": quoteBeforeYouSend,
	"Safe retries": safeRetries,
	"Opt-outs and limits": optOutsAndLimits,
	"Signed webhooks": signedWebhooks,
};
