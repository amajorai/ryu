// apps/desktop/src/lib/api/chat.ts
//
// Typed client for Core's chat streaming endpoint (`/api/chat/stream`). The chat
// page drives an AI SDK `useChat` transport, so rather than owning the fetch this
// module exposes the endpoint URL + auth headers the transport needs. Centralizing
// it here keeps base-URL + bearer handling out of the page.

export {
	answerNowChat,
	cancelChat,
	chatHeaders,
	chatStreamResumeUrl,
	chatStreamUrl,
	fetchComposerPrediction,
	fetchNextPromptSuggestions,
	startProactiveOpening,
} from "@ryuhq/core-client/chat.ts";
export type { ApiTarget } from "@ryuhq/core-client/client.ts";
