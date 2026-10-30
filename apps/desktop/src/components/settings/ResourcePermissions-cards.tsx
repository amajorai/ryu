import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useState } from "react";
import {
	SETTING_LABEL,
	SETTING_ORDER,
	settingOf,
	TARGET_FALLBACK_PLACEHOLDER,
	TARGET_LABEL,
	TARGET_PLACEHOLDER,
	TARGET_PLURAL,
	withSetting,
} from "./ResourcePermissions-model.ts";
import type {
	Choice,
	Overwrite,
	PermissionGroup,
	PermissionInfo,
	Setting,
} from "./ResourcePermissions-types.ts";

/**
 * Who a rule applies to.
 *
 * Falls back to a text box when the node offers no directory, and says which of
 * the two reasons it is: a personal node has no org to list, while a node that
 * failed the read may well list one on the next Refresh. Collapsing those into
 * one message would tell a laptop owner to go and fix an outage that is not
 * happening.
 */
export function TargetPicker({
	row,
	choices,
	directoryFailed,
	onChange,
}: {
	choices: Choice[];
	directoryFailed: boolean;
	onChange: (targetId: string) => void;
	row: Overwrite;
}) {
	const tl = useLiteralMessages();
	if (row.target_type === "org") {
		return null;
	}

	if (choices.length === 0) {
		return (
			<div className="flex flex-1 flex-col gap-1">
				<Input
					aria-label={tl("{target} identifier", {
						target: TARGET_LABEL[row.target_type],
					})}
					onChange={(e) => onChange(e.target.value)}
					placeholder={TARGET_FALLBACK_PLACEHOLDER[row.target_type]}
					size="compact"
					value={row.target_id}
				/>
				<p className="text-detail text-muted-foreground">
					{directoryFailed
						? "This node did not send anything to choose from. It may be an older node, or unreachable. Type the identifier, or come back once it answers."
						: tl(
								"This node listed no {targets}, which is normal on a personal node that belongs to no organisation. Type an identifier only if you know it: a wrong one saves cleanly and applies to nobody.",
								{ targets: TARGET_PLURAL[row.target_type] }
							)}
				</p>
			</div>
		);
	}

	// A rule can outlive the person it names. Keeping the stored value as its own
	// option means opening the panel shows who it points at instead of quietly
	// blanking the field and saving the rule away.
	const known = choices.some((c) => c.id === row.target_id);
	const options =
		known || row.target_id === ""
			? choices
			: [
					...choices,
					{
						id: row.target_id,
						label: row.target_id,
						hint: "No longer in this organisation",
					},
				];

	return (
		<Select
			items={options.map((c) => ({ value: c.id, label: c.label }))}
			onValueChange={(value) => onChange(isNativeText(value) ? value : "")}
			value={row.target_id}
		>
			<SelectTrigger appearance="gateway-action" className="flex-1">
				<SelectValue placeholder={TARGET_PLACEHOLDER[row.target_type]} />
			</SelectTrigger>
			<SelectContent
				searchable={row.target_type === "member"}
				searchPlaceholder="Search people…"
			>
				{options.map((choice) => (
					<SelectItem
						key={choice.id}
						textValue={`${choice.label} ${choice.hint ?? ""}`}
						value={choice.id}
					>
						<span className="flex flex-col">
							<span>{choice.label}</span>
							{choice.hint && choice.hint !== choice.label ? (
								<span className="text-detail text-muted-foreground">
									{choice.hint}
								</span>
							) : null}
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export function PermissionRow({
	permission,
	setting,
	onSet,
}: {
	onSet: (setting: Setting) => void;
	permission: PermissionInfo;
	setting: Setting;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex items-start justify-between gap-3">
			<div className="min-w-0">
				<p className="text-sm">{permission.label}</p>
				{permission.description ? (
					<p className="text-detail text-muted-foreground">
						{permission.description}
					</p>
				) : null}
				{/* Each line describes the setting it would produce, so only one of
				    them is ever the live consequence: offering "allowing this also
				    allows" under a row set to Deny describes a state just turned off. */}
				{setting !== "deny" && permission.alsoAllows.length > 0 ? (
					<p className="text-detail text-muted-foreground">
						{tl("Allowing this also allows: {permissions}", {
							permissions: permission.alsoAllows.join(", "),
						})}
					</p>
				) : null}
				{setting === "deny" && permission.alsoDenies.length > 0 ? (
					<p className="text-detail text-muted-foreground">
						{tl("Denying this also denies: {permissions}", {
							permissions: permission.alsoDenies.join(", "),
						})}
					</p>
				) : null}
			</div>
			<div className="flex shrink-0 gap-1">
				{SETTING_ORDER.map((opt) => (
					<Button
						key={opt}
						onClick={() => onSet(opt)}
						size="sm"
						variant={setting === opt ? "default" : "ghost"}
					>
						{SETTING_LABEL[opt]}
					</Button>
				))}
			</div>
		</div>
	);
}

/**
 * One source's permissions, collapsed by default.
 *
 * `defaultOpen` is read once, at mount: a group that opens because it holds a
 * rule must not slam shut the moment the admin puts that rule back to Inherit,
 * and a group opened by hand must stay open.
 */
export function PermissionGroupSection({
	group,
	row,
	defaultOpen,
	onSet,
}: {
	defaultOpen: boolean;
	group: PermissionGroup;
	onSet: (permission: string, setting: Setting) => void;
	row: Overwrite;
}) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(defaultOpen);
	const setCount = group.permissions.filter(
		(p) => settingOf(row, p.id) !== "inherit"
	).length;

	return (
		<Collapsible onOpenChange={setOpen} open={open}>
			<CollapsibleTrigger
				appearance="permission-group"
				className="flex w-full items-center justify-between text-left"
			>
				<span className="min-w-0 truncate text-sm" title={group.title}>
					{group.title}
				</span>
				<span className="flex shrink-0 items-center gap-2 text-detail text-muted-foreground">
					{setCount > 0
						? tl("{setCount} set", { setCount: String(setCount) })
						: tl("{length} available", {
								length: String(group.permissions.length),
							})}
					<HugeiconsIcon
						className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
						icon={ArrowDown01Icon}
					/>
				</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="flex flex-col" spacing="permission-list">
				{group.permissions.map((permission) => (
					<PermissionRow
						key={permission.id}
						onSet={(setting) => onSet(permission.id, setting)}
						permission={permission}
						setting={settingOf(row, permission.id)}
					/>
				))}
			</CollapsibleContent>
		</Collapsible>
	);
}

export function OverwriteCard({
	row,
	groups,
	choices,
	directoryFailed,
	onChange,
	onRemove,
}: {
	choices: Choice[];
	directoryFailed: boolean;
	groups: PermissionGroup[];
	onChange: (next: Overwrite) => void;
	onRemove: () => void;
	row: Overwrite;
}) {
	const needsTarget =
		row.target_type !== "org" && row.target_id.trim().length === 0;

	return (
		<li className="flex flex-col gap-3 border-border border-b py-4 first:pt-0 last:border-b-0">
			<div className="flex items-start gap-2">
				<Label size="compact" spacing="permission-aligned">
					{TARGET_LABEL[row.target_type]}
				</Label>
				<TargetPicker
					choices={choices}
					directoryFailed={directoryFailed}
					onChange={(targetId) => onChange({ ...row, target_id: targetId })}
					row={row}
				/>
				<Button onClick={onRemove} size="sm" variant="ghost-muted">
					Remove
				</Button>
			</div>

			{needsTarget ? (
				<p className="text-detail text-muted-foreground">
					Pick who this applies to. Until then these settings do nothing.
				</p>
			) : null}

			<div className="flex flex-col">
				{groups.map((group) => (
					<PermissionGroupSection
						defaultOpen={
							group.key === "" ||
							group.permissions.some((p) => settingOf(row, p.id) !== "inherit")
						}
						group={group}
						key={group.key}
						onSet={(permission, setting) =>
							onChange(withSetting(row, permission, setting))
						}
						row={row}
					/>
				))}
			</div>
		</li>
	);
}
