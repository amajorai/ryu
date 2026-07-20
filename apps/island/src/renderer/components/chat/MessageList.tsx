// Re-export shim: the transcript view now lives in @ryu/blocks/island. The
// block's structural `IslandChatMessage` type matches this app's `ChatMessage`
// (id/role/content/streaming), so callers pass the message list unchanged.

export { MessageList } from "@ryu/blocks/island/chat/message-list";
