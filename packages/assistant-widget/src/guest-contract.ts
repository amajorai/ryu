import { z } from "zod";

/** Same-origin path the widget posts guest turns to. */
export const GUEST_CHAT_PATH = "/api/assistant/guest";
export const MAX_GUEST_QUESTION_CHARS = 4000;

const optionalString = z.string().or(z.undefined()).catch(undefined);

/** One guest turn: only the question. The server picks the model. */
export const guestChatInputSchema = z.object({
	question: z.string().trim().min(1).max(MAX_GUEST_QUESTION_CHARS),
});
const error = z.object({ message: optionalString });
export const guestChatErrorSchema = z.object({ error });
const delta = z
	.object({ content: optionalString })
	.or(z.undefined())
	.catch(undefined);
const choice = z.object({ delta }).or(z.undefined()).catch(undefined);
/** One OpenAI-compatible stream frame, as re-emitted by the guest route. */
export const guestChatStreamSchema = z.object({
	error: error.or(z.undefined()).catch(undefined),
	choices: z.array(choice).or(z.undefined()).catch(undefined),
});
/** Whether this site has a guest chat lane configured. */
export const guestChatStatusSchema = z.object({ available: z.boolean() });
