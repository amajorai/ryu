import { createHash } from "node:crypto";

// OpenCode uses this header to associate requests with one conversation. CI sets
// OPENCODE_SESSION_ID to the repository/run pair, so retries and related calls
// in one workflow share the same conversation. Local callers get a deterministic
// context-derived ID instead of omitting the header.
const SAFE_SESSION_ID = /^[A-Za-z0-9._:/-]{1,128}$/;

const fallbackSessionId = (context) =>
	`ryu-${createHash("sha256").update(context, "utf8").digest("hex").slice(0, 32)}`;

const sessionIdFor = (context) => {
	const configured = process.env.OPENCODE_SESSION_ID?.trim();
	return configured && SAFE_SESSION_ID.test(configured)
		? configured
		: fallbackSessionId(context);
};

export const opencodeHeaders = (apiKey, context) => ({
	Authorization: `Bearer ${apiKey}`,
	"Content-Type": "application/json",
	"x-opencode-session": sessionIdFor(context),
});
