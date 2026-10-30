"use client";

import {
	Copy01Icon,
	GitBranchIcon,
	GridIcon,
	Link01Icon,
	Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import type { ReactNode } from "react";
import {
	AGENT_INTEGRATION_SNIPPET_LANGS,
	type AgentIntegrationSnippetLang,
} from "./agent-integration-snippets.ts";
import { SettingsCard, SettingsSection } from "./settings-items.tsx";

// ── Integrations ─────────────────────────────────────────────────────────────

interface IntegrationCardProps {
	code: string;
	description: string;
	icon: ReactNode;
	title: string;
}

function IntegrationCard({
	code,
	description,
	icon,
	title,
}: IntegrationCardProps) {
	return (
		<div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-background p-3.5">
			<div className="flex items-center gap-2">
				<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
					{icon}
				</div>
				<h4 className="min-w-0 font-medium text-sm">{title}</h4>
			</div>
			<p className="text-muted-foreground text-xs leading-relaxed">
				{description}
			</p>
			<pre className="type-compact max-h-40 overflow-auto rounded-md bg-muted/70 p-2.5 font-mono leading-relaxed">
				<code translate="no">{code}</code>
			</pre>
		</div>
	);
}

export interface AgentIntegrationsViewProps {
	agentId: string;
	byoaPanel?: ReactNode;
	copied?: boolean;
	coreUrl: string;
	githubActionsSnippet: string;
	hasToken?: boolean;
	lang?: AgentIntegrationSnippetLang;
	onCopy?: () => void;
	onLangChange?: (lang: AgentIntegrationSnippetLang) => void;
	onOpenDocs?: () => void;
	snippet: string;
}

export function AgentIntegrationsView({
	agentId,
	byoaPanel,
	copied = false,
	coreUrl,
	githubActionsSnippet,
	hasToken = false,
	lang = "typescript",
	onCopy,
	onLangChange,
	onOpenDocs,
	snippet,
}: AgentIntegrationsViewProps) {
	return (
		<div className="flex flex-col gap-6">
			<SettingsSection
				caption="Call the saved agent from a Node app, Python service, Go program, or any client that can send JSON over HTTP. The agent's tools, rules, and Gateway policies still apply."
				headerAction={
					<div className="flex items-center gap-1.5">
						<Badge typography="code" variant="secondary">
							<span translate="no">{agentId}</span>
						</Badge>
						<Badge variant="outline">HTTP + SSE</Badge>
					</div>
				}
				title="Call your agent from code"
			>
				<SettingsCard className="flex flex-col gap-3">
					<div className="flex flex-wrap items-center gap-1">
						{AGENT_INTEGRATION_SNIPPET_LANGS.map((option) => (
							<Button
								aria-pressed={lang === option.id}
								key={option.id}
								onClick={() => onLangChange?.(option.id)}
								size="sm"
								type="button"
								variant={lang === option.id ? "secondary" : "ghost"}
							>
								{option.label}
							</Button>
						))}
						<Button
							aria-label={copied ? "Code sample copied" : "Copy code sample"}
							className="ml-auto"
							onClick={onCopy}
							size="icon-sm"
							type="button"
							variant="ghost"
						>
							{copied ? (
								<HugeiconsIcon
									aria-hidden="true"
									className="size-3 text-status-success"
									icon={Tick01Icon}
								/>
							) : (
								<HugeiconsIcon
									aria-hidden="true"
									className="size-3"
									icon={Copy01Icon}
								/>
							)}
						</Button>
					</div>

					<pre className="type-caption max-h-[28rem] overflow-auto rounded-md border bg-background p-3 font-mono leading-relaxed">
						<code translate="no">{snippet}</code>
					</pre>
					<p className="text-muted-foreground text-xs">
						The TypeScript example uses{" "}
						<code
							className="type-caption rounded bg-muted px-1 font-mono"
							translate="no"
						>
							@ryuhq/client
						</code>{" "}
						to call a saved agent. Use{" "}
						<code
							className="type-caption rounded bg-muted px-1 font-mono"
							translate="no"
						>
							@ryuhq/sdk
						</code>{" "}
						when you are authoring a new agent, tool, or app.
					</p>

					<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
						<p className="text-muted-foreground">
							Endpoint{" "}
							<code
								className="type-caption rounded bg-muted px-1 font-mono"
								translate="no"
							>
								{coreUrl}/api/chat/stream
							</code>
						</p>
						{onOpenDocs ? (
							<Button
								onClick={onOpenDocs}
								size="sm"
								type="button"
								variant="link"
							>
								Read integration docs
							</Button>
						) : null}
					</div>

					<p aria-live="polite" className="text-muted-foreground text-xs">
						{hasToken ? (
							<>
								This node requires auth. Keep its token in{" "}
								<code
									className="type-caption rounded bg-muted px-1 font-mono"
									translate="no"
								>
									RYU_TOKEN
								</code>
								and out of source control.
							</>
						) : (
							"This local node currently accepts requests without a token."
						)}
					</p>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Use the path that matches where the work happens. Accounts and app permissions stay in the Connections tab."
				title="Other ways to use this agent"
			>
				<div className="grid gap-3 md:grid-cols-3">
					<IntegrationCard
						code={githubActionsSnippet}
						description="Run the saved agent from pull requests, releases, and other CI jobs."
						icon={
							<HugeiconsIcon
								aria-hidden="true"
								className="size-4"
								icon={GitBranchIcon}
							/>
						}
						title="GitHub Actions"
					/>
					<IntegrationCard
						code={
							"bunx create-ryu-app my-agent-app --template ryu-app\nbunx ryu pack ."
						}
						description="Wrap an agent tool or result in an interactive widget that renders inside chat."
						icon={
							<HugeiconsIcon
								aria-hidden="true"
								className="size-4"
								icon={GridIcon}
							/>
						}
						title="Build a Ryu App"
					/>
					<IntegrationCard
						code={`ryu-mcp serve\nRYU_CORE_URL=${coreUrl}${
							hasToken ? "\nRYU_CORE_TOKEN=$RYU_TOKEN" : ""
						}`}
						description="Expose governed Ryu tools to Claude, Codex, or another MCP host."
						icon={
							<HugeiconsIcon
								aria-hidden="true"
								className="size-4"
								icon={Link01Icon}
							/>
						}
						title="MCP host"
					/>
				</div>
			</SettingsSection>

			{byoaPanel}
		</div>
	);
}
