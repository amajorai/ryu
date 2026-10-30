"use client";
// The legacy iOS grouped-card presentation of the settings rows, kept behind
// `appearance="grouped"` on `SettingsGroup`, `SettingsCard` and
// `SettingsSection` for a caller that genuinely needs the old look. Nothing
// uses it by default: the quiet flush rows in `settings-items.tsx` are the
// standard settings presentation.
//
// In this look a row's `description` renders as a caption BELOW the card,
// never inside it: a row with a description closes its card, and
// description-less rows merge into the next card.

import { messageIdForLiteral } from "@ryu/i18n/core";
import { useOptionalI18n } from "@ryu/i18n/react";
import { ItemGroup, ItemSeparator } from "@ryu/ui/components/item";
import {
	isNativeFunction,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils";
import {
	Children,
	cloneElement,
	createContext,
	Fragment,
	isValidElement,
	type ReactElement,
	type ReactNode,
} from "react";

export type SettingsAppearance = "flush" | "grouped";

/**
 * The appearance of the enclosing `SettingsGroup`. A row reads it to decide
 * whether it renders its own description (flush) or leaves it to the group's
 * card footer (grouped).
 */
export const SettingsAppearanceContext =
	createContext<SettingsAppearance>("flush");

export const toItems = (children: ReactNode): ReactNode[] =>
	Children.toArray(children).filter(Boolean);

export const localizeSettingText = (
	i18n: ReturnType<typeof useOptionalI18n>,
	value: ReactNode,
	settingsId: string | undefined,
	field: "caption" | "description" | "title"
): ReactNode => {
	if (!(i18n && isNativeText(value)) || value.trim().length === 0) {
		return value;
	}
	const id = settingsId
		? `settings.${settingsId}.${field}`
		: messageIdForLiteral(value);
	return i18n.t(id, {}, value);
};

/**
 * Read the iOS-style footer text for a group child. `SettingsItem` carries it
 * as its `description` prop; wrapper components that render a `SettingsItem`
 * internally can opt in by accepting a `description` prop at their call site.
 */
const childDescription = (
	child: ReactNode,
	i18n: ReturnType<typeof useOptionalI18n>
): ReactNode => {
	if (!isValidElement(child)) {
		return null;
	}
	// SAFETY: SettingsGroup children are React settings rows, whose optional description/settingsId props follow this module's owner contract.
	const props = child.props as {
		description?: ReactNode;
		settingsId?: string;
	};
	return localizeSettingText(
		i18n,
		props.description,
		props.settingsId,
		"description"
	);
};

/**
 * The grouped card surface: `--grouped-card` (the muted tint on a plain page,
 * the raised card surface inside a `grouped-pane`), with the group's rounding.
 */
export const GROUPED_SURFACE = "rounded-xl bg-grouped-card";

/**
 * Read the `bare` opt-out from a group child: a control that is already a box
 * (a tall textarea, a code editor) renders outside the card so its own border
 * is the only edge.
 */
const childIsBare = (child: ReactNode): boolean => {
	if (!isValidElement(child)) {
		return false;
	}
	// SAFETY: bare is a boolean opt-in supplied by SettingsItem and its settings-row wrappers; exact true excludes other values.
	return (child.props as { bare?: boolean }).bare === true;
};

export const isFullBleedTextControl = (child: ReactNode): boolean => {
	if (!isValidElement(child)) {
		return false;
	}

	const type = child.type;
	if (!isNativeFunction(type)) {
		return false;
	}

	return type.name === "Input" || type.name === "Textarea";
};

/** Stretch a lone Input/Textarea to the grouped card's edges. */
export const renderGroupedSettingControl = (children: ReactNode): ReactNode => {
	if (!isFullBleedTextControl(children)) {
		return children;
	}

	// SAFETY: isFullBleedTextControl accepted only React elements owned by Input/Textarea, whose className prop is optional text.
	const control = children as ReactElement<{ className?: string }>;
	return cloneElement(control, {
		className: cn(
			"-mx-3.5 w-[calc(100%+1.75rem)] rounded-none",
			control.props.className
		),
	});
};

interface GroupedSettingsGroupProps {
	children: ReactNode;
	className?: string;
}

/**
 * The legacy grouped card of rows. A child that carries a `description` closes
 * the current card and its description renders as a muted caption below it; a
 * `bare` child renders outside any card.
 */
export const GroupedSettingsGroup = ({
	children,
	className,
}: GroupedSettingsGroupProps) => {
	const i18n = useOptionalI18n();
	const items = toItems(children);

	const slices: {
		bare?: boolean;
		caption: ReactNode;
		rows: ReactNode[];
	}[] = [];
	let pending: ReactNode[] = [];
	for (const child of items) {
		if (childIsBare(child)) {
			if (pending.length > 0) {
				slices.push({ caption: null, rows: pending });
				pending = [];
			}
			// A bare row renders its OWN description, so no caption here.
			slices.push({ bare: true, caption: null, rows: [child] });
			continue;
		}
		pending.push(child);
		const caption = childDescription(child, i18n);
		if (caption) {
			slices.push({ caption, rows: pending });
			pending = [];
		}
	}
	if (pending.length > 0) {
		slices.push({ caption: null, rows: pending });
	}

	const renderCard = (rows: ReactNode[]) => (
		<ItemGroup
			appearance="settings-group"
			className={cn("overflow-hidden", className)}
			spacing="flush"
		>
			{rows.map((child, index) => (
				<Fragment key={index}>
					{child}
					{index < rows.length - 1 ? <ItemSeparator className="my-0" /> : null}
				</Fragment>
			))}
		</ItemGroup>
	);

	// Always the same root element, so a description appearing while a control
	// is focused never remounts the rows and drops focus.
	return (
		<SettingsAppearanceContext.Provider value="grouped">
			<div className="space-y-1.5">
				{slices.map((slice, sliceIndex) => (
					<Fragment key={sliceIndex}>
						{slice.bare ? slice.rows : renderCard(slice.rows)}
						{slice.caption ? (
							<p className="px-3.5 pb-1.5 text-muted-foreground text-xs leading-snug">
								{slice.caption}
							</p>
						) : null}
					</Fragment>
				))}
			</div>
		</SettingsAppearanceContext.Provider>
	);
};
