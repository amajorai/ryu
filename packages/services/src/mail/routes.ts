// packages/services/src/mail/routes.ts
//
// Ryu Mail: routes whose writes the server deduplicates by `Idempotency-Key`.
//
// One table serves both modes:
// - hosted (packages/api/src/routers/mail.ts): `POST /inboxes/:id/send` reads
//   the header itself; reply, reply-all, forward, draft send, held-draft
//   approval and the agent send and reply routes go through
//   `sendHostedPayload`, which claims the same send ledger with it;
// - self-hosted (apps-store/mail/backend/src/api.rs): `send_message` claims
//   the key, and reply, reply-all, forward and `send_draft` hand their request
//   headers to it. Self-hosted Mail has no send approval or agent routes, so
//   `POST /drafts/{id}/approve`, `POST /agents/{agentId}/send` and
//   `POST /agents/{agentId}/messages/{messageId}/reply` are hosted-only rows
//   (the conformance test names them).
// Neither server requires the key, so every row is optional.

import type { ServiceRouteTable } from "../routes.ts";

/** Ryu Mail idempotent routes, relative to the mount. Identical for hosted and self-hosted Mail. */
export const MAIL_ROUTES: ServiceRouteTable = {
	service: "mail",
	mount: "/api/mail",
	idempotent: [
		{ method: "POST", path: "/inboxes/{id}/send", required: false },
		{
			method: "POST",
			path: "/inboxes/{id}/messages/{messageId}/reply",
			required: false,
		},
		{
			method: "POST",
			path: "/inboxes/{id}/messages/{messageId}/reply-all",
			required: false,
		},
		{
			method: "POST",
			path: "/inboxes/{id}/messages/{messageId}/forward",
			required: false,
		},
		{
			method: "POST",
			path: "/inboxes/{id}/drafts/{draftId}/send",
			required: false,
		},
		{ method: "POST", path: "/drafts/{id}/approve", required: false },
		{ method: "POST", path: "/agents/{agentId}/send", required: false },
		{
			method: "POST",
			path: "/agents/{agentId}/messages/{messageId}/reply",
			required: false,
		},
	],
};
