// The account-access sections' empty and load-failure notices, held as named
// English copy so the catalog extractor collects them. The catalog itself
// stays English (it also feeds `--json`); the TUI panel and the CLI picker
// translate a notice when they render it.

export const APPS_LOAD_FAILED = "Couldn't load your apps.";
export const COMPOSIO_MISSING = "Composio isn't set up on this node.";
export const CONNECTED_APPS_LOAD_FAILED = "Couldn't load your connected apps.";
export const MCP_SERVERS_LOAD_FAILED = "Couldn't load your MCP servers.";
export const MODEL_PROVIDERS_LOAD_FAILED =
	"Couldn't load your model providers.";
export const NO_CONNECTED_APPS = "No connected apps yet.";
export const NO_MCP_SIGN_INS = "No MCP servers signed in yet.";
export const NO_OWN_LOGINS =
	"No accounts yet. The agent adds one when it signs up for a site.";
export const NO_PROVIDERS_YET = "No provider keys yet.";
export const NO_SAVED_SERVICES = "No services use your saved keys yet.";
export const OWN_APPS_LOAD_FAILED =
	"Couldn't load this agent's connected apps.";
export const OWN_LOGINS_LOAD_FAILED = "Couldn't load this agent's accounts.";
