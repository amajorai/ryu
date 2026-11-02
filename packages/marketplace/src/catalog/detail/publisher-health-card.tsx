import {
	Alert02Icon,
	CheckmarkCircle02Icon,
	InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { formatNumberValue } from "@ryu/i18n/format-intl";
import {
	type LiteralMessage,
	useLiteralMessages,
	useOptionalI18n,
} from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties } from "react";
import visualStyles from "../../marketplace-visual.module.css";
import {
	calculatePublisherHealth,
	type PublisherHealthInput,
	type PublisherHealthSignal,
	type PublisherHealthSignalId,
	type PublisherHealthValue,
} from "./publisher-health.ts";

function signalLabel(tl: LiteralMessage, id: PublisherHealthSignalId): string {
	switch (id) {
		case "identity":
			return tl("Publisher identity");
		case "signature":
			return tl("Release signature");
		case "review":
			return tl("Ryu code review");
		case "integrity":
			return tl("Package integrity");
		case "capabilities":
			return tl("Declared capabilities");
		default:
			return tl("Community ratings");
	}
}

/** The verdict in the UI language, with counts and the rating average
 *  formatted for the locale (a decimal comma in `de`). */
function signalValue(
	tl: LiteralMessage,
	locale: string,
	value: PublisherHealthValue
): string {
	switch (value.id) {
		case "staff-verified":
			return tl("Ryu staff verified");
		case "identity-verified":
			return tl("Stripe identity verified");
		case "not-verified":
			return tl("Not verified");
		case "signature-verified":
			return tl("Verified");
		case "signature-invalid":
			return tl("Invalid");
		case "unsigned":
			return tl("Unsigned");
		case "not-reported":
			return tl("Not reported");
		case "reviewed":
			return tl("Reviewed");
		case "not-reviewed":
			return tl("Not reviewed");
		case "checksum-recorded":
			return tl("SHA-256 recorded");
		case "checksum-missing":
			return tl("Checksum not reported");
		case "capabilities":
			return tl("{count, plural, one {# requested} other {# requested}}", {
				count: value.count,
			});
		default:
			return tl("{average} / 5 ({count})", {
				average: formatNumberValue(locale, value.average, {
					maximumFractionDigits: 1,
					minimumFractionDigits: 1,
				}),
				count: formatNumberValue(locale, value.count),
			});
	}
}

function signalIcon(signal: PublisherHealthSignal) {
	if (signal.status === "good") {
		return CheckmarkCircle02Icon;
	}
	if (signal.status === "warning") {
		return Alert02Icon;
	}
	return InformationCircleIcon;
}

/** Compact install-time health disclosure. The score summarizes observable
 * signals and deliberately says that it is not a guarantee. */
export function PublisherHealthCard({
	className,
	...input
}: PublisherHealthInput & { className?: string }) {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale ?? "en";
	const health = calculatePublisherHealth(input);
	const progressStyle: HealthProgressStyle = {
		"--marketplace-width": `${health.score}%`,
	};
	return (
		<Card appearance="publisher-health" className={className}>
			<CardHeader spacing="compact">
				<div className="flex items-center justify-between gap-3">
					<CardTitle variant="section">Publisher health</CardTitle>
					<Badge
						variant={
							input.publisherTrust === "dotted" ? "outline" : "secondary"
						}
					>
						{health.score}/100
					</Badge>
				</div>
				<div
					aria-label={tl("Publisher health score {score} out of 100", {
						score: health.score,
					})}
					aria-valuemax={100}
					aria-valuemin={0}
					aria-valuenow={health.score}
					className="h-1.5 overflow-hidden rounded-full bg-muted"
					role="progressbar"
				>
					<div
						className={cn(
							"h-full rounded-full",
							visualStyles.progress,
							health.score >= 70
								? "bg-success"
								: health.score >= 40
									? "bg-warning"
									: "bg-destructive"
						)}
						style={progressStyle}
					/>
				</div>
				<p className="text-muted-foreground text-xs">
					Signals, not a guarantee. Check the permissions and source before
					installing.
				</p>
			</CardHeader>
			<CardContent layout="signal-grid" topSpacing="flush">
				{health.signals.map((signal) => (
					<div className="flex items-center gap-2 text-xs" key={signal.id}>
						<HugeiconsIcon
							className={cn(
								"size-3.5",
								signal.status === "good"
									? "text-status-success"
									: signal.status === "warning"
										? "text-status-warning"
										: "text-muted-foreground"
							)}
							icon={signalIcon(signal)}
						/>
						<span className="text-muted-foreground">
							{signalLabel(tl, signal.id)}
						</span>
						<span className="ms-auto text-end">
							{signalValue(tl, locale, signal.value)}
						</span>
					</div>
				))}
			</CardContent>
		</Card>
	);
}

interface HealthProgressStyle extends CSSProperties {
	"--marketplace-width": string;
}
