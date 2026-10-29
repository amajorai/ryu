import { ONBOARDING_CONTENT_DELAY_MS } from "@ryu/blocks/desktop/onboarding.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal.tsx";
import { type ReactNode, useState } from "react";
import { TelegramManagedBotPanel } from "@/src/components/channels/TelegramManagedBotPanel.tsx";
import { RyuOnboardingAvatar } from "@/src/components/onboarding/RyuOnboardingPersona.tsx";
import { SettingsCard } from "@/src/components/settings/shared/settings-items.tsx";
import type { ManagedBotPairingRequest } from "@/src/lib/api/managed-bots.ts";

const TELEGRAM_FORM: Omit<ManagedBotPairingRequest, "name" | "suggested_name"> =
	{
		agent_id: "ryu",
		enabled: true,
		group_reply_mode: "mentions",
		model: null,
		system_prompt: null,
		team_id: null,
	};

function Shell({
	children,
	subtitle,
	title,
}: {
	children: ReactNode;
	subtitle: string;
	title: string;
}) {
	return (
		<div className="scroll-fade h-full w-full overflow-y-auto">
			<div
				className="flex min-h-full w-full flex-col items-center justify-center gap-8 p-8"
				data-tauri-drag-region="true"
			>
				<StaggerReveal>
					<div className="shrink-0">
						<RyuOnboardingAvatar />
					</div>
					<PageHeader stagger={false} subtitle={subtitle} title={title} />
				</StaggerReveal>
				<div className="w-full max-w-xl">
					<StaggerReveal startDelay={ONBOARDING_CONTENT_DELAY_MS} wrap>
						{children}
					</StaggerReveal>
				</div>
			</div>
		</div>
	);
}

function ContinueRow({
	continueLabel,
	onContinue,
	onSkip,
}: {
	continueLabel: string;
	onContinue: () => void;
	onSkip?: () => void;
}) {
	return (
		<div className="flex items-center justify-between gap-3 pt-1">
			{onSkip ? (
				<Button onClick={onSkip} variant="ghost">
					Skip for now
				</Button>
			) : (
				<span />
			)}
			<Button onClick={onContinue} size="lg" variant="mono">
				{continueLabel}
			</Button>
		</div>
	);
}

function TelegramLoginOption({
	onOpen,
	opened,
}: {
	onOpen: () => void;
	opened: boolean;
}) {
	return (
		<div className="space-y-2 border-t pt-3">
			<div>
				<p className="font-medium text-sm">Want fewer setup steps?</p>
				<p className="mt-1 text-muted-foreground text-xs">
					Use Ryu's hosted bot instead. Log in with Telegram and allow Ryu to
					message you directly — no new bot to create. This uses Ryu Cloud and
					does not add a local Gateway channel.
				</p>
			</div>
			<Button onClick={onOpen} size="sm" variant="outline">
				Log in with Telegram
			</Button>
			{opened ? (
				<p className="text-muted-foreground text-xs" role="status">
					Telegram Login opened in your browser. Finish there, then open Ryu's
					bot when it is ready.
				</p>
			) : null}
		</div>
	);
}

export function TelegramOnboardingStep({
	existingChannelCount,
	onContinue,
	onSkip,
	onUseTelegramLogin,
}: {
	/** `null` means the duplicate check failed; fail closed and do not create one. */
	existingChannelCount: number | null;
	onContinue: () => void;
	onSkip: () => void;
	/** Open the hosted-bot Telegram Login hand-off in the user's browser. */
	onUseTelegramLogin: () => void;
}) {
	const tl = useLiteralMessages();
	const [ready, setReady] = useState(false);
	const [unsupported, setUnsupported] = useState<string | null>(null);
	const [telegramLoginOpened, setTelegramLoginOpened] = useState(false);

	if (existingChannelCount === null) {
		return (
			<Shell
				subtitle="We could not verify your existing channels, so nothing will be created from onboarding."
				title="Check your channels"
			>
				<SettingsCard
					className="flex flex-col gap-4"
					data-testid="telegram-check-failed"
				>
					<p className="text-muted-foreground text-sm">
						Open Gateway → Channels later to review your setup. Ryu will not
						create another Telegram bot until your existing channel list can be
						checked.
					</p>
					<ContinueRow
						continueLabel="Continue"
						onContinue={onContinue}
						onSkip={onSkip}
					/>
				</SettingsCard>
			</Shell>
		);
	}

	if (existingChannelCount > 0) {
		return (
			<Shell
				subtitle="Ryu found your existing channel setup and will leave it unchanged."
				title="You already have channels"
			>
				<SettingsCard
					className="flex flex-col gap-4"
					data-testid="telegram-existing-channels"
				>
					<div>
						<p className="font-medium text-sm">
							{tl(
								"{existingChannelCount, plural, one {# configured channel} other {# configured channels}} found",
								{ existingChannelCount }
							)}
						</p>
						<p className="mt-1 text-muted-foreground text-sm">
							No duplicate Telegram bot will be created. Manage your channels
							later from Gateway → Channels.
						</p>
					</div>
					<ContinueRow
						continueLabel="Continue"
						onContinue={onContinue}
						onSkip={onSkip}
					/>
				</SettingsCard>
			</Shell>
		);
	}

	if (ready) {
		return (
			<Shell
				subtitle="Your Telegram bot is connected and ready to talk to Ryu."
				title="Telegram is ready"
			>
				<SettingsCard
					className="flex flex-col gap-4"
					data-testid="telegram-setup-ready"
				>
					<div>
						<p className="font-medium text-sm">Ryu on Telegram</p>
						<p className="mt-1 text-muted-foreground text-sm">
							Messages route to the default Ryu agent. You can change the route
							or group reply behavior from Gateway → Channels.
						</p>
					</div>
					<ContinueRow
						continueLabel="Continue"
						onContinue={onContinue}
						onSkip={onSkip}
					/>
				</SettingsCard>
			</Shell>
		);
	}

	if (unsupported) {
		return (
			<Shell
				subtitle="This node cannot create a managed Telegram bot yet."
				title="Telegram setup is optional"
			>
				<SettingsCard
					className="flex flex-col gap-4"
					data-testid="telegram-setup-unavailable"
				>
					<p className="text-muted-foreground text-sm">{unsupported}</p>
					<p className="text-muted-foreground text-sm">
						You can add a Telegram bot later from Gateway → Channels.
					</p>
					<TelegramLoginOption
						onOpen={() => {
							onUseTelegramLogin();
							setTelegramLoginOpened(true);
						}}
						opened={telegramLoginOpened}
					/>
					<ContinueRow
						continueLabel="Continue"
						onContinue={onContinue}
						onSkip={onSkip}
					/>
				</SettingsCard>
			</Shell>
		);
	}

	return (
		<Shell
			subtitle="Ryu creates a bot for you and connects it to the default Ryu agent."
			title="Talk to Ryu on Telegram"
		>
			<SettingsCard
				className="flex flex-col gap-4"
				data-testid="telegram-setup-step"
			>
				<div>
					<p className="font-medium text-sm">Set up your channel</p>
					<p className="mt-1 text-muted-foreground text-sm">
						No @BotFather visit or token copy-paste. Telegram will ask you to
						confirm the bot, and Ryu keeps the credential on this node.
					</p>
				</div>
				<TelegramManagedBotPanel
					active
					botName="Ryu on Telegram"
					form={TELEGRAM_FORM}
					onReady={() => setReady(true)}
					onUnsupported={setUnsupported}
				/>
				<TelegramLoginOption
					onOpen={() => {
						onUseTelegramLogin();
						setTelegramLoginOpened(true);
					}}
					opened={telegramLoginOpened}
				/>
				<ContinueRow continueLabel="Skip for now" onContinue={onSkip} />
			</SettingsCard>
		</Shell>
	);
}
