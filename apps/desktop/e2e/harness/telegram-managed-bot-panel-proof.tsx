import { I18nProvider } from "@ryu/i18n/react";
import { ThemeProvider } from "next-themes";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { TelegramManagedBotPanel } from "../../src/components/channels/TelegramManagedBotPanel.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import type { ManagedBotPairingRequest } from "../../src/lib/api/managed-bots.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const NODE = {
	name: "telegram-panel-proof",
	token: "telegram-panel-node-token",
	url: "http://127.0.0.1:5477",
	userJwt: null,
};

declare global {
	interface Window {
		__TELEGRAM_MANAGED_BOT_PANEL_PROOF__: {
			readyTokens: (string | null)[];
			unsupportedMessages: string[];
		};
	}
}

useNodeStore.setState({
	autoSelect: false,
	autoSelectedNode: null,
	cloudNodes: [],
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});

window.__TELEGRAM_MANAGED_BOT_PANEL_PROOF__ = {
	readyTokens: [],
	unsupportedMessages: [],
};

function TelegramManagedBotPanelProof() {
	const [active, setActive] = useState(true);
	const [botName, setBotName] = useState("");
	const [openingEnabled, setOpeningEnabled] = useState(false);
	const [openingTarget, setOpeningTarget] = useState("");
	const [unsupported, setUnsupported] = useState<string | null>(null);
	const [result, setResult] = useState<string | null>(null);
	const form = useMemo<
		Omit<ManagedBotPairingRequest, "name" | "suggested_name">
	>(
		() => ({
			agent_id: "agent-support",
			enabled: false,
			group_reply_mode: "all",
			model: "openai/gpt-4.1-mini",
			proactive_opening: openingEnabled,
			proactive_target: openingEnabled ? openingTarget.trim() || null : null,
			reaction_learning: {
				allowGroup: true,
				enabled: true,
				negativeEmoji: ["👎", "💀"],
				positiveEmoji: ["👍", "❤️", "🎉"],
			},
			system_prompt: "Answer briefly and use the configured support agent.",
			team_id: "team-ops",
		}),
		[openingEnabled, openingTarget]
	);
	const onReady = useCallback((token: string | undefined) => {
		window.__TELEGRAM_MANAGED_BOT_PANEL_PROOF__.readyTokens.push(token ?? null);
		setResult(
			token ? "A token was handed to the host." : "The node saved the bot."
		);
		if (!token) {
			setActive(false);
		}
	}, []);
	const onUnsupported = useCallback((message: string) => {
		window.__TELEGRAM_MANAGED_BOT_PANEL_PROOF__.unsupportedMessages.push(
			message
		);
		setUnsupported(message);
	}, []);

	useEffect(() => {
		document.body.dataset.harnessReady = "1";
	}, []);

	return (
		<AppSurfaceProvider surface="desktop">
			<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
				<main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-5 bg-background p-8 text-foreground">
					<header className="space-y-1">
						<h1 className="font-semibold text-xl">New Telegram bot</h1>
						<p className="text-muted-foreground text-sm">
							Local rendered proof for the managed-bot pairing panel.
						</p>
					</header>
					<div className="grid gap-3 rounded-xl border p-4 sm:grid-cols-2">
						<label className="flex flex-col gap-1.5 text-sm">
							Name
							<input
								aria-label="Name"
								className="rounded-md border bg-background px-3 py-2"
								onChange={(event) => setBotName(event.target.value)}
								value={botName}
							/>
						</label>
						<label className="flex items-center gap-2 text-sm">
							<input
								aria-label="Proactive opening"
								checked={openingEnabled}
								onChange={(event) => setOpeningEnabled(event.target.checked)}
								type="checkbox"
							/>
							Send a welcome message
						</label>
						<label className="flex flex-col gap-1.5 text-sm sm:col-span-2">
							Approved welcome target
							<input
								aria-label="Approved welcome target"
								className="rounded-md border bg-background px-3 py-2"
								disabled={!openingEnabled}
								onChange={(event) => setOpeningTarget(event.target.value)}
								value={openingTarget}
							/>
						</label>
					</div>
					<div className="flex items-center gap-2">
						<button
							className="rounded-md border px-3 py-2 text-sm"
							onClick={() => setActive(false)}
							type="button"
						>
							Close pairing panel
						</button>
						<button
							className="rounded-md border px-3 py-2 text-sm"
							onClick={() => {
								setUnsupported(null);
								setActive(true);
							}}
							type="button"
						>
							Reopen pairing panel
						</button>
					</div>
					<div
						aria-hidden={!active}
						data-testid="telegram-managed-bot-panel"
						hidden={!active}
					>
						<TelegramManagedBotPanel
							active={active}
							botName={botName}
							form={form}
							onReady={onReady}
							onUnsupported={onUnsupported}
						/>
					</div>
					{active ? null : (
						<p className="text-muted-foreground text-sm" role="status">
							Pairing panel closed.
						</p>
					)}
					{result ? (
						<p className="text-sm" role="status">
							{result}
						</p>
					) : null}
					{unsupported ? (
						<section
							aria-label="Manual token fallback"
							className="space-y-2 rounded-lg border p-4"
						>
							<p className="text-sm text-status-warning">{unsupported}</p>
							<label className="flex flex-col gap-1 text-sm">
								Manual bot token
								<input
									aria-label="Manual bot token"
									className="rounded-md border bg-background px-3 py-2"
								/>
							</label>
						</section>
					) : null}
				</main>
			</ThemeProvider>
		</AppSurfaceProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<I18nProvider>
			<TelegramManagedBotPanelProof />
		</I18nProvider>
	);
}

export type TelegramManagedBotPanelProofPublisher =
	Window["__TELEGRAM_MANAGED_BOT_PANEL_PROOF__"];
