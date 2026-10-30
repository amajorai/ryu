import {
	Activity01Icon,
	ApiIcon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	BubbleChatIcon,
	CodeCircleIcon,
	CpuIcon,
	Delete01Icon,
	Dollar01Icon,
	FlowConnectionIcon,
	GitBranchIcon,
	Key01Icon,
	LaptopIcon,
	Package01Icon,
	Plug01Icon,
	PolicyIcon,
	Refresh01Icon,
	Share08Icon,
	Shield01Icon,
	SparklesIcon,
	SquareLock01Icon,
	UserGroupIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { GatewaySection } from "@/src/store/useGatewayDialog.ts";

/**
 * The built-in gateway sections.
 *
 * `value` is a deep-link key (`openGateway("keys")`, `?section=privacy`, the
 * command palette) — **never rename one**. `label` and `hint` are free to change
 * and are written for someone who has never read a routing doc: the label says
 * what it is, the hint says what it's for, and `keywords` keeps the old
 * developer-facing names ("guardrails", "BYOK", "evals", "audit") searchable so
 * renaming costs nobody their muscle memory.
 */
export const GATEWAY_SECTIONS: {
	hint: string;
	icon: IconSvgElement;
	keywords?: string;
	label: string;
	/**
	 * Show `hint` under the pane title. Only for panes whose name alone is
	 * ambiguous; everywhere else the hint stays a search keyword.
	 */
	showHint?: true;
	value: GatewaySection;
}[] = [
	{
		value: "overview",
		label: "Overview",
		hint: "Is everything running, and how much has it done.",
		icon: Activity01Icon,
		keywords: "health status metrics requests cache",
	},
	{
		value: "workspace",
		label: "Team & workspace",
		hint: "Who can use this node, and what they're allowed to do.",
		icon: UserGroupIcon,
		keywords: "members seats roles org permissions",
	},
	{
		value: "defaults",
		label: "Default agent & model",
		hint: "What every new chat and agent starts with.",
		icon: SparklesIcon,
		keywords: "defaults fallback global agent model",
	},
	{
		value: "providers",
		label: "AI providers",
		hint: "The AI services this node can use, and which models they offer.",
		icon: CpuIcon,
		keywords: "providers llm openai anthropic local models",
	},
	{
		value: "keys",
		label: "API keys",
		hint: "Your own provider keys, and the keys apps use to reach this node.",
		icon: Key01Icon,
		keywords:
			"keys byok api token composio replicate fal secrets rotation additional account keys",
	},
	{
		value: "access",
		label: "Connections",
		hint: "Legacy route for the unified Connections hub.",
		icon: Key01Icon,
		keywords:
			"pair pairing device token access approve revoke browser remote security auth",
	},
	{
		value: "computer",
		showHint: true,
		label: "Device settings",
		hint: "Choose how Ghost may use this device, including locked-session access.",
		icon: LaptopIcon,
		keywords:
			"computer computers ghost computer use locked lock background accessibility screen recording",
	},
	{
		value: "permissions",
		label: "Permissions",
		hint: "Give a team access to one space, or take it away from someone.",
		icon: UserGroupIcon,
		keywords:
			"permissions acl roles teams grant deny access overwrite rbac who can",
	},
	{
		value: "budgets",
		label: "Spending limits",
		hint: "Cap what can be spent, and what happens when a cap is hit.",
		icon: Dollar01Icon,
		keywords: "budget spend limit cost cap alerts",
	},
	{
		value: "guardrails",
		label: "Safety filters",
		hint: "Block unsafe or private content before it reaches a model.",
		icon: Shield01Icon,
		keywords:
			"guardrails firewall pii moderation safety filter egress agents routing governed bypass",
	},
	{
		value: "traffic-map",
		showHint: true,
		label: "Traffic map",
		hint: "Watch requests flow through every check to a provider.",
		icon: FlowConnectionIcon,
		keywords:
			"traffic map canvas live topology flow requests blocked layer floor policy provider pulses",
	},
	{
		value: "policies",
		showHint: true,
		label: "Guardrail policies",
		hint: "Write a policy once, then assign it to teams, members, keys or agents.",
		icon: PolicyIcon,
		keywords:
			"guardrail policy policies named assign organization team member key agent permissions effective",
	},
	{
		value: "runtime",
		showHint: true,
		label: "Agent runtime",
		hint: "Bound ACP session lifetime, parallel agents, and sleep behavior on this node.",
		icon: CpuIcon,
		keywords:
			"acp agents idle timeout garbage collection memory oom concurrency parallel keep awake sleep power",
	},
	{
		value: "hooks",
		showHint: true,
		label: "Hooks",
		hint: "Review and control lifecycle automation from config and plugins.",
		icon: CodeCircleIcon,
		keywords:
			"hooks lifecycle trust plugin config automation review enable disable",
	},
	{
		value: "routing",
		label: "Model routing",
		hint: "Rules that send a request to a different model than the one asked for.",
		icon: GitBranchIcon,
		keywords:
			"routing smart route fallback rewrite mapping credit balance quota low threshold cheaper",
	},
	{
		value: "integrations",
		label: "Integrations",
		hint: "Third-party apps your agents can act through.",
		icon: Share08Icon,
		keywords: "integrations composio apps oauth connect",
	},
	{
		value: "network",
		label: "Network",
		hint: "Connect this node with Tailscale, Headscale, or a short-lived Tailcat address.",
		icon: Share08Icon,
		keywords:
			"network mesh tailscale headscale tailcat tailnet vpn remote peers",
	},
	// Moved from the App Settings dialog (node-level Core infra, not apps).
	{
		value: "connections",
		label: "Connections",
		hint: "Control this device, connect other nodes, and manage SSH hosts.",
		icon: Share08Icon,
		keywords: "connections accounts linked identities devices nodes ssh remote",
	},
	{
		value: "email-alerts",
		label: "Email & alerts",
		hint: "Where this node sends mail, and what it notifies you about.",
		icon: BubbleChatIcon,
		keywords: "email smtp alerts notifications",
	},
	{
		value: "usage",
		label: "Usage & cost",
		hint: "What has been spent, by whom, on which model.",
		icon: Dollar01Icon,
		keywords: "usage cost spend tokens billing report",
	},
	{
		value: "audit",
		label: "Activity log",
		hint: "Every request this node handled, in raw form.",
		icon: Activity01Icon,
		keywords: "audit log trace requests history",
	},
	{
		value: "api",
		label: "API & traffic",
		hint: "Point OpenAI, Anthropic or Gemini clients at this node, manage its API keys, and watch requests live.",
		icon: ApiIcon,
		keywords:
			"api endpoint url server compatible openai anthropic gemini base copy token keys live traffic dashboard sse",
	},
	{
		value: "mcp",
		label: "MCP server",
		hint: "The Model Context Protocol servers this node runs, and the tools they expose.",
		icon: Plug01Icon,
		keywords: "mcp model context protocol server tools claude cursor stdio",
	},
	{
		value: "git",
		label: "Git",
		hint: "Choose defaults for branches, commits, pushes, and pull requests.",
		icon: GitBranchIcon,
		keywords:
			"git branch prefix merge squash force push draft review commit pull request",
	},
	{
		value: "worktrees",
		label: "Worktrees",
		hint: "Choose where managed worktrees live and when old ones are removed.",
		icon: GitBranchIcon,
		keywords: "worktree root fetch upstream auto delete cleanup retention",
	},
	{
		value: "environments",
		showHint: true,
		label: "Environments",
		hint: "Set up project environments for worktrees and agent actions.",
		icon: Package01Icon,
		keywords: "environment setup cleanup variables actions project worktree",
	},
	{
		value: "cloud-environments",
		showHint: true,
		label: "Cloud environments",
		hint: "Configure repository setup, internet access, and personal vault entries.",
		icon: Package01Icon,
		keywords: "cloud environment repository install script vault secret vpn",
	},
	{
		value: "import",
		showHint: true,
		label: "Import agents",
		hint: "Preview setup from Claude, Codex, Cursor and more before bringing it in.",
		icon: ArrowDown01Icon,
		keywords:
			"import sync claude codex cursor skills mcp plugins threads sessions",
	},
	{
		value: "export",
		showHint: true,
		label: "Export Ryu",
		hint: "Write an explicit, versioned Ryu bundle to a selected agent root.",
		icon: ArrowUp01Icon,
		keywords: "export sync bundle conversations sessions acp resume replay",
	},
	{
		value: "evals",
		label: "Quality tests",
		hint: "Score models against a set of prompts and compare the results.",
		icon: Activity01Icon,
		keywords: "evals eval quality benchmark scoring tests",
	},
	{
		value: "privacy",
		label: "Privacy",
		hint: "What leaves this device, and what stays on it.",
		icon: SquareLock01Icon,
		keywords: "privacy telemetry analytics learning data",
	},
	{
		value: "storage",
		label: "Storage",
		hint: "Where files, models, and databases are kept on this device.",
		icon: Key01Icon,
		// "parsing"/"parser"/"pdf" search here on purpose. There is no Document
		// parsing section any more — the parser is bound from the node dropdown's
		// Toolkits row like every other swappable capability, and the only thing
		// that tab owned alone (the node's upload ceiling) is a card on this one.
		keywords:
			"storage disk path database models cache upload limit size parsing parser document pdf docx",
	},
	{
		value: "encryption",
		label: "Encryption",
		hint: "How this device holds its key, and what is encrypted at rest.",
		icon: SquareLock01Icon,
		keywords:
			"encryption encrypted at rest master key keychain custody sealed plaintext coverage",
	},
	{
		value: "updates",
		label: "Updates",
		hint: "Which version each part is on, and how updates are installed.",
		icon: Refresh01Icon,
		keywords: "updates version upgrade channel release",
	},
	{
		value: "health",
		label: "Diagnostics",
		hint: "Start, stop, and check each part when something looks wrong.",
		icon: Shield01Icon,
		keywords: "health diagnostics preflight restart status logs",
	},
	{
		value: "onboarding",
		label: "Onboarding",
		hint: "Choose personal or team context for this node, or run setup again.",
		icon: SparklesIcon,
		keywords: "onboarding setup personal team company context reset first run",
	},
	{
		value: "danger",
		label: "Danger zone",
		hint: "Reset or wipe this node. Read twice before clicking.",
		icon: Delete01Icon,
		keywords: "danger reset wipe delete factory",
	},
];
