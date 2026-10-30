"use client";

import { ArrowDown01Icon, Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { composeTriggerSummary } from "@ryu/blocks/composer/composer-trigger-summary.ts";
import {
	FullAccessSelectionProvider,
	isFullAccessEquivalent,
	useFullAccessSelectionGuard,
} from "@ryu/blocks/composer/full-access-warning.tsx";
import { useChatDisplayPrefs } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { isNativeFunction } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Fragment, type ReactNode, useState } from "react";
import { EffortMeter } from "./composer-settings-effort-meter.tsx";
import {
	activeItem,
	activeItemName,
	type ComposerSettingsMenuProps,
	type ComposerSettingsSection,
	type ItemDecoration,
} from "./composer-settings-menu-types.ts";
import { renderComposerSettingsRow } from "./composer-settings-row.tsx";

export type {
	ComposerSettingItem,
	ComposerSettingsMenuProps,
	ComposerSettingsSection,
	ItemDecoration,
} from "./composer-settings-menu-types.ts";

/**
 * One composer control that merges the agent, model, and approval-policy (plus
 * any agent-advertised config) pickers into a single dropdown. The trigger shows
 * every active setting at a glance (`Ryu · Sonnet · Plan`); the popover lists each
 * setting as its own labelled section. Sections with no options are skipped, so
 * an agent that advertises no model or no permission modes simply shows fewer
 * rows — nothing is hardcoded.
 */
export function ComposerSettingsMenu(props: ComposerSettingsMenuProps) {
	const agentSection = props.sections.find(
		(section) => section.key === "agent"
	);
	return (
		<FullAccessSelectionProvider
			agentName={agentSection ? activeItemName(agentSection) : undefined}
		>
			<ComposerSettingsMenuContent {...props} />
		</FullAccessSelectionProvider>
	);
}

function ComposerSettingsMenuContent({
	sections,
	className,
	compact = false,
	footer,
	leading,
	trailing,
	trigger,
	renderBody,
	side = "top",
	align = "start",
}: ComposerSettingsMenuProps) {
	const [open, setOpen] = useState(false);
	const selectionGuard = useFullAccessSelectionGuard();
	const { animationsEnabled } = useChatDisplayPrefs();

	// A section stays visible while its options are still being probed, even with
	// no items yet — so an in-flight agent switch shows a loading row, not nothing.
	const isLoadingEmpty = (s: ComposerSettingsSection) =>
		Boolean(s.loading) && s.items.length === 0;
	const visibleSections = sections.filter(
		(s) => s.items.length > 0 || isLoadingEmpty(s)
	);
	// With a custom body (the universal picker) the summary may be empty while the
	// body still has content, so only bail when there's nothing at all to show.
	if (visibleSections.length === 0 && !renderBody) {
		return null;
	}

	// Each trigger segment carries its section's active decoration (icon + tone),
	// so the approval mode reads in the trigger with the SAME icon/colour it shows
	// inside the dropdown (agent/model have no `decorate`, so they stay plain).
	//
	// How those segments COMPOSE — a decorated mode collapsing to its icon,
	// reasoning effort becoming a bar meter on the model — is
	// `composeTriggerSummary`, kept pure in @ryu/blocks so the rules are testable
	// without a renderer. Everything here is the rendering of its verdict.
	const summary = visibleSections
		.map((section) => {
			const loading = isLoadingEmpty(section);
			const name = loading ? "Detecting…" : activeItemName(section);
			if (!name) {
				return null;
			}
			const deco = loading
				? undefined
				: section.decorate?.(activeItem(section) ?? { id: "", name: "" });
			return { section, name, deco, loading };
		})
		.filter(
			(
				s
			): s is {
				deco: ItemDecoration | undefined;
				loading: boolean;
				name: string;
				section: ComposerSettingsSection;
			} => s !== null
		);
	const decoByKey = new Map(
		summary.map((s) => [s.section.key, s.deco] as const)
	);
	const segments = composeTriggerSummary(
		summary.map((s) => ({
			key: s.section.key,
			name: s.name,
			// Icon-only keys off the RESOLVED decoration, never off the section
			// carrying a `decorate`: opencode's `mode` option decorates but its
			// default `build` matches no approval style, and an icon-less
			// text-less segment would drop the setting from the trigger entirely.
			decorated: Boolean(s.deco),
			effort: s.section.variant === "slider",
			loading: s.loading,
		}))
	);
	// The mode's word is redundant beside its icon + colour, but it is also the
	// only textual signal of the permission mode — keep it in the accessible name.
	const triggerLabel = [
		"Chat settings",
		...segments.map((seg) =>
			seg.effortName ? `${seg.name} ${seg.effortName}` : seg.name
		),
	].join(" · ");
	const sectionByKey = new Map(
		visibleSections.map((section) => [section.key, section])
	);
	const effortSections = visibleSections.filter(
		(section) =>
			section.variant === "slider" &&
			!section.loading &&
			section.items.length > 1
	);
	const findFoldedEffort = (segment: (typeof segments)[number]) =>
		segment.effortName
			? (effortSections.find(
					(section) => activeItemName(section) === segment.effortName
				) ?? effortSections[0])
			: undefined;
	const compactSegments = [
		segments.find((segment) => segment.key === "agent"),
		...segments.filter(
			(segment) => segment.key !== "agent" && segment.iconOnly
		),
	].filter((segment): segment is (typeof segments)[number] => Boolean(segment));

	/** Apply a setting without dismissing — users often chain model + thinking. */
	const selectItem = (section: ComposerSettingsSection) => (id: string) => {
		const item = section.items.find((candidate) => candidate.id === id);
		const apply = () => section.onChange(id);
		if (item && isFullAccessEquivalent(item, section.label)) {
			setOpen(false);
		}
		selectionGuard?.request(item ?? { id, name: id }, apply, section.label);
	};
	const closeMenu = () => setOpen(false);
	const footerContent = isNativeFunction(footer) ? footer(closeMenu) : footer;

	const renderRow = renderComposerSettingsRow(selectItem);

	return (
		<DropdownMenu onOpenChange={setOpen} open={open}>
			{trigger ? (
				<DropdownMenuTrigger render={trigger} />
			) : (
				<DropdownMenuTrigger
					render={
						<Button
							appearance="composer-settings"
							aria-label={triggerLabel}
							className={cn("min-w-0 max-w-full", className)}
							data-composer-settings-trigger="true"
							size="sm"
							type="button"
							variant="ghost"
						/>
					}
				>
					<span className="composer-settings-trigger-content flex min-w-0 items-center gap-1 truncate font-medium">
						{leading}
						{compact ? (
							// Compact mode keeps the agent identity plus the two settings that
							// benefit from a glanceable visual cue: decorated approval icons and
							// the effort meter. Model names and plain plugin values stay in the
							// picker, where they have room to be read.
							<>
								{compactSegments.map((segment, index) => {
									const deco = decoByKey.get(segment.key);
									return (
										<span
											className="composer-setting-segment flex min-w-0 items-center gap-1"
											data-composer-section={segment.key}
											data-composer-section-kind={
												segment.key === "agent" ? "agent" : "decorated"
											}
											key={segment.key}
											title={segment.iconOnly ? segment.name : undefined}
										>
											{index > 0 && (
												<span className="text-muted-foreground/70">·</span>
											)}
											{segment.loading ? (
												<HugeiconsIcon
													className={cn(
														"shrink-0 text-muted-foreground",
														animationsEnabled && "animate-spin"
													)}
													icon={Loading03Icon}
													size={13}
													strokeWidth={2}
												/>
											) : (
												deco && (
													<HugeiconsIcon
														aria-hidden="true"
														className={cn("shrink-0", deco.className)}
														icon={deco.icon}
														size={13}
														strokeWidth={2}
													/>
												)
											)}
											{segment.key === "agent" && (
												<span
													className="truncate"
													data-composer-agent-name="true"
												>
													{segment.name}
												</span>
											)}
										</span>
									);
								})}
								{effortSections.map((section) => (
									<Fragment key={`effort-${section.key}`}>
										<span className="text-muted-foreground/70">·</span>
										<EffortMeter section={section} />
									</Fragment>
								))}
							</>
						) : (
							segments.map((segment, i) => {
								const { key, name, effortName, iconOnly, loading } = segment;
								const deco = decoByKey.get(key);
								const section = sectionByKey.get(key);
								const foldedEffort = findFoldedEffort(segment);
								const isEffort = section?.variant === "slider";
								const kind = isEffort
									? "effort"
									: key === "agent"
										? "agent"
										: key === "model"
											? "model"
											: iconOnly
												? "decorated"
												: "plain";
								return (
									<span
										className="composer-setting-segment flex min-w-0 items-center gap-1"
										data-composer-section={key}
										data-composer-section-kind={kind}
										key={key}
										title={iconOnly ? name : undefined}
									>
										{i > 0 && (
											<span
												className="text-muted-foreground/70"
												data-composer-separator={key}
											>
												·
											</span>
										)}
										{loading ? (
											<HugeiconsIcon
												className={cn(
													"shrink-0 text-muted-foreground",
													animationsEnabled && "animate-spin"
												)}
												icon={Loading03Icon}
												size={13}
												strokeWidth={2}
											/>
										) : (
											deco && (
												<HugeiconsIcon
													aria-hidden="true"
													className={cn("shrink-0", deco.className)}
													data-composer-mode-icon="true"
													icon={deco.icon}
													size={13}
													strokeWidth={2}
												/>
											)
										)}
										{isEffort || iconOnly ? null : (
											<span
												className={cn(
													"truncate",
													loading ? "text-muted-foreground" : deco?.className
												)}
												data-composer-agent-name={
													key === "agent" ? "true" : undefined
												}
												data-composer-model-name={
													key === "model" ? "true" : undefined
												}
											>
												{name}
											</span>
										)}
										{!loading && isEffort && section ? (
											<EffortMeter section={section} />
										) : null}
										{!loading && effortName && foldedEffort ? (
											<EffortMeter section={foldedEffort} />
										) : null}
									</span>
								);
							})
						)}
						{trailing}
					</span>
					<HugeiconsIcon
						className="shrink-0 text-muted-foreground"
						icon={ArrowDown01Icon}
						size={12}
					/>
				</DropdownMenuTrigger>
			)}
			<DropdownMenuContent
				align={align}
				className={cn(
					renderBody
						? "min-w-[260px] max-w-[320px]"
						: "min-w-[200px] max-w-[280px]"
				)}
				side={side}
				sideOffset={6}
			>
				{renderBody
					? renderBody(closeMenu)
					: visibleSections.map((section) => {
							const loadingEmpty = isLoadingEmpty(section);
							const activeDeco = section.decorate?.(
								activeItem(section) ?? {
									id: "",
									name: "",
								}
							);
							let sectionBody: ReactNode;
							if (loadingEmpty) {
								sectionBody = (
									<div className="text-(length:--text-detail) flex items-center gap-2 px-2.5 py-2 text-muted-foreground">
										<HugeiconsIcon
											className={cn(
												"shrink-0",
												animationsEnabled && "animate-spin"
											)}
											icon={Loading03Icon}
											size={14}
											strokeWidth={2}
										/>
										<span>Detecting available options…</span>
									</div>
								);
							} else if (section.renderContent) {
								sectionBody = section.renderContent(selectItem(section));
							} else {
								sectionBody = section.items.map(renderRow(section));
							}
							return (
								<DropdownMenuSub key={section.key}>
									<DropdownMenuSubTrigger>
										<span className="text-(length:--text-detail) flex-1 text-muted-foreground">
											{section.label}
										</span>
										<span
											className={cn(
												"text-(length:--text-detail) flex max-w-[160px] items-center gap-1.5 text-muted-foreground",
												!loadingEmpty && activeDeco?.className
											)}
										>
											{loadingEmpty ? (
												<HugeiconsIcon
													className={cn(
														"shrink-0",
														animationsEnabled && "animate-spin"
													)}
													icon={Loading03Icon}
													size={14}
													strokeWidth={2}
												/>
											) : (
												activeDeco && (
													<HugeiconsIcon
														className="shrink-0"
														icon={activeDeco.icon}
														size={14}
														strokeWidth={2}
													/>
												)
											)}
											<span className="truncate">
												{loadingEmpty ? "Detecting…" : activeItemName(section)}
											</span>
										</span>
									</DropdownMenuSubTrigger>
									{/* Same rule as the universal picker's `SettingSub`: a
									    `renderContent` body brings its own scroller (double
									    scrollers feel stuck), but a plain item list has none,
									    so it must scroll here or be clipped unreachably. */}
									<DropdownMenuSubContent
										className={cn(
											"max-h-80 min-w-[220px] max-w-[300px]",
											section.renderContent
												? "overflow-hidden"
												: "overflow-y-auto"
										)}
									>
										{sectionBody}
									</DropdownMenuSubContent>
								</DropdownMenuSub>
							);
						})}
				{footerContent && (
					// `py-1`, not `pt-2 pb-1`: the extra top padding pushed "Manage
					// models" off the rule and left it floating in the footer band,
					// vertically off-centre against every other row in the menu.
					<div className="sticky bottom-0 z-10 shrink-0 border-border border-t bg-muted/90 py-1 backdrop-blur-2xl empty:hidden">
						{footerContent}
					</div>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
