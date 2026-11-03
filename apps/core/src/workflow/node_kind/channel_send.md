Send a message OUT to an external chat channel (Telegram / Slack /
Discord / any HTTP webhook). Unlike [`NodeKind::NotifyUser`] (which pings
org members through the in-app inbox + OS toast + mobile push), this
delivers to a third-party channel addressed by `recipient` (a Telegram
`chat_id` / `@username`, or ignored for URL-encoded webhooks).

Placement (Core vs Gateway): this decides *what runs* (fire a message on a
node) → Core. The BYO channel credential (`bot_token` / `webhook_url`) is
carried inline on the node, mirroring the swappable-channel shape of
[`ryu_notify::NotifyTarget`], whose send primitives it reuses.

`recipient`/`text` are templates (`{{input}}`, `{{nodes.<id>}}`,
`{{state.<key>}}`, `{{trigger.*}}`) resolved before delivery.
