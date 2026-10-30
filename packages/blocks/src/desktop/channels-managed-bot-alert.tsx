"use client";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Alert, AlertDescription, AlertTitle } from "@ryu/ui/components/alert";
import { buttonVariants } from "@ryu/ui/components/button";
import type { ChannelConfigView } from "./channels-model.ts";

interface ChannelManagedBotAlertProps {
	managedBotActionUrl: string | null;
	selected: ChannelConfigView;
}

/** Notice shown for a channel whose credentials Ryu manages. */
export function ChannelManagedBotAlert({
	managedBotActionUrl,
	selected,
}: ChannelManagedBotAlertProps) {
	const tl = useLiteralMessages();
	return (
		<Alert>
			<AlertTitle>
				{selected.managedProvisioningState === "ready"
					? "Dedicated Ryu-managed bot"
					: "Managed bot setup is waiting"}
			</AlertTitle>
			<AlertDescription>
				{selected.managedProvisioningState === "ready" ? (
					<>
						{selected.managedBotUsername
							? tl(
									"@{username} is dedicated to this managed node. It is not shared with another customer. To use your own bot, paste its token below and save; provider ownership transfer is not automatic.",
									{
										username: selected.managedBotUsername.replace(/^@+/, ""),
									}
								)
							: tl(
									"This bot is dedicated to this managed node. It is not shared with another customer. To use your own bot, paste its token below and save; provider ownership transfer is not automatic."
								)}
						{managedBotActionUrl ? (
							<div className="mt-3 flex flex-wrap items-center gap-2">
								<a
									className={buttonVariants({
										size: "sm",
										variant: "outline",
									})}
									data-slot="button"
									href={managedBotActionUrl}
									rel="noopener noreferrer"
									target="_blank"
								>
									{selected.channelType === "telegram"
										? "Open in Telegram"
										: "Install in Discord"}
								</a>
								<span className="text-muted-foreground text-xs">
									{selected.channelType === "telegram"
										? "Open the bot, then press Start."
										: "Choose a server where you have Manage Server permission."}
								</span>
							</div>
						) : null}
					</>
				) : (
					"Ryu reserved this node's Telegram/Discord channel slot, but no company bot credential is available yet. Paste your own token below to use this channel now."
				)}
			</AlertDescription>
		</Alert>
	);
}
