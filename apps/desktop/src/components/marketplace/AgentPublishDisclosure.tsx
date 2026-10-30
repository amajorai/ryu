// apps/desktop/src/components/marketplace/AgentPublishDisclosure.tsx
//
// "Here is exactly what leaves this machine." The panel the Publish dialog shows
// above the listing form when the thing being published is an agent.
//
// It renders the DESCRIPTOR that is about to be sent — not a description of it.
// `buildAgentDescriptor` is the single place the wire shape is built, and this
// component reads its output field by field, so a field added to the payload
// shows up here or it shows up nowhere. A disclosure assembled from prose next
// to a payload assembled elsewhere is a promise that quietly stops being true.
//
// The "stays here" column is not decoration either: it names the four bindings
// the publish boundary refuses outright (identities, the memory slot, Space ids,
// the Gateway policy ref) plus the ones that never reach the record at all
// (BYOK/gateway keys, chat history). A user deciding whether to share an agent
// is deciding about their credentials and their data, and they cannot decide
// without seeing which is which.

import {
	CheckmarkCircle02Icon,
	Key01Icon,
	Share08Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import type { ReactNode } from "react";
import { AGENT_IDENTITY_MODE_OPTIONS } from "@/src/components/agents/AgentIdentityModePicker.tsx";
import type {
	AgentDescriptor,
	AgentPublishNotes,
} from "@/src/lib/publish/packaging.ts";

/** How many chips a dependency row shows before collapsing into a count. */
const MAX_CHIPS = 8;

function ChipRow({ values }: { values: string[] }) {
	const shown = values.slice(0, MAX_CHIPS);
	const rest = values.length - shown.length;
	const tl = useLiteralMessages();
	return (
		<div className="flex flex-wrap gap-1">
			{shown.map((value) => (
				<Badge key={value} typography="normal" variant="outline">
					{value}
				</Badge>
			))}
			{rest > 0 ? (
				<Badge typography="normal" variant="outline">
					{tl("+{rest} more", { rest })}
				</Badge>
			) : null}
		</div>
	);
}

function SharedRow({
	label,
	children,
}: {
	children: ReactNode;
	label: string;
}) {
	return (
		<div className="grid grid-cols-[7.5rem_1fr] items-start gap-2">
			<span className="text-muted-foreground text-xs">{label}</span>
			<div className="min-w-0 text-xs">{children}</div>
		</div>
	);
}

export interface AgentPublishDisclosureProps {
	/** The exact descriptor the publish will send. */
	descriptor: AgentDescriptor;
	/** What packaging changed on the way, from the same build. */
	notes: AgentPublishNotes;
}

export function AgentPublishDisclosure({
	descriptor,
	notes,
}: AgentPublishDisclosureProps) {
	const promptChars = descriptor.system_prompt.length;
	const modelLabel = descriptor.model?.engine ?? null;
	const spaceNames = descriptor.spaces.map((space) => space.name);
	const connectionProviders = descriptor.connections.map(
		(connection) => connection.provider
	);
	const avatarLabel = describeAvatar(descriptor);
	const tl = useLiteralMessages();

	return (
		<div className="flex flex-col gap-3">
			<section className="rounded-xl bg-muted p-4">
				<h4 className="flex items-center gap-2 font-medium text-sm">
					<HugeiconsIcon className="size-4" icon={Share08Icon} />
					Shared with everyone who installs it
				</h4>
				<div className="mt-3 flex flex-col gap-2">
					<SharedRow label="Instructions">
						{promptChars > 0 ? (
							<span className="text-muted-foreground">
								{tl(
									"{characterCount} characters, shared in full — read them before publishing.",
									{ characterCount: formatNumber(promptChars) }
								)}
							</span>
						) : (
							<span className="text-status-destructive">None</span>
						)}
					</SharedRow>
					<SharedRow label="Model">
						{modelLabel ? (
							<span className="font-mono">{modelLabel}</span>
						) : (
							<span className="text-muted-foreground">
								No preference — it runs on the installer's default.
							</span>
						)}
					</SharedRow>
					<SharedRow label="Identity">
						<span>
							{AGENT_IDENTITY_MODE_OPTIONS[descriptor.identity_mode].title}
						</span>
						<p className="mt-1 text-muted-foreground">
							Whose accounts it works with, not which ones. Installers choose
							which of their own accounts it may use.
						</p>
					</SharedRow>
					<SharedRow label="Tools">
						{descriptor.tools.length > 0 ? (
							<ChipRow values={descriptor.tools} />
						) : (
							<span className="text-muted-foreground">None declared</span>
						)}
					</SharedRow>
					{descriptor.skills.length > 0 ? (
						<SharedRow label="Skills">
							<ChipRow values={descriptor.skills} />
						</SharedRow>
					) : null}
					{descriptor.composio_actions.length > 0 ? (
						<SharedRow label="Actions">
							<ChipRow values={descriptor.composio_actions} />
						</SharedRow>
					) : null}
					{connectionProviders.length > 0 ? (
						<SharedRow label="Connections">
							<ChipRow values={connectionProviders} />
							<p className="mt-1 text-muted-foreground">
								The provider names only. Installers connect their own accounts.
							</p>
						</SharedRow>
					) : null}
					{spaceNames.length > 0 ? (
						<SharedRow label="Spaces">
							<ChipRow values={spaceNames} />
							<p className="mt-1 text-muted-foreground">
								Names only, so an installer knows what to create. Nothing inside
								them is read or sent.
							</p>
						</SharedRow>
					) : null}
					{avatarLabel ? (
						<SharedRow label="Appearance">
							<span className="text-muted-foreground">{avatarLabel}</span>
						</SharedRow>
					) : null}
				</div>
			</section>

			<section className="border-border border-t pt-4">
				<h4 className="flex items-center gap-2 font-medium text-sm">
					<HugeiconsIcon className="size-4" icon={Key01Icon} />
					Stays on this machine
				</h4>
				<ul className="mt-3 flex flex-col gap-1.5 text-muted-foreground text-xs">
					{STAYS_HERE.map((item) => (
						<li className="flex items-start gap-2" key={item}>
							<HugeiconsIcon
								className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70"
								icon={CheckmarkCircle02Icon}
							/>
							<span>{item}</span>
						</li>
					))}
				</ul>
				{notes.droppedAvatarImage || notes.droppedLocalCommand ? (
					<ul className="mt-3 flex flex-col gap-1.5 border-border border-t pt-3 text-muted-foreground text-xs">
						{notes.droppedAvatarImage ? (
							<li>
								Your uploaded avatar image is stored inline on this node, so it
								is not published. Add an icon URL below to give the listing a
								face.
							</li>
						) : null}
						{notes.droppedLocalCommand ? (
							<li>
								This agent runs a custom local command. That path is not
								published, so the listing ships with no model preference.
							</li>
						) : null}
					</ul>
				) : null}
			</section>

			{notes.blockedReason ? (
				<p className="rounded-xl bg-destructive/10 p-3 text-sm text-status-destructive">
					{notes.blockedReason}
				</p>
			) : null}
		</div>
	);
}

/** The bindings that never leave, in the order a worried user asks about them.
 *
 *  Deliberately says nothing about Space NAMES: when this agent reads a Space,
 *  its name is published (the row above says so, and says why). Claiming here
 *  that "which Spaces they are" stays put would contradict the shared column on
 *  the same screen — and a disclosure that contradicts itself is worse than a
 *  terse one. */
const STAYS_HERE = [
	"API keys and provider credentials — an agent record never holds one.",
	"Identity Vault profiles this agent is bound to.",
	"Which of your accounts this agent may use (its account access).",
	"The contents of your Spaces — every document, note, and file in them.",
	"Stored memories and the memory scopes this agent can recall from.",
	"Chat history, conversations, and anything this agent has run.",
	"The Gateway policy this agent runs under (firewall, DLP, budget).",
];

/** A one-line summary of the glyph the listing will carry, or null for none. */
function describeAvatar(descriptor: AgentDescriptor): string | null {
	const avatar = descriptor.avatar;
	if (!avatar) {
		return null;
	}
	const parts: string[] = [];
	if (avatar.emoji) {
		parts.push(`emoji ${avatar.emoji}`);
	}
	if (avatar.icon) {
		parts.push("a custom icon");
	}
	if (avatar.dicebear) {
		parts.push("a generated avatar");
	}
	if (avatar.dither) {
		parts.push("a dither gradient");
	}
	if (avatar.expressive) {
		parts.push(
			`an expressive ${avatar.expressive.expression ?? "random"} ghost avatar${avatar.expressive.animation ? ` with ${avatar.expressive.animation} animation` : ""}`
		);
	}
	if (avatar.avatar_style) {
		parts.push(`a Marketplace avatar style (${avatar.avatar_style.style})`);
	}
	if (avatar.avatar_url) {
		parts.push("a linked image");
	}
	if (avatar.tone) {
		parts.push(`tone "${avatar.tone}"`);
	}
	return parts.length > 0 ? parts.join(", ") : null;
}
