"use client";

import {
	SENSITIVE_MASK,
	SensitiveRevealButton,
	useSensitiveValue,
} from "@ryu/ui/components/sensitive-value.tsx";

import type { CSSProperties } from "react";
import { passQrColors } from "../lib/pass-qr.ts";
import { cn } from "../lib/utils.ts";
import { ditherAvatarHue } from "./dither-kit/avatar.tsx";
import { Logo } from "./logo.tsx";
import { useIsDarkFace } from "./pass-card-shell.tsx";
import styles from "./pass-qr-back.module.css";
import { QRCode } from "./qr-code.tsx";

const QR_SIZE = 224;
interface PassQrPaletteStyle extends CSSProperties {
	"--pass-qr-foreground": string;
	"--pass-qr-glow": string;
	"--pass-qr-surface": string;
}

export interface PassQrBackProps {
	/** The small instruction beneath the code. */
	caption: string;
	className?: string;
	metalTheme?: "auto" | "dark" | "light";
	onRevealToggle?: () => void;
	revealed?: boolean;
	/** The same public seed that paints the card's warp field. */
	seed: string;
	/** The absolute URL a phone camera should open. */
	value?: string | null;
}

/**
 * The shared back face for invite-bearing passes.
 *
 * QR modules stay dot-shaped so they feel native to Ryu's dither language. The
 * face tint is derived from the card seed, while the foreground is pulled back
 * toward the semantic foreground so the code remains camera-readable. High QR
 * correction leaves a small quiet-zone cutout for the static Ryu mark in the
 * middle without turning the logo into a second visual block.
 */
export function PassQrBack({
	caption,
	className,
	revealed: controlledRevealed,
	onRevealToggle,
	metalTheme = "auto",
	seed,
	value,
}: PassQrBackProps) {
	const visibility = useSensitiveValue(value);
	const revealed = controlledRevealed ?? visibility.revealed;
	const toggle = onRevealToggle ?? visibility.toggle;
	const isDark = useIsDarkFace(metalTheme);
	const colors = passQrColors(ditherAvatarHue(seed), isDark);
	const trimmedValue = value?.trim() ?? "";

	const paletteStyle: PassQrPaletteStyle = {
		"--pass-qr-surface": colors.surface,
		"--pass-qr-foreground": colors.foreground,
		"--pass-qr-glow": colors.glow,
	};
	return (
		<div
			className={cn(
				"relative flex h-full min-h-[27rem] w-full flex-col items-center justify-center gap-3 p-7",
				className
			)}
			style={paletteStyle}
		>
			<div
				aria-hidden="true"
				className={cn(
					"pointer-events-none absolute inset-14 rounded-full blur-3xl",
					styles.glow
				)}
			/>
			{trimmedValue && !revealed ? (
				<div className="relative flex flex-col items-center gap-3">
					<span className="font-mono text-3xl">{SENSITIVE_MASK}</span>
					<span className="text-sm">Invite QR hidden</span>
					<SensitiveRevealButton
						label="invite QR"
						onToggle={toggle}
						revealed={false}
						tabIndex={controlledRevealed === undefined ? undefined : -1}
					/>
				</div>
			) : trimmedValue ? (
				<>
					<div className={cn("relative p-3.5", styles.frame)}>
						<QRCode
							aria-label={caption}
							bgColor={colors.surface}
							className="size-[13rem]"
							errorCorrectionLevel="H"
							fgColor={colors.foreground}
							size={QR_SIZE}
							value={trimmedValue}
						/>
						<div
							aria-hidden="true"
							className={cn(
								"absolute top-1/2 left-1/2 flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-xl",
								styles.logoTile
							)}
						>
							<span className={styles.foreground}>
								<Logo size="25px" variant="outline-static" />
							</span>
						</div>
					</div>
					<span
						className={cn("type-compact font-medium uppercase", styles.caption)}
					>
						{caption}
					</span>
					<SensitiveRevealButton
						label="invite QR"
						onToggle={toggle}
						revealed
						tabIndex={controlledRevealed === undefined ? undefined : -1}
					/>
				</>
			) : (
				<div
					className={cn(
						"relative flex flex-col items-center justify-center gap-2 border border-dashed text-center",
						styles.placeholder
					)}
				>
					<span className={cn("font-mono text-2xl", styles.pendingDots)}>
						···
					</span>
					<span
						className={cn(
							"type-compact max-w-36 uppercase opacity-70",
							styles.pendingCaption
						)}
					>
						Invite link is preparing
					</span>
				</div>
			)}
		</div>
	);
}
