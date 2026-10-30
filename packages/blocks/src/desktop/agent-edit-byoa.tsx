"use client";

import {
	Copy01Icon,
	Refresh01Icon,
	Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { Spinner } from "@ryu/ui/components/spinner";
import { SettingsCard, SettingsSection } from "./settings-items.tsx";

// ── Bring external agent (BYOA) ───────────────────────────────────────────────

export interface AgentByoaViewProps {
	agentId: string;
	copied?: "url" | "key" | null;
	error?: string | null;
	gatewayUrl?: string | null;
	generatedKey?: string | null;
	hasKey?: boolean;
	loading?: boolean;
	onCopyKey?: () => void;
	onCopyUrl?: () => void;
	onGenerate?: () => void;
	saving?: boolean;
}

export function AgentByoaView({
	agentId,
	loading,
	error,
	hasKey = false,
	gatewayUrl,
	generatedKey,
	saving,
	copied,
	onCopyUrl,
	onCopyKey,
	onGenerate,
}: AgentByoaViewProps) {
	return (
		<SettingsSection
			caption="Point any OpenAI-compatible agent (OpenClaw, Hermes, LangChain, etc.) at the Ryu gateway as its base URL. It authenticates with the key below, and the gateway applies Ryu's firewall, per-agent budget, and routing — without changing the agent code."
			headerAction={
				hasKey ? <Badge variant="secondary">Key registered</Badge> : undefined
			}
			title="Bring external agent"
		>
			<SettingsCard className="flex flex-col gap-3">
				{loading ? (
					<div className="flex items-center gap-2 text-muted-foreground text-xs">
						<Spinner className="size-3" />
						Loading…
					</div>
				) : null}
				{!loading && error ? (
					<p className="text-status-destructive text-xs">{error}</p>
				) : null}
				{loading || error ? null : (
					<div className="flex flex-col gap-3">
						{gatewayUrl ? (
							<div className="flex flex-col gap-1.5">
								<Label size="compact">Gateway base URL</Label>
								<div className="flex items-center gap-2">
									<Input
										readOnly
										size="compact"
										value={`${gatewayUrl}/v1`}
										variant="code"
									/>
									<Button
										aria-label={
											copied === "url"
												? "Copied gateway URL"
												: "Copy gateway URL"
										}
										onClick={onCopyUrl}
										size="icon-sm"
										variant="ghost"
									>
										{copied === "url" ? (
											<HugeiconsIcon
												className="size-3 text-status-success"
												icon={Tick01Icon}
											/>
										) : (
											<HugeiconsIcon className="size-3" icon={Copy01Icon} />
										)}
									</Button>
								</div>
								<p className="text-muted-foreground text-xs">
									Set this as your agent's{" "}
									<code className="type-caption rounded bg-muted px-1 font-mono">
										base_url
									</code>{" "}
									or{" "}
									<code className="type-caption rounded bg-muted px-1 font-mono">
										OPENAI_BASE_URL
									</code>
									.
								</p>
							</div>
						) : null}

						{generatedKey ? (
							<div className="flex flex-col gap-1.5">
								<Label size="compact" spacing="tight">
									Gateway API key
									<span className="type-compact rounded bg-warning/10 px-1 text-status-warning dark:bg-warning/30">
										Copy now — not shown again
									</span>
								</Label>
								<div className="flex items-center gap-2">
									<Input
										readOnly
										size="compact"
										value={generatedKey}
										variant="code"
									/>
									<Button
										aria-label={
											copied === "key" ? "Copied API key" : "Copy API key"
										}
										onClick={onCopyKey}
										size="icon-sm"
										variant="ghost"
									>
										{copied === "key" ? (
											<HugeiconsIcon
												className="size-3 text-status-success"
												icon={Tick01Icon}
											/>
										) : (
											<HugeiconsIcon className="size-3" icon={Copy01Icon} />
										)}
									</Button>
								</div>
								<p className="text-muted-foreground text-xs">
									Set this as your agent's{" "}
									<code className="type-caption rounded bg-muted px-1 font-mono">
										api_key
									</code>{" "}
									or{" "}
									<code className="type-caption rounded bg-muted px-1 font-mono">
										OPENAI_API_KEY
									</code>
									. The gateway applies Ryu's firewall and per-agent budget to
									all requests tagged with{" "}
									<code className="type-caption rounded bg-muted px-1 font-mono">
										x-ryu-agent-id: {agentId}
									</code>
									.
								</p>
							</div>
						) : null}
						{!generatedKey && hasKey ? (
							<p className="text-muted-foreground text-xs">
								A key is registered for this agent. Regenerate to rotate it.
							</p>
						) : null}

						<Button
							className="self-start"
							loading={saving}
							onClick={onGenerate}
							size="sm"
							variant={hasKey ? "outline" : "default"}
						>
							{!saving && (
								<HugeiconsIcon className="size-3" icon={Refresh01Icon} />
							)}
							{hasKey ? "Regenerate key" : "Generate gateway key"}
						</Button>
					</div>
				)}
			</SettingsCard>
		</SettingsSection>
	);
}
