// @ts-nocheck - vendored termcn component, see scripts/vendor-termcn.ts
/* @jsxImportSource @opentui/react */

import type { ReactNode } from "react";
import React from "react";
import { z } from "zod";

import { useTheme } from "@/components/ui/theme-provider";
import type { BigTextFont } from "./big-text";
import { BigText } from "./big-text";

export interface HelpScreenProps {
	title: string;
	font?: BigTextFont;
	titleColor?: string;
	tagline?: string;
	usage?: string;
	description?: string;
	columnGap?: number;
	flagWidth?: number;
	children: ReactNode;
}

export interface HelpScreenSectionProps {
	label: string;
	labelColor?: string;
	children: ReactNode;
}

export interface HelpScreenRowProps {
	flag: string;
	description: string;
	flagColor?: string;
	descriptionColor?: string;
}

// Clone overrides are owned numeric fields; the original element props remain opaque.
interface HelpScreenLayoutFields extends React.Attributes {
	_columnGap?: number;
	_flagWidth?: number;
}
const sectionChildrenSchema = z.object({
	children: z
		.custom<ReactNode>((value) => {
			try {
				React.Children.count(value);
				return true;
			} catch {
				return false;
			}
		})
		.optional(),
});
// Flag width historically follows native truthiness and String conversion.
const rowFlagSchema = z.object({
	flag: z.preprocess(
		(value) => value || undefined,
		z.coerce.string().optional(),
	),
});

const computeFlagWidth = (children: ReactNode): number => {
	let max = 0;
	React.Children.forEach(children, (section) => {
		if (!React.isValidElement(section)) return;
		const sectionProps = sectionChildrenSchema.parse(section.props);
		React.Children.forEach(sectionProps.children, (row) => {
			if (!React.isValidElement(row)) return;
			const { flag } = rowFlagSchema.parse(row.props);
			if (flag) max = Math.max(max, flag.length);
		});
	});
	return max;
};

const HelpScreenRoot = ({
	title,
	titleColor,
	tagline,
	usage,
	description,
	columnGap = 4,
	flagWidth,
	children,
}: HelpScreenProps) => {
	const theme = useTheme();
	const resolvedColor = titleColor ?? theme.colors.primary;

	const resolvedFlagWidth = flagWidth ?? computeFlagWidth(children);

	const enrichedChildren = React.Children.map(children, (child) => {
		if (React.isValidElement(child)) {
			const layout: HelpScreenLayoutFields = {
				_columnGap: columnGap,
				_flagWidth: resolvedFlagWidth,
			};
			return React.cloneElement(child, layout);
		}
		return child;
	});

	return (
		<box flexDirection="column" paddingLeft={2}>
			<box marginBottom={1}>
				<BigText color={resolvedColor}>{title}</BigText>
			</box>

			{tagline && (
				<box marginBottom={1}>
					<text fg="#666">{tagline}</text>
				</box>
			)}

			{usage && (
				<box marginBottom={1}>
					<text>
						<text fg="#666">{"Usage: "}</text>
						{usage}
					</text>
				</box>
			)}

			{description && (
				<box marginBottom={1}>
					<text>{description}</text>
				</box>
			)}

			{enrichedChildren}
		</box>
	);
};

const HelpScreenSection = ({
	label,
	labelColor,
	children,
	_flagWidth = 20,
	_columnGap = 4,
}: HelpScreenSectionProps & {
	_flagWidth?: number;
	_columnGap?: number;
}) => {
	const theme = useTheme();

	const enrichedRows = React.Children.map(children, (child) => {
		if (React.isValidElement(child)) {
			const layout: HelpScreenLayoutFields = { _columnGap, _flagWidth };
			return React.cloneElement(child, layout);
		}
		return child;
	});

	return (
		<box flexDirection="column" marginBottom={1}>
			<text fg={labelColor ?? theme.colors.foreground}>
				<b>{label}</b>
			</text>
			{enrichedRows}
		</box>
	);
};

const HelpScreenRow = ({
	flag,
	description,
	flagColor,
	descriptionColor,
	_flagWidth = 20,
	_columnGap = 4,
}: HelpScreenRowProps & {
	_flagWidth?: number;
	_columnGap?: number;
}) => {
	const theme = useTheme();
	const paddedFlag = flag.padEnd(_flagWidth + _columnGap);

	return (
		<box flexDirection="row" paddingLeft={2}>
			<text fg={flagColor ?? theme.colors.mutedForeground}>{paddedFlag}</text>
			<text fg={descriptionColor}>{description}</text>
		</box>
	);
};

export const HelpScreen = Object.assign(HelpScreenRoot, {
	Row: HelpScreenRow,
	Section: HelpScreenSection,
});
