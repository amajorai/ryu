import {
	BubbleChatIcon,
	CpuIcon,
	DatabaseIcon,
	GitBranchIcon,
	PuzzleIcon,
	Store01Icon,
	Wallet01Icon,
	WorkflowSquare01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Switch } from "@ryu/ui/components/switch";
import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { AudioDevicesSettings } from "@/src/components/settings/AudioDevicesSettings.tsx";
import { ChatRenameSettings } from "@/src/components/settings/ChatRenameSettings.tsx";
import { EditorEmbeddingSettings } from "@/src/components/settings/EditorEmbeddingSettings.tsx";
import { TtsEngineSettings } from "@/src/components/settings/TtsEngineSettings.tsx";
import { UpdatesSettings } from "@/src/components/settings/UpdatesSettings.tsx";
import { VoiceInputSettings } from "@/src/components/settings/VoiceInputSettings.tsx";
import { VoiceReadbackSettings } from "@/src/components/settings/VoiceReadbackSettings.tsx";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";

const DEVELOPER_MODE_KEY = "ryu_developer_mode";

export function getDeveloperMode(): boolean {
	try {
		return localStorage.getItem(DEVELOPER_MODE_KEY) === "true";
	} catch {
		return false;
	}
}

export default function SettingsPage() {
	const [developerMode, setDeveloperMode] = useState<boolean>(() =>
		getDeveloperMode()
	);
	const openGateway = useGatewayDialog((s) => s.openGateway);
	const openSettings = useSettingsDialog((s) => s.openSettings);

	useEffect(() => {
		try {
			localStorage.setItem(
				DEVELOPER_MODE_KEY,
				developerMode ? "true" : "false"
			);
			// Dispatch a storage event so other components can react
			window.dispatchEvent(
				new StorageEvent("storage", {
					key: DEVELOPER_MODE_KEY,
					newValue: developerMode ? "true" : "false",
				})
			);
		} catch {
			// ignore
		}
	}, [developerMode]);

	const advancedLinks: {
		to?: string;
		onClick?: () => void;
		label: string;
		icon: IconSvgElement;
		description: string;
	}[] = [
		{
			onClick: () => openSettings("credits"),
			label: "Credits",
			icon: Wallet01Icon,
			description: "Prepaid balance, top-ups, and usage history",
		},
		{
			to: "/marketplace",
			label: "Marketplace",
			icon: Store01Icon,
			description: "Buy paid items, view licenses, and sell",
		},
		{
			onClick: () => openGateway("channels"),
			label: "Channels",
			icon: BubbleChatIcon,
			description: "Connect Telegram, Slack, WhatsApp, and Discord bots",
		},
		{
			to: "/engines",
			label: "Engines",
			icon: CpuIcon,
			description: "Set up AI models that run on this device",
		},
		{
			to: "/apps",
			label: "Plugins",
			icon: PuzzleIcon,
			description: "Installed plugins",
		},
	];

	const developerLinks: {
		to: string;
		label: string;
		icon: IconSvgElement;
		description: string;
	}[] = [
		{
			to: "/tools",
			label: "Tools",
			icon: Wrench01Icon,
			description: "Available tools and MCP servers",
		},
		{
			to: "/library/space",
			label: "Spaces",
			icon: DatabaseIcon,
			description: "RAG spaces and vector stores",
		},
		{
			to: "/library/workflow",
			label: "Workflows",
			icon: WorkflowSquare01Icon,
			description: "Automate multi-step tasks, schedules, and triggers",
		},
		{
			to: "/extensions",
			label: "Extensions",
			icon: GitBranchIcon,
			description: "Browser and desktop extensions",
		},
	];

	return (
		<div className="mx-auto max-w-2xl px-6 py-8">
			<h1 className="mb-8 font-semibold text-xl">Settings</h1>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					Updates
				</h2>
				<UpdatesSettings />
			</section>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					Chat
				</h2>
				<ChatRenameSettings />
			</section>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					Audio
				</h2>
				<AudioDevicesSettings />
			</section>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					Voice input
				</h2>
				<VoiceInputSettings />
			</section>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					Read back responses
				</h2>
				<VoiceReadbackSettings />
			</section>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					Text-to-speech
				</h2>
				<TtsEngineSettings />
			</section>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					Editor & Embeddings
				</h2>
				<EditorEmbeddingSettings />
			</section>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					Advanced
				</h2>
				<div className="space-y-1 overflow-hidden rounded-lg bg-card">
					{advancedLinks.map(({ to, onClick, label, icon, description }) => {
						const inner = (
							<div className="flex items-center gap-3">
								<HugeiconsIcon
									className="text-muted-foreground"
									icon={icon}
									size={14}
								/>
								<div>
									<p className="font-medium text-sm group-hover:text-foreground">
										{label}
									</p>
									<p className="text-muted-foreground text-xs">{description}</p>
								</div>
							</div>
						);
						const className =
							"group flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-muted";
						// Entries with an onClick (e.g. Channels) open a dialog rather
						// than navigate to a route.
						return onClick ? (
							<button
								className={className}
								key={label}
								onClick={onClick}
								type="button"
							>
								{inner}
							</button>
						) : (
							<NavLink className={className} key={to} to={to ?? "#"}>
								{inner}
							</NavLink>
						);
					})}
				</div>
			</section>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					Developer
				</h2>
				<div className="rounded-lg bg-card p-4">
					<div className="flex items-center justify-between">
						<div>
							<p className="font-medium text-sm">Developer mode</p>
							<p className="text-muted-foreground text-xs">
								Show advanced features: workflows, extensions, and more.
							</p>
						</div>
						<Switch
							aria-label="Toggle developer mode"
							checked={developerMode}
							onCheckedChange={setDeveloperMode}
						/>
					</div>
				</div>

				{developerMode && (
					<div className="mt-2 space-y-1 overflow-hidden rounded-lg bg-card">
						{developerLinks.map(({ to, label, icon, description }) => (
							<NavLink
								className="group flex items-center justify-between px-4 py-3 transition-colors hover:bg-muted"
								key={to}
								to={to}
							>
								<div className="flex items-center gap-3">
									<HugeiconsIcon
										className="text-muted-foreground"
										icon={icon}
										size={14}
									/>
									<div>
										<p className="font-medium text-sm">{label}</p>
										<p className="text-muted-foreground text-xs">
											{description}
										</p>
									</div>
								</div>
							</NavLink>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
