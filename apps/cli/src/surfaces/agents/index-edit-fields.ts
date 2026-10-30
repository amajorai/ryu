import type { FieldDef } from "./index-shared.tsx";

// Keep the terminal editor useful for the settings the Desktop agent editor
// writes through the same Core contract. Tools, skills, Composio grants, and
// sampling use dedicated editors instead of lossy comma-separated text fields.
export const AGENT_EDIT_FIELDS: FieldDef[] = [
	{ key: "name", label: "name", placeholder: "Agent name" },
	{
		key: "title",
		label: "title",
		placeholder: "Title in Chat",
	},
	{
		key: "engine",
		label: "engine",
		placeholder: "e.g. acp:claude",
	},
	{ key: "model", label: "model", placeholder: "Model id" },
	{ key: "description", label: "desc", placeholder: "Description" },
	{
		key: "systemPrompt",
		label: "prompt",
		placeholder: "Instructions",
	},
	{
		key: "personaDisplayName",
		label: "persona name",
		placeholder: "Reply name",
	},
	{
		key: "personaTone",
		label: "persona tone",
		placeholder: "friendly / custom",
	},
	{
		key: "orchestrator",
		kind: "toggle",
		label: "delegate agents",
		placeholder: "",
	},
	{
		key: "canCreateAgents",
		kind: "toggle",
		label: "create agents",
		placeholder: "",
	},
	{
		key: "tools",
		kind: "picker",
		label: "tools",
		placeholder: "",
	},
	{
		key: "skills",
		kind: "picker",
		label: "skills",
		placeholder: "",
	},
	{
		key: "inference",
		kind: "sampling",
		label: "sampling",
		placeholder: "",
	},
	{
		key: "identity",
		kind: "identity",
		label: "works as",
		placeholder: "",
	},
	{
		key: "accountAccess",
		kind: "access",
		label: "account access",
		placeholder: "",
	},
];
