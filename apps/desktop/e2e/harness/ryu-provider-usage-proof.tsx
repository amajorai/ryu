import { CommandItem } from "@ryu/ui/components/command.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { ProviderCommandDialog } from "../../components/agent-elements/input/provider-command-dialog.tsx";
import { UsageBar } from "../../components/agent-elements/input/usage-bar.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import proofStyles from "./ryu-provider-usage-proof.module.css";
import "../../src/index.css";

const coreUrlSchema = z.string().optional();
const coreUrl =
	coreUrlSchema.parse(import.meta.env.VITE_CORE_URL) ?? window.location.origin;

useNodeStore.setState({
	localNodes: [{ name: "usage-proof", url: coreUrl, token: null }],
	nodes: [{ name: "usage-proof", url: coreUrl, token: null }],
	defaultNode: "usage-proof",
});

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
	},
});

function UsageRows() {
	return (
		<div className="flex flex-col gap-1 p-2" data-testid="usage-proof-rows">
			<CommandItem
				appearance="provider-row"
				data-testid="usage-proof-acp"
				value="Claude Code ACP"
			>
				<span className="min-w-0 flex-1">
					<span className="block font-medium">Claude Code</span>
					<span className="block text-muted-foreground text-xs">
						ACP subscription
					</span>
				</span>
				<UsageBar agentId="acp:claude" />
			</CommandItem>
			<CommandItem
				appearance="provider-row"
				data-testid="usage-proof-ryu-claude"
				value="Claude Pro Max Ryu provider"
			>
				<span className="min-w-0 flex-1">
					<span className="block font-medium">Claude (Pro/Max · login)</span>
					<span className="block text-muted-foreground text-xs">
						Ryu provider subscription
					</span>
				</span>
				<UsageBar agentId="claude-pro-max" />
			</CommandItem>
			<CommandItem
				appearance="provider-row"
				data-testid="usage-proof-ryu-codex"
				value="ChatGPT Plus Pro Ryu provider"
			>
				<span className="min-w-0 flex-1">
					<span className="block font-medium">ChatGPT (Plus/Pro · login)</span>
					<span className="block text-muted-foreground text-xs">
						Ryu provider subscription
					</span>
				</span>
				<UsageBar agentId="openai-codex" />
			</CommandItem>
			<CommandItem
				appearance="provider-row"
				data-testid="usage-proof-ryu-copilot"
				value="GitHub Copilot Ryu provider"
			>
				<span className="min-w-0 flex-1">
					<span className="block font-medium">GitHub Copilot (login)</span>
					<span className="block text-muted-foreground text-xs">
						Ryu provider subscription
					</span>
				</span>
				<UsageBar agentId="github-copilot" />
			</CommandItem>
			<CommandItem
				appearance="provider-row"
				data-testid="usage-proof-devin"
				value="Devin ACP"
			>
				<span className="min-w-0 flex-1">
					<span className="block font-medium">Devin</span>
					<span className="block text-muted-foreground text-xs">
						ACP subscription
					</span>
				</span>
				<UsageBar agentId="acp:devin" />
			</CommandItem>
			<CommandItem
				appearance="provider-row"
				data-testid="usage-proof-opencode"
				value="OpenCode Go ACP"
			>
				<span className="min-w-0 flex-1">
					<span className="block font-medium">OpenCode Go</span>
					<span className="block text-muted-foreground text-xs">
						ACP subscription
					</span>
				</span>
				<UsageBar agentId="acp:opencode" />
			</CommandItem>
			<CommandItem
				appearance="provider-row"
				data-testid="usage-proof-ollama"
				value="Ollama Cloud ACP"
			>
				<span className="min-w-0 flex-1">
					<span className="block font-medium">Ollama Cloud</span>
					<span className="block text-muted-foreground text-xs">
						ACP subscription
					</span>
				</span>
				<UsageBar agentId="acp:ollama" />
			</CommandItem>
			<CommandItem
				appearance="provider-row"
				data-testid="usage-proof-cursor"
				value="Cursor ACP"
			>
				<span className="min-w-0 flex-1">
					<span className="block font-medium">Cursor</span>
					<span className="block text-muted-foreground text-xs">
						ACP subscription
					</span>
				</span>
				<UsageBar agentId="acp:cursor" />
			</CommandItem>
			<CommandItem
				appearance="provider-row"
				data-testid="usage-proof-antigravity"
				value="Antigravity ACP"
			>
				<span className="min-w-0 flex-1">
					<span className="block font-medium">Antigravity</span>
					<span className="block text-muted-foreground text-xs">
						ACP subscription
					</span>
				</span>
				<UsageBar agentId="acp:gemini" />
			</CommandItem>
		</div>
	);
}

function Story() {
	return (
		<QueryClientProvider client={queryClient}>
			<main className="min-h-screen bg-background p-10 text-foreground">
				<div className="mx-auto flex max-w-xl flex-col gap-5">
					<div>
						<p
							className={`text-muted-foreground text-xs uppercase ${proofStyles.eyebrow}`}
						>
							Command dialog proof
						</p>
						<h1 className="mt-2 font-semibold text-2xl">
							Subscription usage is shared
						</h1>
						<p className="mt-2 text-muted-foreground text-sm">
							ACP agents and connected Ryu subscription providers use the same
							user-configured usage bars, rings, windows, and reset details.
						</p>
					</div>
					<ProviderCommandDialog
						renderBody={() => <UsageRows />}
						trigger={
							<button
								className="w-fit rounded-lg border border-border bg-card px-4 py-2 font-medium text-sm shadow-sm"
								data-testid="usage-proof-trigger"
								type="button"
							>
								Open provider command dialog
							</button>
						}
					/>
					<div
						className="rounded-xl border border-border bg-card/70 p-4 text-muted-foreground text-xs"
						data-testid="usage-proof-status"
					>
						Fixture responses cover Claude, ChatGPT, Copilot, Cursor, Devin,
						Antigravity, OpenCode Go, and Ollama Cloud usage meters.
					</div>
				</div>
			</main>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
