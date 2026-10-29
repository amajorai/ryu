// Email address sub-section of the agent-edit Connections group. It shows the
// agent's permanent address on the organization mailbox, or lets the user
// check a name and claim one. It calls Core's `agent_inbox` tools, the same
// ones the agent uses in chat, so revoke and send policy stay in the
// organization dashboard.

import { Copy01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import type { FormEvent } from "react";
import { useCallback, useEffect, useId, useState } from "react";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	type AgentEmailAliasSummary,
	type AgentEmailCheck,
	type AgentEmailRefusal,
	checkAgentEmailAlias,
	claimAgentEmailAlias,
	getAgentEmailAlias,
	localPartOf,
} from "@/src/lib/api/agent-email-alias.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";

export const NOT_ORG_NODE_TEXT = "Agent email needs an organization node.";
export const PENDING_TEXT = "Waiting for an organization admin";
const PERMANENCE_TEXT =
	"Agent addresses are permanent and never reissued, so choose the name carefully.";

type LoadState =
	| { status: "loading" }
	| { alias: AgentEmailAliasSummary | null; status: "ready" }
	| { refusal: AgentEmailRefusal; status: "refused" };

type Notice =
	| { check: AgentEmailCheck; kind: "check" }
	| { kind: "refusal"; refusal: AgentEmailRefusal }
	| { kind: "claimed"; message: string }
	| null;

function statusLabel(status: string): string {
	if (status === "pending") {
		return PENDING_TEXT;
	}
	if (status === "revoked") {
		return "Revoked";
	}
	return "Active";
}

function SuggestionChips({
	onPick,
	suggestions,
}: {
	onPick: (localPart: string) => void;
	suggestions: string[];
}) {
	if (suggestions.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<span className="text-muted-foreground text-xs">Try:</span>
			{suggestions.map((suggestion) => (
				<Button
					key={suggestion}
					onClick={() => onPick(localPartOf(suggestion))}
					size="sm"
					type="button"
					variant="outline"
				>
					{suggestion}
				</Button>
			))}
		</div>
	);
}

function AliasDisplay({ alias }: { alias: AgentEmailAliasSummary }) {
	const tl = useLiteralMessages();
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(alias.address);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard unavailable: the address stays selectable.
		}
	};
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-2">
				<span className="min-w-0 flex-1 select-all truncate font-mono text-sm">
					{alias.address}
				</span>
				<Badge variant={alias.status === "active" ? "secondary" : "outline"}>
					{statusLabel(alias.status)}
				</Badge>
				<Button
					aria-label={tl("Copy {address}", { address: alias.address })}
					onClick={() => void copy()}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon
						className="size-4"
						icon={copied ? Tick01Icon : Copy01Icon}
					/>
					{copied ? "Copied" : "Copy"}
				</Button>
			</div>
			<p className="text-muted-foreground text-xs">
				Revoke and the send policy are managed by organization admins in the Ryu
				dashboard.
			</p>
		</div>
	);
}

function ClaimForm({
	agentId,
	onClaimed,
	target,
}: {
	agentId: string;
	onClaimed: (alias: AgentEmailAliasSummary, message: string) => void;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const nameId = useId();
	const [name, setName] = useState("");
	const [busy, setBusy] = useState<"check" | "claim" | null>(null);
	const [notice, setNotice] = useState<Notice>(null);

	const check = async () => {
		setBusy("check");
		setNotice(null);
		const result = await checkAgentEmailAlias(
			target,
			agentId,
			name.trim() || undefined
		);
		setNotice(
			result.ok
				? { check: result, kind: "check" }
				: { kind: "refusal", refusal: result }
		);
		setBusy(null);
	};

	const claim = async (event?: FormEvent) => {
		event?.preventDefault();
		setBusy("claim");
		setNotice(null);
		const result = await claimAgentEmailAlias(target, agentId, {
			localPart: name.trim() || undefined,
		});
		setBusy(null);
		if (result.ok) {
			onClaimed(result.alias, result.message);
			return;
		}
		setNotice({ kind: "refusal", refusal: result });
	};

	const pick = (localPart: string) => {
		setName(localPart);
		setNotice(null);
	};

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(event) => void claim(event)}
		>
			<p className="text-muted-foreground text-sm">
				Give this agent its own address on the organization mailbox. Leave the
				name empty to use the agent's name.
			</p>
			<div className="flex flex-wrap items-center gap-2">
				<label className="sr-only" htmlFor={nameId}>
					Address name
				</label>
				<Input
					autoComplete="off"
					className="min-w-40 flex-1"
					id={nameId}
					onChange={(event) => {
						setName(event.target.value);
						setNotice(null);
					}}
					placeholder="Name (optional)"
					spellCheck={false}
					value={name}
				/>
				<Button
					disabled={busy !== null}
					onClick={() => void check()}
					size="sm"
					type="button"
					variant="outline"
				>
					Check
				</Button>
				<Button disabled={busy !== null} size="sm" type="submit">
					Claim
				</Button>
			</div>
			{notice?.kind === "check" ? (
				<div aria-live="polite" className="flex flex-col gap-2">
					{notice.check.available ? (
						<p className="text-sm">
							<span className="font-mono">{notice.check.address}</span> is
							available.
						</p>
					) : (
						<p className="text-sm text-status-destructive" role="alert">
							{notice.check.message ??
								tl("{address} is not available.", {
									address: notice.check.address,
								})}
						</p>
					)}
					<SuggestionChips
						onPick={pick}
						suggestions={notice.check.suggestions}
					/>
				</div>
			) : null}
			{notice?.kind === "refusal" ? (
				<div className="flex flex-col gap-2">
					<p className="text-sm text-status-destructive" role="alert">
						{notice.refusal.message}
					</p>
					<SuggestionChips
						onPick={pick}
						suggestions={notice.refusal.suggestions}
					/>
				</div>
			) : null}
			<p className="text-muted-foreground text-xs">{PERMANENCE_TEXT}</p>
		</form>
	);
}

export function AgentEmailAliasSection({
	agentId,
}: {
	agentId: string | null;
}) {
	const node = useActiveNode();
	const url = node.url;
	const token = node.token ?? null;
	const userJwt = node.userJwt ?? null;
	const [state, setState] = useState<LoadState>({ status: "loading" });
	const [claimMessage, setClaimMessage] = useState<string | null>(null);

	const target: ApiTarget = { token, url, userJwt };

	const load = useCallback(async () => {
		if (!agentId) {
			return;
		}
		setState({ status: "loading" });
		const result = await getAgentEmailAlias({ token, url, userJwt }, agentId);
		setState(
			result.ok
				? { alias: result.alias, status: "ready" }
				: { refusal: result, status: "refused" }
		);
	}, [agentId, token, url, userJwt]);

	useEffect(() => {
		void load();
	}, [load]);

	if (!agentId) {
		return null;
	}

	return (
		<SettingsSection title="Email address">
			<SettingsCard className="flex flex-col gap-3">
				{state.status === "loading" ? (
					<SkeletonRows label="Loading email address…" spacing="comfortable" />
				) : null}
				{state.status === "refused" ? (
					<p className="text-muted-foreground text-sm">
						{state.refusal.code === "node_not_org_scoped"
							? NOT_ORG_NODE_TEXT
							: state.refusal.message}
					</p>
				) : null}
				{state.status === "ready" && state.alias ? (
					<AliasDisplay alias={state.alias} />
				) : null}
				{state.status === "ready" && !state.alias ? (
					<ClaimForm
						agentId={agentId}
						onClaimed={(alias, message) => {
							setClaimMessage(message || null);
							setState({ alias, status: "ready" });
						}}
						target={target}
					/>
				) : null}
				{claimMessage && state.status === "ready" && state.alias ? (
					<p className="text-sm" role="status">
						{claimMessage}
					</p>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}
