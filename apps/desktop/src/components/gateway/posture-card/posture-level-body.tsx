import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { RangeSlider } from "@ryu/ui/components/motion/range-slider.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import type { Dispatch, SetStateAction } from "react";
import { InlineErrorRow } from "@/src/components/chat/InlineErrorRow.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	GATEWAY_POSTURE_OPTIONS,
	type GatewayPosture,
	type GatewayPostureOption,
	type GatewayPostureSnapshot,
	type ResolvedGatewayPosture,
} from "@/src/lib/api/gateway-posture.ts";
import { LEVEL_RAMP_CLASS, levelFillColor } from "@/src/lib/level-ramp.ts";
import { levelIndex } from "./doctor-summary.tsx";

/** The safety posture level picker with its loading, error and apply states. */
export function PostureLevelBody({
	activePosture,
	apply,
	applying,
	canConfigure,
	error,
	loading,
	pending,
	refresh,
	setPending,
	shownOption,
	shownPosture,
	snapshot,
}: {
	activePosture: ResolvedGatewayPosture | undefined;
	apply: () => Promise<void>;
	applying: boolean;
	canConfigure: boolean;
	error: string | null;
	loading: boolean;
	pending: GatewayPosture | null;
	refresh: () => Promise<void>;
	setPending: Dispatch<SetStateAction<GatewayPosture | null>>;
	shownOption: GatewayPostureOption;
	shownPosture: GatewayPosture;
	snapshot: GatewayPostureSnapshot | null;
}) {
	const tl = useLiteralMessages();
	return loading && !snapshot ? (
		<SettingsCard>
			<SkeletonRows label="Loading posture…" spacing="panel" />
		</SettingsCard>
	) : error && !snapshot ? (
		<InlineErrorRow
			details={error}
			message="Couldn't load safety posture."
			onRetry={() => void refresh()}
		/>
	) : (
		<>
			<SettingsCard className="space-y-4 py-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-medium text-sm">{shownOption.label}</span>
						{activePosture === "custom" ? (
							<span className="text-muted-foreground text-sm">Custom</span>
						) : null}
					</div>
					<p className="mt-1 text-muted-foreground text-xs">
						{shownOption.description}
					</p>
				</div>
				<div className={LEVEL_RAMP_CLASS}>
					<RangeSlider
						aria-label="Gateway safety posture"
						className="h-9"
						disabled={!canConfigure}
						fillColor={levelFillColor(
							levelIndex(shownPosture),
							GATEWAY_POSTURE_OPTIONS.length
						)}
						formatValueText={(value) =>
							GATEWAY_POSTURE_OPTIONS[Math.round(value)]?.accessibilityLabel ??
							String(value)
						}
						max={GATEWAY_POSTURE_OPTIONS.length - 1}
						min={0}
						onValueChange={(value) => {
							const next = GATEWAY_POSTURE_OPTIONS[Math.round(value)]?.level;
							if (next) {
								setPending(next);
							}
						}}
						step={1}
						value={levelIndex(shownPosture)}
					/>
					<div className="flex items-center justify-between gap-2 pt-1 text-muted-foreground text-xs">
						{GATEWAY_POSTURE_OPTIONS.map((option) => (
							<span
								className={
									option.level === shownPosture
										? "font-medium text-foreground"
										: ""
								}
								key={option.level}
							>
								{option.label}
							</span>
						))}
					</div>
				</div>
				<p className="text-muted-foreground text-xs">{shownOption.risk}</p>
			</SettingsCard>
			{pending ? (
				<SettingsGroup>
					<SettingsItem
						actions={
							<div className="flex flex-wrap gap-2">
								<Button
									loading={applying}
									onClick={() => void apply()}
									size="sm"
									variant="outline"
								>
									Apply posture
								</Button>
								<Button
									disabled={applying}
									onClick={() => setPending(null)}
									size="sm"
									variant="ghost"
								>
									Cancel
								</Button>
							</div>
						}
						description="Updates the Gateway firewall and Core approvals together."
						title={tl("Apply {label}?", {
							label: GATEWAY_POSTURE_OPTIONS[levelIndex(pending)].label,
						})}
					/>
				</SettingsGroup>
			) : null}
		</>
	);
}
