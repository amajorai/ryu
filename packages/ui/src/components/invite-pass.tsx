"use client";

import { Ticket01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	SENSITIVE_MASK,
	SensitiveRevealButton,
	useSensitiveValue,
} from "@ryu/ui/components/sensitive-value.tsx";
import { Logo } from "./logo.tsx";
import { PassCardShell } from "./pass-card-shell.tsx";
import { PassQrBack } from "./pass-qr-back.tsx";
import {
	REFERRAL_CODE_MAX_PX,
	REFERRAL_CODE_MIN_PX,
} from "./referral-pass.tsx";
import { TearTicket } from "./tear-ticket.tsx";
import { AutoFitText } from "./waitlist-pass.tsx";

export interface InvitePassProps {
	code: string;
	expired?: boolean;
	expiresAt: string;
	inviteUrl?: string;
	metalTheme?: "dark" | "light";
	onTearComplete?: () => void;
	still?: boolean;
	used: boolean;
}

/** Weekly admission pass, printed on the same 3D object as the waitlist card. */
export function InvitePass({
	code,
	expiresAt,
	expired = false,
	inviteUrl,
	still = true,
	metalTheme = "light",
	onTearComplete,
	used,
}: InvitePassProps) {
	const { revealed, toggle } = useSensitiveValue(code);
	return (
		<TearTicket
			onTearComplete={onTearComplete}
			showIdlePerforation={false}
			torn={used}
		>
			<PassCardShell
				back={
					inviteUrl ? (
						<PassQrBack
							caption="Scan your invite"
							metalTheme={metalTheme}
							onRevealToggle={toggle}
							revealed={revealed}
							seed={code}
							value={inviteUrl}
						/>
					) : undefined
				}
				backdrop="warp"
				ditherSeed={code}
				edge="brushed"
				glare={false}
				metalTheme={metalTheme}
				still={still}
			>
				<div className="relative flex min-h-[27rem] w-full flex-1 flex-col gap-6 p-7">
					<div className="flex items-center justify-between gap-3">
						<span className="flex items-center gap-2">
							<Logo size="20px" variant="outline" />
							<span className="font-medium text-sm">Ryu</span>
						</span>
						<HugeiconsIcon
							aria-hidden="true"
							className="text-muted-foreground"
							icon={Ticket01Icon}
							size={24}
						/>
					</div>
					<div className="flex min-w-0 flex-1 flex-col justify-end gap-2">
						<span className="type-caption text-muted-foreground uppercase tracking-widest">
							Invite pass
						</span>
						<AutoFitText
							className="select-all font-medium leading-[1.02] tracking-tight"
							maxPx={REFERRAL_CODE_MAX_PX}
							minPx={REFERRAL_CODE_MIN_PX}
						>
							{revealed ? code : SENSITIVE_MASK}
						</AutoFitText>
						<SensitiveRevealButton
							label="invite code and QR"
							onToggle={toggle}
							revealed={revealed}
						/>
						<span className="text-muted-foreground text-sm">
							One person. Account access.
						</span>
					</div>
					<div className="flex flex-col gap-4">
						<span className="font-medium text-xl">
							{used ? "Redeemed" : expired ? "Expired" : "Ready to share"}
						</span>
						<div className="flex flex-col gap-1 text-xs">
							<span className="text-muted-foreground">
								{used ? "Pass used" : "Redeem before"}
							</span>
							<span className="tabular-nums">
								{used
									? "Your friend has access"
									: new Date(expiresAt).toLocaleString(undefined, {
											month: "short",
											day: "numeric",
											hour: "numeric",
											minute: "2-digit",
											timeZoneName: "short",
										})}
							</span>
						</div>
					</div>
				</div>
			</PassCardShell>
		</TearTicket>
	);
}
