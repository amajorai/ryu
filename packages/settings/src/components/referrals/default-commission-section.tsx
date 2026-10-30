"use client";

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Item } from "@ryu/ui/components/item.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { z } from "zod";
import type { CommissionRule } from "../../utils/api-client.ts";
import { SettingsGroup, SettingsSection } from "../shared/settings-rows.tsx";

const DEFAULT_COMMISSION_TITLE_ID = "referrals-default-commission";
const DEFAULT_COMMISSION_TOGGLE_ID = "referrals-default-commission-toggle";
const DEFAULT_COMMISSION_EDITOR_ID = "referrals-default-commission-editor";

/**
 * One editor field as a settings row: its label on the left (kept a real
 * `label` for the control's accessible name), the control on the right. Not a
 * `SettingsItem` because that title clamps to one line, and these labels carry
 * instructions ("blank = forever") that must stay readable at phone width.
 */
function CommissionFieldRow({
	children,
	htmlFor,
	label,
}: {
	children: ReactNode;
	htmlFor: string;
	label: ReactNode;
}) {
	return (
		<Item purpose="settings-row" size="sm">
			<div className="flex w-full items-center justify-between gap-6">
				<Label className="min-w-0 flex-1 font-normal" htmlFor={htmlFor}>
					{label}
				</Label>
				<div className="shrink-0">{children}</div>
			</div>
		</Item>
	);
}

export interface DefaultCommissionSectionProps {
	editorOpen: boolean;
	hasDefaultCommission: boolean;
	onClear: () => void;
	onSave: () => void;
	onToggleEditor: () => void;
	rule: CommissionRule;
	savePending: boolean;
	setRule: Dispatch<SetStateAction<CommissionRule>>;
}

export function DefaultCommissionSection({
	editorOpen,
	hasDefaultCommission,
	onClear,
	onSave,
	onToggleEditor,
	rule,
	savePending,
	setRule,
}: DefaultCommissionSectionProps) {
	return (
		<SettingsSection
			as="section"
			caption="Applies to your marketplace listings unless an item overrides it."
			headerAction={
				// Labelled by the section heading AND its own text, so the
				// toggle is announced as "Marketplace default commission
				// Edit" rather than a bare "Edit".
				<Button
					aria-controls={editorOpen ? DEFAULT_COMMISSION_EDITOR_ID : undefined}
					aria-expanded={editorOpen}
					aria-labelledby={`${DEFAULT_COMMISSION_TITLE_ID} ${DEFAULT_COMMISSION_TOGGLE_ID}`}
					id={DEFAULT_COMMISSION_TOGGLE_ID}
					onClick={onToggleEditor}
					size="sm"
					type="button"
					variant="ghost"
				>
					Edit
					<HugeiconsIcon
						className={`text-muted-foreground transition-transform duration-(--duration-fast) ${
							editorOpen ? "rotate-180" : ""
						}`}
						icon={ArrowDown01Icon}
						size={16}
					/>
				</Button>
			}
			title="Marketplace default commission"
			titleId={DEFAULT_COMMISSION_TITLE_ID}
		>
			{editorOpen ? (
				<div id={DEFAULT_COMMISSION_EDITOR_ID}>
					<SettingsGroup>
						<CommissionFieldRow
							htmlFor="commission-type"
							key="type"
							label="Type"
						>
							<Select
								onValueChange={(value) =>
									setRule((prev) => ({
										...prev,
										type: z.enum(["percent", "flat"]).parse(value),
									}))
								}
								value={rule.type}
							>
								<SelectTrigger className="w-36" id="commission-type" size="sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="percent">Percent</SelectItem>
									<SelectItem value="flat">Flat</SelectItem>
								</SelectContent>
							</Select>
						</CommissionFieldRow>

						<CommissionFieldRow
							htmlFor="commission-value"
							key="value"
							label={
								rule.type === "percent"
									? "Value (basis points)"
									: "Value (cents)"
							}
						>
							<Input
								className="h-8 w-36"
								id="commission-value"
								inputMode="numeric"
								min={0}
								onChange={(e) =>
									setRule((prev) => ({
										...prev,
										value: Number(e.target.value) || 0,
									}))
								}
								type="number"
								value={rule.value}
							/>
						</CommissionFieldRow>

						<CommissionFieldRow
							htmlFor="commission-funded"
							key="funded"
							label="Funded by"
						>
							<Select
								onValueChange={(value) =>
									setRule((prev) => ({
										...prev,
										fundedBy: z.enum(["platform", "seller"]).parse(value),
									}))
								}
								value={rule.fundedBy}
							>
								<SelectTrigger
									className="w-36"
									id="commission-funded"
									size="sm"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="platform">Platform</SelectItem>
									<SelectItem value="seller">Seller</SelectItem>
								</SelectContent>
							</Select>
						</CommissionFieldRow>

						<Item
							className="cursor-pointer"
							key="recurring"
							purpose="settings-row"
							render={<label htmlFor="commission-recurring" />}
							size="sm"
						>
							<div className="flex w-full items-center justify-between gap-6">
								<span className="min-w-0 flex-1 text-sm">
									Recurring commission
								</span>
								<Checkbox
									checked={rule.recurring}
									id="commission-recurring"
									onCheckedChange={(checked) =>
										setRule((prev) => ({
											...prev,
											recurring: checked === true,
											durationMonths:
												checked === true ? prev.durationMonths : null,
										}))
									}
								/>
							</div>
						</Item>

						<CommissionFieldRow
							htmlFor="commission-duration"
							key="duration"
							label="Duration (months, blank = forever)"
						>
							<Input
								className="h-8 w-36"
								disabled={!rule.recurring}
								id="commission-duration"
								inputMode="numeric"
								min={1}
								onChange={(e) =>
									setRule((prev) => ({
										...prev,
										durationMonths:
											e.target.value === ""
												? null
												: Number(e.target.value) || null,
									}))
								}
								placeholder="Forever"
								type="number"
								value={rule.durationMonths ?? ""}
							/>
						</CommissionFieldRow>

						{/* The editor's actions close its own card rather than
						    floating under it on the pane. */}
						<Item key="actions" purpose="settings-row" size="sm">
							<div className="flex w-full flex-wrap justify-end gap-2">
								<Button
									disabled={savePending || !hasDefaultCommission}
									onClick={onClear}
									size="sm"
									type="button"
									variant="ghost"
								>
									Clear
								</Button>
								<Button
									loading={savePending}
									onClick={onSave}
									size="sm"
									type="button"
									variant="mono"
								>
									Save
								</Button>
							</div>
						</Item>
					</SettingsGroup>
				</div>
			) : null}
		</SettingsSection>
	);
}
