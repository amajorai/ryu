# Agent Mail and Box notifications

These examples call a source service first, then publish a small metadata event
to the standalone Ryu Notify API. They keep the Mail, Box, and Notify bearer
credentials separate.

## Agent Mail

```sh
MAIL_BASE_URL=http://127.0.0.1:7996 \
MAIL_API_TOKEN=mail-secret \
MAIL_INBOX_ID=replace-me \
MAIL_TO=operator@example.com \
NOTIFY_BASE_URL=http://127.0.0.1:8092 \
NOTIFY_API_TOKEN=notify-secret \
bun run examples/notifications/agent-mail.ts
```

The script reports a successful Mail transport hand-off. It does not prove
recipient delivery and it does not copy the message body into Notify.

## Box

```sh
BOX_BASE_URL=http://127.0.0.1:8090 \
BOX_API_TOKEN=box-secret \
NOTIFY_BASE_URL=http://127.0.0.1:8092 \
NOTIFY_API_TOKEN=notify-secret \
bun run examples/notifications/box.ts
```

The script publishes the Box id and lifecycle status. It does not publish the
driver reference, command arguments, command output, preview URLs, or provider
credentials.

## Test the client

```sh
bun test examples/notifications/notifications.test.ts
```

The test injects a fetch implementation and verifies the request path, separate
bearer, and idempotency key. It does not contact Mail, Box, Notify, SMTP, or a
container runtime.
