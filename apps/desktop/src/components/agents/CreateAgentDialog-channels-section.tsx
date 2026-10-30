import { CHANNEL_LABELS } from "@ryu/blocks/desktop/channels.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Switch } from "@ryu/ui/components/switch.tsx";

interface CreateAgentChannelsSectionProps {
	autoSetupDiscord: boolean;
	autoSetupTelegram: boolean;
	autoSetupWhatsApp: boolean;
	setAutoSetupDiscord: (next: boolean) => void;
	setAutoSetupTelegram: (next: boolean) => void;
	setAutoSetupWhatsApp: (next: boolean) => void;
	submitting: boolean;
}

// The "Set up channels after creation" toggles of `CreateAgentDialog`.
export function CreateAgentChannelsSection({
	autoSetupDiscord,
	autoSetupTelegram,
	autoSetupWhatsApp,
	setAutoSetupDiscord,
	setAutoSetupTelegram,
	setAutoSetupWhatsApp,
	submitting,
}: CreateAgentChannelsSectionProps) {
	const tl = useLiteralMessages();
	return (
		<div className="flex flex-col gap-1">
			<div>
				<p className="font-medium text-sm">Set up channels after creation</p>
				<p className="text-detail text-muted-foreground">
					The first selected setup opens after creation.
				</p>
			</div>
			<div className="flex flex-col">
				<label className="flex min-h-10 items-center justify-between gap-3 border-border border-b py-2 text-sm last:border-b-0">
					<span>{CHANNEL_LABELS.telegram}</span>
					<Switch
						aria-label={tl("Set up {telegram} after creation", {
							telegram: CHANNEL_LABELS.telegram,
						})}
						checked={autoSetupTelegram}
						disabled={submitting}
						onCheckedChange={setAutoSetupTelegram}
					/>
				</label>
				<label className="flex min-h-10 items-center justify-between gap-3 border-border border-b py-2 text-sm last:border-b-0">
					<span>{CHANNEL_LABELS.discord}</span>
					<Switch
						aria-label={tl("Set up {discord} after creation", {
							discord: CHANNEL_LABELS.discord,
						})}
						checked={autoSetupDiscord}
						disabled={submitting}
						onCheckedChange={setAutoSetupDiscord}
					/>
				</label>
				<label className="flex min-h-10 items-center justify-between gap-3 border-border border-b py-2 text-sm last:border-b-0">
					<span>{CHANNEL_LABELS.whatsapp}</span>
					<Switch
						aria-label={tl("Set up {whatsapp} after creation", {
							whatsapp: CHANNEL_LABELS.whatsapp,
						})}
						checked={autoSetupWhatsApp}
						disabled={submitting}
						onCheckedChange={setAutoSetupWhatsApp}
					/>
				</label>
			</div>
		</div>
	);
}
