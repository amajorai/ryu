"use client";

// The effective result at one scope with per-field provenance: which layer of
// the ladder set each value, and whether that layer locked it. Rows the Ryu
// platform policy sets are read-only and say so.

import { SquareLock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../settings-items.tsx";
import {
	formatPreviewValue,
	PLATFORM_POLICY_LABEL,
	POLICY_LAYER_LABELS,
	type PolicyPreviewSource,
	type PolicyPreviewView,
	previewFieldLabel,
	previewWarningText,
} from "./policy-model.ts";

function sourceLabel(source: PolicyPreviewSource, tl: LiteralMessage): string {
	if (source.layer === "platform") {
		return PLATFORM_POLICY_LABEL;
	}
	const layer = POLICY_LAYER_LABELS[source.layer];
	if (source.policyName) {
		const version =
			source.policyVersion === undefined ? "" : ` v${source.policyVersion}`;
		return `${layer}: ${source.policyName}${version}`;
	}
	if (source.origin === "limits") {
		return `${layer} limits`;
	}
	if (
		source.origin === "policy_layer" ||
		source.origin === "firewall_overlay"
	) {
		return tl("{layer} (set outside named policies)", { layer });
	}
	return layer;
}

function SourceChips({ sources }: { sources: PolicyPreviewSource[] }) {
	const tl = useLiteralMessages();
	if (sources.length === 0) {
		return (
			<span className="text-muted-foreground text-xs">
				Not set by any policy
			</span>
		);
	}
	return (
		<ul aria-label="Set by" className="flex flex-wrap gap-1.5">
			{sources.map((source, index) => (
				<li key={`${source.layer}-${source.policyId ?? index}`}>
					<Badge
						size="compact"
						variant={source.layer === "platform" ? "secondary" : "outline"}
					>
						{source.locked ? (
							<HugeiconsIcon
								aria-label="Locked"
								className="size-3"
								icon={SquareLock01Icon}
							/>
						) : null}
						{sourceLabel(source, tl)}
					</Badge>
				</li>
			))}
		</ul>
	);
}

function eligibleSummary(list: {
	allowed: string[];
	restricted: boolean;
}): string {
	if (!list.restricted) {
		return "Any";
	}
	if (list.allowed.length === 0) {
		return "None";
	}
	return list.allowed.join(", ");
}

/**
 * Renders a preview. `hideUnset` drops fields no layer sets, which keeps the
 * firewall switches the node decides out of the way.
 */
export function PolicyPreview({
	hideUnset = true,
	preview,
}: {
	hideUnset?: boolean;
	preview: PolicyPreviewView;
}) {
	const fields = hideUnset
		? preview.fields.filter((field) => field.sources.length > 0)
		: preview.fields;
	const modelCount = preview.eligible.models.restricted
		? String(preview.eligible.models.allowed.length)
		: "Any";

	return (
		<div className="flex flex-col gap-4">
			{preview.warnings.length > 0 ? (
				<div role="alert">
					<SettingsCard className="flex flex-col gap-1 text-sm text-status-warning">
						{preview.warnings.map((warning) => (
							<p key={warning}>{previewWarningText(warning)}</p>
						))}
					</SettingsCard>
				</div>
			) : null}

			<SettingsSection
				caption="What remains after combining every assigned policy with the Ryu platform policy."
				title="Eligible"
			>
				<SettingsGroup>
					<SettingsItem
						actions={<span className="text-sm tabular-nums">{modelCount}</span>}
						title="Models"
					>
						{preview.eligible.models.restricted &&
						preview.eligible.models.allowed.length > 0 ? (
							<p className="break-words text-muted-foreground text-xs">
								{preview.eligible.models.allowed.join(", ")}
							</p>
						) : null}
					</SettingsItem>
					<SettingsItem
						actions={
							<span className="break-words text-sm">
								{eligibleSummary(preview.eligible.providers)}
							</span>
						}
						title="Providers"
					/>
					<SettingsItem
						actions={
							<span className="text-sm">
								{preview.zeroDataRetention.required
									? "Required"
									: "Not required"}
							</span>
						}
						title="Zero data retention"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption={
					fields.length === 0
						? undefined
						: "Each value with the layers that set it. A lock means lower scopes cannot change it."
				}
				title="Effective rules"
			>
				{fields.length === 0 ? (
					<SettingsCard className="text-center text-muted-foreground text-sm">
						No policy sets anything at this scope yet.
					</SettingsCard>
				) : (
					<SettingsGroup>
						{fields.map((field) => (
							<SettingsItem
								actions={
									<span className="max-w-64 break-words text-right text-sm">
										{formatPreviewValue(field.value)}
									</span>
								}
								key={field.field}
								title={previewFieldLabel(field.field)}
							>
								<SourceChips sources={field.sources} />
							</SettingsItem>
						))}
					</SettingsGroup>
				)}
			</SettingsSection>

			{preview.notes.length > 0 ? (
				<ul className="flex list-disc flex-col gap-1 px-3.5 pl-8 text-muted-foreground text-xs">
					{preview.notes.map((note) => (
						<li key={note}>{note}</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
