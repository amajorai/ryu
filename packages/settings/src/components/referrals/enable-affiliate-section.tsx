"use client";

import { GiftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../shared/settings-rows.tsx";

/**
 * The cash program's opt-in. It is a SECTION, not a gate: credit rewards are
 * attributed from the share code at sign-up and pay whether or not this is ever
 * enabled, so an early return here would hide credits the user already earned —
 * and would make the two rewards look like two unrelated programs.
 */
export function EnableAffiliateSection({
	onEnable,
	pending,
}: {
	onEnable: () => void;
	pending: boolean;
}) {
	return (
		<SettingsSection
			caption="Your credit rewards already run. Turn this on and the same link also pays cash."
			title="Add cash commission to the same link"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Button
							loading={pending}
							onClick={onEnable}
							size="sm"
							type="button"
							variant="outline"
						>
							{!pending && <HugeiconsIcon icon={GiftIcon} size={16} />}
							Enable cash commission
						</Button>
					}
					title="Affiliate program"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
