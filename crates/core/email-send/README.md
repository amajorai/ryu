# ryu-email-send

**BYOK SMTP email sink** for Ryu self-host — the outbound-email delivery leg for
policy/monitor alerts (budget/firewall alerts, monitor notifications) and, later,
agent-inbox send.

## Role in the decomposition

An extracted **Core capability crate**, compiled into `apps/core` as the in-process
default. Delivery is *what runs* → **Core**, not policy: the Gateway decides an alert
fires; the node opens the socket and sends.

Zero dependency on `apps/core`. Secret custody stays kernel-side: the SMTP password is
never held here — Core injects a resolver via `set_password_resolver` (backed by its
`smtp_auth` BYO-key store, prefs-first + `RYU_SMTP_PASSWORD` env). **That resolver is
the seam.**

## Nothing hardcoded — the swappable transport

There is **no default provider**. The transport is a BYO SMTP relay resolved
prefs-first (the desktop Settings SMTP card writes non-secret `TransportPrefs` under
`smtp-transport`) then `RYU_SMTP_*` env for headless setups. With no relay configured
the sink is a fail-safe **no-op** (`resolve_transport` returns `None`) and callers skip
email — never a plaintext leak. SMTP is one swappable sink; the SES agent-inbox path
(`packages/mail`) is another.

## Key surface

- `set_password_resolver` / `set_transport` / `apply_transport_prefs_json` /
  `current_transport_prefs` — wiring from Core prefs.
- `resolve_transport` → `EmailTransportConfig` — effective config (prefs, else env).
- `OutboundEmail` — the rich builder: multi-recipient, cc/bcc/reply-to, text+html
  multipart, RFC 5322 threading headers, and attachments. Shared by the agent-inbox
  send path and the one-line alert helper.
- `send_email` — sends over a transport, returns the generated Message-ID; bounded by
  a 30s `SEND_TIMEOUT` (lettre has no built-in timeout).
- `send_email_alert` — thin single-recipient plain-text helper.
- `EmailError` — `NotConfigured` / `InvalidAddress` / `Build` / `Transport` / `Send` /
  `Timeout`.

## Consumed as

Compiled-into-Core crate; called by Core's alert + inbox-send paths.

Deps: lettre (tokio1-native-tls, smtp-transport, builder), tokio (time),
serde/serde_json.
