"use client";

import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { ReferralPass } from "@ryu/ui/components/referral-pass.tsx";
import { SensitiveValue } from "@ryu/ui/components/sensitive-value.tsx";
import type {
	AffiliateDashboard,
	CreditReferralDashboard,
} from "../../utils/api-client.ts";
import { SettingsCard, SettingsSection } from "../shared/settings-rows.tsx";
import { formatCreditsUsd } from "./referrals-format.ts";

export function InvitePassSection({
	copied,
	credits,
	data,
	holderName,
	metalTheme,
	onCopy,
}: {
	copied: boolean;
	credits: CreditReferralDashboard | undefined;
	data: AffiliateDashboard;
	holderName?: string | null;
	metalTheme: "auto" | "dark" | "light";
	onCopy: () => void;
}) {
	return (
		/* THE INVITE IS AN OBJECT, NOT A FORM FIELD. This was a read-only input
		    with a Copy button — the same control the app uses for an API key,
		    which is a thing you hide, where a referral is the one artefact whose
		    whole job is to be shown to another person. It is now the same
		    laminated, turning pass the waitlist queue hands out, printed with the
		    member's own code. The full LINK is still what Copy puts on the
		    clipboard; the card carries the code, which is the part a person
		    repeats out loud. */
		<SettingsSection
			caption={
				<>
					Earn Ryu credits when a friend you invite starts paying
					{data.enabled ? ", plus a cash commission." : "."}
					{/* Credit rewards land in the earner's PERSONAL org, always — never
					    in whichever org is active when the payout fires, which may be a
					    client's. Said here because it is surprising the first time and
					    because the Credits tab is where the money can then be moved. */}{" "}
					Credits go to your personal workspace; move them from Credits.
				</>
			}
			title="Your invite pass"
		>
			{/* No `overflow-hidden` anywhere on this surface (SettingsCard has
			    none): the pass is a 3D object that turns, tilts and lifts 5% under
			    the pointer, so its painted box is LARGER than the layout box it
			    occupies. Clipped, a hover sheared the corners off it and a drag to
			    turn it sliced the card in half at the panel edge. The cell below is
			    padded so the grown card has somewhere to grow into rather than only
			    unclipping into its neighbour's text. */}
			<SettingsCard>
				<div className="grid gap-6 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] md:items-center">
					{/* The gap goes on the CELL, not on the card: the pass's own className
					    lands on the perspective host that scales, so padding there would
					    inflate the transform box rather than leave room around it. */}
					<div className="py-3">
						<ReferralPass
							className="mx-auto w-full max-w-[20rem]"
							code={data.referralCode}
							earned={
								credits ? formatCreditsUsd(credits.cap.earnedMicroUsd) : null
							}
							holder={holderName}
							joined={credits?.referrals.length ?? null}
							metalTheme={metalTheme}
							referralUrl={data.referralLink}
						/>
					</div>

					<div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
						<SensitiveValue
							className="flex-1 text-sm"
							label="referral link"
							value={data.referralLink}
						/>
						<Button
							disabled={!data.referralLink}
							onClick={onCopy}
							size="sm"
							type="button"
							variant="outline"
						>
							<HugeiconsIcon icon={Copy01Icon} size={16} />
							{copied ? "Copied" : "Copy"}
						</Button>
					</div>
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}
