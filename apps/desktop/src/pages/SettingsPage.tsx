import {
	DatabaseIcon,
	GitBranchIcon,
	LayerIcon,
	PlugSocketIcon,
	ShieldKeyIcon,
	Store01Icon,
	Tv01Icon,
	Wallet01Icon,
	WorkflowCircle06Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useI18n } from "@ryu/i18n/react";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback } from "react";
import { NavLink } from "react-router-dom";
import { A2aSettings } from "@/src/components/settings/A2aSettings.tsx";
import { AudioDevicesSettings } from "@/src/components/settings/AudioDevicesSettings.tsx";
import { EditorEmbeddingSettings } from "@/src/components/settings/EditorEmbeddingSettings.tsx";
import { LanguageSettings } from "@/src/components/settings/LanguageSettings.tsx";
import { TtsEngineSettings } from "@/src/components/settings/TtsEngineSettings.tsx";
import { UpdatesSettings } from "@/src/components/settings/UpdatesSettings.tsx";
import { VoiceInputSettings } from "@/src/components/settings/VoiceInputSettings.tsx";
import { VoiceReadbackSettings } from "@/src/components/settings/VoiceReadbackSettings.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useDeveloperMode } from "@/src/hooks/useDeveloperMode.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";

export default function SettingsPage() {
	const { t } = useI18n();
	const [developerMode, setDeveloperMode] = useDeveloperMode();
	const { openTab } = useTabsContext();
	const openSettings = useSettingsDialog((s) => s.openSettings);
	const translateLink = useCallback(
		(value: string, field: "description" | "label") =>
			t(
				`settings.page.link.${field}.${value
					.toLowerCase()
					.replaceAll(" ", "_")}`,
				{},
				value
			),
		[t]
	);

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
			onClick: () =>
				openTab("/library/channel", {
					title: t("settings.page.channels", {}, "Channels"),
				}),
			label: "Channels",
			icon: Tv01Icon,
			description: "Connect Telegram, Slack, WhatsApp, and Discord bots",
		},
		{
			to: "/vault",
			label: "Vault",
			icon: ShieldKeyIcon,
			description: "Write-only secrets for governed MCP calls",
		},
		{
			to: "/engines",
			label: "Engines",
			icon: LayerIcon,
			description: "Set up AI models that run on this device",
		},
		{
			to: "/apps",
			label: "Plugins",
			icon: PlugSocketIcon,
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
			icon: WorkflowCircle06Icon,
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
			<h1 className="mb-8 font-medium text-xl">
				{t("settings.page.title", {}, "Settings")}
			</h1>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					{t("settings.page.updates", {}, "Updates")}
				</h2>
				<UpdatesSettings />
			</section>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					{t("settings.page.language", {}, "Language")}
				</h2>
				<LanguageSettings />
			</section>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					{t("settings.page.audio", {}, "Audio")}
				</h2>
				<AudioDevicesSettings />
			</section>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					{t("settings.page.voice_recognition", {}, "Voice Recognition")}
				</h2>
				<VoiceInputSettings />
			</section>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					{t("settings.page.read_back", {}, "Read back responses")}
				</h2>
				<VoiceReadbackSettings />
			</section>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					{t("settings.page.audio", {}, "Audio")}
				</h2>
				<TtsEngineSettings />
			</section>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					{t("settings.page.editor_embeddings", {}, "Editor & Embeddings")}
				</h2>
				<EditorEmbeddingSettings />
			</section>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					{t("settings.page.agent_networking", {}, "Agent networking")}
				</h2>
				<A2aSettings />
			</section>

			<section className="mb-8">
				<h2 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wide">
					{t("settings.page.advanced", {}, "Advanced")}
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
										{translateLink(label, "label")}
									</p>
									<p className="text-muted-foreground text-xs">
										{translateLink(description, "description")}
									</p>
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
					{t("settings.page.developer", {}, "Developer")}
				</h2>
				<div className="rounded-lg bg-card p-4">
					<div className="flex items-center justify-between">
						<div>
							<p className="font-medium text-sm">
								{t("settings.page.developer_mode", {}, "Developer mode")}
							</p>
							<p className="text-muted-foreground text-xs">
								{t(
									"settings.page.developer_mode_description",
									{},
									"Show advanced features: workflows, extensions, and more."
								)}
							</p>
						</div>
						<Switch
							aria-label={t(
								"settings.page.toggle_developer_mode",
								{},
								"Toggle developer mode"
							)}
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
										<p className="font-medium text-sm">
											{translateLink(label, "label")}
										</p>
										<p className="text-muted-foreground text-xs">
											{translateLink(description, "description")}
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
