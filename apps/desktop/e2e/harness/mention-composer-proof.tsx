import { ChatDisplayPrefsProvider } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import { InputBar } from "@ryu/blocks/desktop/agent-elements/input-bar.tsx";
import { MentionToken } from "@ryu/blocks/desktop/agent-elements/mention-token.tsx";
import { Avatar, AvatarFallback } from "@ryu/ui/components/avatar.tsx";
import { type CSSProperties, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "../../components/agent-elements/markdown.tsx";
import type { MentionItem as TranscriptMentionItem } from "../../components/agent-elements/types.ts";
import { MentionMenu } from "../../src/components/chat/MentionMenu.tsx";
import { SlashCommandAutocomplete } from "../../src/components/chat/SlashCommandAutocomplete.tsx";
import {
	buildComposioMentionSources,
	buildMentionGroups,
	CHAT_MENTION_KINDS,
} from "../../src/lib/mentions/candidates.ts";
import { selectHumanNotificationTargets } from "../../src/lib/mentions/human-notification.ts";
import type {
	MentionItem,
	MentionSources,
} from "../../src/lib/mentions/types.ts";
import {
	applySlashCommandOption,
	parseSlashMenuState,
	type SlashCommand,
	type SlashCommandOptionSelection,
} from "../../src/lib/slash-commands.ts";
import proofStyles from "./mention-composer-proof.module.css";
import "../../src/index.css";

function mentionTokenItem(item: MentionItem): TranscriptMentionItem {
	const Icon = item.icon;
	return { ...item, icon: Icon ? <Icon className="size-3.5" /> : undefined };
}

const CONNECTIONS = [
	{ active: true, toolkit: "github" },
	{ active: false, toolkit: "slack" },
];

const TOOLKITS = [
	{
		description: "Issues and repositories",
		name: "GitHub",
		slug: "github",
	},
	{ description: "Messages and channels", name: "Slack", slug: "slack" },
];

const PROOF_APP_ICON = (color: string, label: string) => {
	const style: CSSProperties & { "--proof-app-color": string } = {
		"--proof-app-color": color,
	};
	return (
		<span
			aria-label={`${label} app icon`}
			className={`size-3.5 shrink-0 ${proofStyles.appIcon}`}
			style={style}
		/>
	);
};

const HUMAN_AVATAR = (
	<Avatar aria-label="Ada Lovelace avatar" size="xs">
		<AvatarFallback>AL</AvatarFallback>
	</Avatar>
);

const HUMAN_MENTION: MentionItem = {
	description: "ada@example.com · Platform",
	id: "user-ada",
	kind: "user",
	label: "Ada Lovelace",
	visualIcon: HUMAN_AVATAR,
};

const TRANSCRIPT_MENTIONS: TranscriptMentionItem[] = [
	{ id: "claude", kind: "agent", label: "Claude Code" },
	{
		accentColor: "#6366f1",
		id: "browser",
		kind: "app",
		label: "Browser",
		visualIcon: PROOF_APP_ICON("#6366f1", "Browser"),
	},
	{
		accentColor: "#f59e0b",
		id: "com.ryu.canvas:canvas:brief",
		kind: "app-item",
		label: "Design brief",
		target: { path: "/spaces/space-1/app/canvas/brief" },
		visualIcon: PROOF_APP_ICON("#f59e0b", "Canvas"),
	},
	{ id: "architecture", kind: "chat", label: "Architecture notes" },
	{ id: "platform", kind: "team", label: "Platform team" },
	{ id: "deploy", kind: "workflow", label: "Build and deploy" },
	{ id: "personal", kind: "space", label: "Personal space" },
	{
		id: "space-1:launch-plan",
		kind: "page",
		label: "Launch plan",
		target: { path: "/spaces/space-1/doc/launch-plan" },
	},
	{
		id: "plain",
		kind: "output-style",
		label: "Plain text",
		target: { path: "/settings" },
	},
	{ id: "research", kind: "skill", label: "Research" },
	{ id: "local-mcp", kind: "mcp", label: "Local MCP" },
	{ id: "/workspace/ryu-closed", kind: "folder", label: "ryu-closed" },
	{ id: "github", kind: "integration", label: "GitHub" },
	{
		accentColor: "#ec4899",
		id: "double-check",
		kind: "plugin",
		label: "Double-check",
		visualIcon: PROOF_APP_ICON("#ec4899", "Double-check"),
	},
];

const TRANSCRIPT_MENTION_TEXT = TRANSCRIPT_MENTIONS.map(
	(item) => `@${item.label}`
).join(" ");

function TranscriptMentionProof() {
	const [opened, setOpened] = useState<string[]>([]);
	const record = (role: "user" | "agent", item: TranscriptMentionItem) => {
		setOpened((current) =>
			current.includes(`${role}:${item.kind}:${item.id}`)
				? current
				: [...current, `${role}:${item.kind}:${item.id}`]
		);
	};
	const recordWebsite = (role: "user" | "agent", url: string) => {
		setOpened((current) =>
			current.includes(`${role}:website:${url}`)
				? current
				: [...current, `${role}:website:${url}`]
		);
	};
	const expected = TRANSCRIPT_MENTIONS.flatMap((item) => [
		`user:${item.kind}:${item.id}`,
		`agent:${item.kind}:${item.id}`,
	]);
	const expectedLinks = [
		"user:website:https://example.com/mention-proof",
		"agent:website:https://example.com/mention-proof",
	];
	const isVerified = [...expected, ...expectedLinks].every((key) =>
		opened.includes(key)
	);

	return (
		<section
			aria-label="Transcript mention link proof"
			className={`mt-6 rounded-3xl border ${proofStyles.transcriptBorder} ${proofStyles.transcriptSurface} p-5 shadow-2xl`}
			data-testid="transcript-mention-proof"
		>
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<p className="font-semibold text-white text-xl">
						Transcript destinations
					</p>
					<p className={`mt-1 max-w-3xl ${proofStyles.mutedText} text-sm`}>
						The same Markdown renderer is mounted in a user bubble and an agent
						bubble. Every resolved entity mention and website link below must
						open through its role-specific callback.
					</p>
				</div>
				<div
					className={`rounded-full px-3 py-1 font-semibold text-xs ${isVerified ? `${proofStyles.verifiedSurface} ${proofStyles.verifiedText}` : `${proofStyles.pendingSurface} ${proofStyles.pendingText}`}`}
					data-testid="transcript-proof-status"
				>
					{isVerified
						? "VERIFIED · all destinations opened"
						: `${opened.length}/${expected.length + expectedLinks.length} opened`}
				</div>
			</div>

			<div className="mt-5 grid gap-4 lg:grid-cols-2">
				<div
					className={`rounded-2xl border border-white/10 ${proofStyles.transcriptBubble} p-4`}
				>
					<p
						className={`mb-2 font-semibold ${proofStyles.accentText} text-xs uppercase ${proofStyles.sectionTracking}`}
					>
						User message
					</p>
					<div data-testid="user-transcript-markdown">
						<Markdown
							content={`${TRANSCRIPT_MENTION_TEXT} [Open website](https://example.com/mention-proof)`}
							mentionItems={TRANSCRIPT_MENTIONS}
							onOpenLink={(url) => recordWebsite("user", url)}
							onOpenMention={(item) => record("user", item)}
						/>
					</div>
				</div>
				<div
					className={`rounded-2xl border border-white/10 ${proofStyles.transcriptBubble} p-4`}
				>
					<p
						className={`mb-2 font-semibold ${proofStyles.accentText} text-xs uppercase ${proofStyles.sectionTracking}`}
					>
						Agent message
					</p>
					<div data-testid="agent-transcript-markdown">
						<Markdown
							content={`${TRANSCRIPT_MENTION_TEXT} [Open website](https://example.com/mention-proof)`}
							mentionItems={TRANSCRIPT_MENTIONS}
							onOpenLink={(url) => recordWebsite("agent", url)}
							onOpenMention={(item) => record("agent", item)}
						/>
					</div>
				</div>
			</div>

			<p
				className={`mt-4 ${proofStyles.metadataText} text-xs`}
				data-testid="transcript-proof-log"
			>
				{opened.length > 0
					? `Opened: ${opened.join(" · ")}`
					: "Click every @ mention and website link in both bubbles to complete the proof."}
			</p>
		</section>
	);
}

function sources(configured: boolean): MentionSources {
	return {
		agents: [{ id: "claude", name: "Claude Code" }],
		apps: [
			{
				accentColor: "#6366f1",
				description: "Installed companion app",
				id: "browser",
				name: "Browser",
				visualIcon: PROOF_APP_ICON("#6366f1", "Browser"),
			},
		],
		appItems: [
			{
				accentColor: "#f59e0b",
				description: "Canvas · document",
				id: "com.ryu.canvas:canvas:brief",
				name: "Design brief",
				target: { path: "/spaces/space-1/app/canvas/brief" },
				visualIcon: PROOF_APP_ICON("#f59e0b", "Canvas"),
			},
		],
		chats: [],
		folders: [],
		integrations: buildComposioMentionSources(
			configured,
			CONNECTIONS,
			TOOLKITS
		),
		mcp: [],
		plugins: [
			{
				accentColor: "#ec4899",
				description: "Installed composer extension",
				id: "double-check",
				name: "Double-check",
				visualIcon: PROOF_APP_ICON("#ec4899", "Double-check"),
			},
		],
		skills: [{ id: "research", name: "Research" }],
		spaces: [],
		pages: [
			{
				description: "Personal space · Page",
				id: "space-1:launch-plan",
				name: "Launch plan",
				target: { path: "/spaces/space-1/doc/launch-plan" },
			},
		],
		outputStyles: [
			{
				description: "Short and direct",
				id: "plain",
				name: "Plain text",
				target: { path: "/settings" },
			},
		],
		teams: [],
		users: [],
		workflows: [],
	};
}

function MentionState({
	configured,
	label,
}: {
	configured: boolean;
	label: string;
}) {
	const anchorRef = useRef<HTMLTextAreaElement | null>(null);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const mentionSources = useMemo(() => sources(configured), [configured]);
	const groups = useMemo(
		() => buildMentionGroups(mentionSources, query),
		[mentionSources, query]
	);
	const [menuOpen, setMenuOpen] = useState(true);

	const handleSelect = (item: MentionItem) => {
		setSelected(`@${item.label}`);
	};

	return (
		<section
			aria-label={label}
			className="flex min-h-[34rem] flex-1 flex-col rounded-3xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl"
			data-configured={configured}
			data-testid={configured ? "configured-state" : "unconfigured-state"}
		>
			<div className="mb-4 flex items-start justify-between gap-4">
				<div>
					<p className="font-semibold text-white text-xl">{label}</p>
					<p className={`mt-1 ${proofStyles.mutedText} text-sm`}>
						{configured
							? "BYOK or managed subscription/proxy is available"
							: "No Composio credential is available on this node"}
					</p>
					{selected ? (
						<p
							className={`mt-2 font-medium ${proofStyles.accentText} text-sm`}
							data-testid={`${configured ? "configured" : "unconfigured"}-header-selection`}
						>
							Selected {selected}
						</p>
					) : null}
				</div>
				<span
					className={`rounded-full px-3 py-1 font-semibold text-xs ${configured ? `${proofStyles.verifiedSurface} ${proofStyles.verifiedText}` : `${proofStyles.neutralBadge} ${proofStyles.mutedText}`}`}
				>
					{configured ? "CONNECTED" : "HIDDEN"}
				</span>
			</div>

			<div className="relative flex-1">
				<textarea
					aria-label={`${label} composer`}
					className={`min-h-14 w-full resize-none rounded-2xl border border-white/10 ${proofStyles.composerSurface} px-4 py-3 ${proofStyles.primaryText} outline-none ${proofStyles.composerFocus} ${proofStyles.placeholderText} focus:ring-2`}
					onChange={(event) => {
						setQuery(event.target.value.replace(/^@/, ""));
						setMenuOpen(true);
					}}
					placeholder="Type @ to mention…"
					ref={anchorRef}
					value={`@${query}`}
				/>
				{menuOpen ? (
					<div className="absolute top-[29rem] left-0 w-full">
						<MentionMenu
							anchorRef={anchorRef}
							groups={groups}
							onDismiss={() => setMenuOpen(false)}
							onSelect={handleSelect}
						/>
					</div>
				) : null}
			</div>

			<div className="mt-4 min-h-10 rounded-xl border border-white/10 bg-black/15 px-3 py-2 text-sm">
				<span className={`${proofStyles.metadataText}`}>
					Selected mention:{" "}
				</span>
				<strong
					className={`${proofStyles.accentText}`}
					data-testid={`${configured ? "configured" : "unconfigured"}-selection`}
				>
					{selected ?? "none"}
				</strong>
			</div>
		</section>
	);
}

const DEPLOY_COMMAND: SlashCommand = {
	args: [
		{
			name: "environment",
			options: [
				{ label: "Staging", value: "staging" },
				{ label: "Production", value: "production" },
			],
		},
		{
			custom: { label: "Use a custom region" },
			name: "region",
			options: [
				{ label: "Singapore", value: "sg" },
				{ label: "Virginia", value: "us-east" },
			],
		},
	],
	description: "Deploy the current project",
	name: "deploy",
	source: "plugin",
};

const PDF_SKILL_COMMAND: SlashCommand = {
	args: [],
	description: "Work with PDFs",
	hint: "PDF",
	name: "pdf",
	source: "skill",
};

const SLASH_COMMANDS = [DEPLOY_COMMAND, PDF_SKILL_COMMAND];

function SlashCommandProof() {
	const anchorRef = useRef<HTMLDivElement | null>(null);
	const [value, setValue] = useState("/");
	const menu = useMemo(
		() => parseSlashMenuState(value, SLASH_COMMANDS),
		[value]
	);
	const verified = value === "/deploy staging sg" && menu === null;
	const selectArgument = (selection: SlashCommandOptionSelection) => {
		if (menu?.kind !== "arguments") {
			return;
		}
		const hasNextArgument = menu.argumentIndex < menu.command.args.length - 1;
		setValue(
			applySlashCommandOption(value, selection.option.value, hasNextArgument)
		);
	};

	return (
		<section
			aria-label="Slash command argument proof"
			className="rounded-3xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl"
			data-testid="slash-command-proof"
		>
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<p className="font-semibold text-white text-xl">
						Plugin command arguments
					</p>
					<p className={`mt-1 max-w-3xl ${proofStyles.mutedText} text-sm`}>
						Commands and enabled Skills have separate groups. Choose a command,
						then one registered option at a time; the second argument includes a
						custom-value choice.
					</p>
				</div>
				<div
					className={`rounded-full px-3 py-1 font-semibold text-xs ${verified ? `${proofStyles.verifiedSurface} ${proofStyles.verifiedText}` : `${proofStyles.pendingSurface} ${proofStyles.pendingText}`}`}
					data-testid="slash-proof-status"
				>
					{verified ? "VERIFIED" : "Choose the registered options"}
				</div>
			</div>

			<div className="relative mt-5" ref={anchorRef}>
				<textarea
					aria-label="Slash command proof composer"
					className={`min-h-14 w-full resize-none rounded-2xl border border-white/10 ${proofStyles.composerSurface} px-4 py-3 ${proofStyles.primaryText} outline-none ${proofStyles.composerFocus} ${proofStyles.placeholderText} focus:ring-2`}
					data-testid="slash-command-input"
					onChange={(event) => setValue(event.target.value)}
					value={value}
				/>
				{menu?.kind === "commands" ? (
					<SlashCommandAutocomplete
						anchorRef={anchorRef}
						commands={SLASH_COMMANDS}
						menu={menu}
						mode="commands"
						onDismiss={() => undefined}
						onSelect={(command) => setValue(`/${command.name} `)}
					/>
				) : null}
				{menu?.kind === "arguments" ? (
					<SlashCommandAutocomplete
						anchorRef={anchorRef}
						menu={menu}
						mode="arguments"
						onDismiss={() => undefined}
						onSelectArgument={selectArgument}
					/>
				) : null}
			</div>
			<output
				className={`mt-4 block rounded-xl border border-white/10 bg-black/15 px-3 py-2 font-mono ${proofStyles.accentText} text-sm`}
				data-testid="slash-command-value"
			>
				{value}
			</output>
		</section>
	);
}

function humanMentionSources(inboxEnabled: boolean): MentionSources {
	const base = sources(false);
	return {
		...base,
		workflows: [
			{
				description: "Run a verification workflow",
				id: "verify",
				name: "Verify",
			},
		],
		users: inboxEnabled
			? [
					{
						description: HUMAN_MENTION.description,
						id: HUMAN_MENTION.id,
						name: HUMAN_MENTION.label,
						visualIcon: HUMAN_MENTION.visualIcon,
					},
				]
			: [],
	};
}

function HumanMentionState({
	inboxEnabled,
	label,
}: {
	inboxEnabled: boolean;
	label: string;
}) {
	const anchorRef = useRef<HTMLTextAreaElement | null>(null);
	const [value, setValue] = useState("@");
	const [menuOpen, setMenuOpen] = useState(true);
	const [selected, setSelected] = useState<{ id: string; label: string }[]>([]);
	const [notificationTargets, setNotificationTargets] = useState<string[]>([]);
	const mentionSources = useMemo(
		() => humanMentionSources(inboxEnabled),
		[inboxEnabled]
	);
	const groups = useMemo(
		() => buildMentionGroups(mentionSources, "", CHAT_MENTION_KINDS),
		[mentionSources]
	);
	const selectedHuman = selected.at(-1);
	const sendMentionNotification = () => {
		const targets = selectHumanNotificationTargets({
			content: value,
			currentUserId: "user-current",
			selected,
		});
		setNotificationTargets(targets.map((target) => target.id));
	};

	return (
		<section
			aria-label={label}
			className="rounded-3xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl"
			data-testid={
				inboxEnabled ? "inbox-enabled-state" : "inbox-disabled-state"
			}
		>
			<div className="mb-4 flex items-start justify-between gap-4">
				<div>
					<p className="font-semibold text-white text-xl">{label}</p>
					<p className={`mt-1 ${proofStyles.mutedText} text-sm`}>
						{inboxEnabled
							? "Users are available from the current org/team roster"
							: "Install and enable Inbox to show human mentions"}
					</p>
				</div>
				<span
					className={`rounded-full ${proofStyles.neutralBadge} px-3 py-1 font-semibold ${proofStyles.secondaryText} text-xs`}
				>
					{inboxEnabled ? "INBOX ON" : "INBOX OFF"}
				</span>
			</div>

			<div className="relative">
				<textarea
					aria-label={`${label} composer`}
					className={`min-h-14 w-full resize-none rounded-2xl border border-white/10 ${proofStyles.composerSurface} px-4 py-3 ${proofStyles.primaryText} outline-none ${proofStyles.composerFocus} ${proofStyles.placeholderText} focus:ring-2`}
					data-testid="human-mention-input"
					onChange={(event) => {
						setValue(event.target.value);
						setMenuOpen(true);
					}}
					ref={anchorRef}
					value={value}
				/>
				{menuOpen ? (
					<div className="absolute top-20 left-0 z-10 w-full">
						<MentionMenu
							anchorRef={anchorRef}
							groups={groups}
							onDismiss={() => setMenuOpen(false)}
							onSelect={(item) => {
								if (item.kind !== "user") {
									return;
								}
								setValue(`@${item.label}`);
								setSelected([{ id: item.id, label: item.label }]);
								setMenuOpen(false);
							}}
						/>
					</div>
				) : null}
			</div>

			<div className="mt-4 flex flex-wrap items-center gap-3">
				<button
					className={`rounded-xl ${proofStyles.actionSurface} px-3 py-2 font-medium ${proofStyles.accentText} text-sm ${proofStyles.actionHover}`}
					disabled={!selectedHuman}
					onClick={sendMentionNotification}
					type="button"
				>
					Record notifications.send
				</button>
				{selectedHuman ? (
					<div data-testid="human-composer-token">
						<MentionToken item={mentionTokenItem(HUMAN_MENTION)}>
							{selectedHuman.label}
						</MentionToken>
					</div>
				) : null}
			</div>

			<div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
				<div className="rounded-xl border border-white/10 bg-black/15 px-3 py-2">
					<span className={`${proofStyles.metadataText}`}>
						notification targets:{" "}
					</span>
					<strong data-testid="notification-targets">
						{notificationTargets.join(", ") || "none"}
					</strong>
				</div>
				<div className="rounded-xl border border-white/10 bg-black/15 px-3 py-2">
					<span className={`${proofStyles.metadataText}`}>
						routing callbacks:{" "}
					</span>
					<strong data-testid="routing-callbacks">none</strong>
				</div>
			</div>

			<div
				className="mt-3 rounded-xl border border-white/10 bg-black/15 px-3 py-2 text-sm"
				data-testid="human-transcript"
			>
				<Markdown
					content={value}
					mentionItems={[mentionTokenItem(HUMAN_MENTION)]}
				/>
			</div>
		</section>
	);
}

function ComposerMentionProof() {
	const browser = TRANSCRIPT_MENTIONS.find(
		(item) => item.kind === "app" && item.id === "browser"
	);
	if (!browser) {
		return null;
	}

	return (
		<section
			aria-label="Composer mention preview"
			className="mt-6 rounded-3xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl"
			data-testid="composer-mention-proof"
		>
			<div className="mb-4">
				<p className="font-semibold text-white text-xl">Composer preview</p>
				<p className={`mt-1 ${proofStyles.mutedText} text-sm`}>
					The shared composer renderer keeps the app icon and accent-colored
					name without a filled chip background.
				</p>
			</div>
			<ChatDisplayPrefsProvider value={{}}>
				<InputBar
					compact
					mentionItems={[browser]}
					onChange={() => undefined}
					onSend={() => undefined}
					onStop={() => undefined}
					status="ready"
					value={`@${browser.label}`}
				/>
			</ChatDisplayPrefsProvider>
			<div
				className={`mt-3 flex items-center gap-2 ${proofStyles.metadataText} text-xs`}
			>
				<span>Inline token:</span>
				<MentionToken item={browser}>{browser.label}</MentionToken>
			</div>
		</section>
	);
}

function MentionComposerProof() {
	const configuredGroups = buildMentionGroups(sources(true), "");
	const unconfiguredGroups = buildMentionGroups(sources(false), "");
	const configuredLabels = configuredGroups.map((group) => group.label);
	const unconfiguredLabels = unconfiguredGroups.map((group) => group.label);
	const hasExpectedGroups = [
		"Agents",
		"Apps",
		"App items",
		"Integrations",
		"Plugins",
		"Skills",
		"Space pages",
		"Personality profiles",
	].every((group) => configuredLabels.includes(group));
	const integrationHidden = !unconfiguredLabels.includes("Integrations");

	return (
		<main
			className={`min-h-screen ${proofStyles.canvas} px-6 py-10 ${proofStyles.primaryText}`}
		>
			<div className="mx-auto max-w-6xl">
				<div className="mb-8 flex flex-wrap items-end justify-between gap-5">
					<div>
						<p
							className={`font-medium ${proofStyles.titleAccent} text-sm uppercase ${proofStyles.titleTracking}`}
						>
							React verification artifact
						</p>
						<h1 className="mt-2 font-semibold text-4xl text-white tracking-tight">
							Chat command and mention directory
						</h1>
						<p className={`mt-3 max-w-2xl ${proofStyles.mutedText}`}>
							The @ picker exposes Agents, Apps, Plugins, Workflows, and
							Inbox-gated Users. The / picker keeps Commands and enabled Skills
							in separate groups; human mentions notify Inbox without changing
							turn routing.
						</p>
					</div>
					<div
						className={`rounded-2xl border ${proofStyles.verifiedBorder} ${proofStyles.verifiedSummary} px-5 py-3 text-right`}
						data-testid="proof-status"
					>
						<p className={`font-semibold ${proofStyles.verifiedText} text-lg`}>
							{hasExpectedGroups && integrationHidden
								? "VERIFIED"
								: "CHECK FAILED"}
						</p>
						<p className={`mt-1 ${proofStyles.verifiedDetail} text-xs`}>
							{configuredLabels.length} visible groups · gated integration
						</p>
					</div>
				</div>

				<div className="grid gap-6 lg:grid-cols-2">
					<MentionState configured label="Credential available" />
					<MentionState configured={false} label="Credential unavailable" />
				</div>
				<div className="mt-6 grid gap-6 lg:grid-cols-2">
					<HumanMentionState inboxEnabled label="Inbox enabled" />
					<HumanMentionState inboxEnabled={false} label="Inbox disabled" />
				</div>
				<div className="mt-6">
					<SlashCommandProof />
				</div>
				<ComposerMentionProof />
				<TranscriptMentionProof />
			</div>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<MentionComposerProof />);
