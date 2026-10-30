// apps/desktop/src/components/channels/TelegramManagedBotPanel-bot-name-tags.tsx
//
// Rich-message tag renderers for the bot name in TelegramManagedBotPanel.tsx.

import type { RichTags } from "@ryu/i18n/react";

export const BOT_NAME_TAGS: RichTags = {
	span: (chunks) => <span className="font-medium">{chunks}</span>,
};
