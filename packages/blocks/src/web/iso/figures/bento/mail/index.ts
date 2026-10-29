import type { BentoDrawings } from "../card.ts";
import { drawing as inboxApi } from "./inbox-api.tsx";
import { drawing as rotateSecrets } from "./rotate-secrets.tsx";
import { drawing as storedMessages } from "./stored-messages.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Inbox API": inboxApi,
	"Stored messages": storedMessages,
	"Rotate secrets": rotateSecrets,
};
