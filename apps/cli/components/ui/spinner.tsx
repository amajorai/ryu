// @ts-nocheck - vendored termcn component, see scripts/vendor-termcn.ts
/* @jsxImportSource @opentui/react */
import type { BoxProps as OpenTUIBoxProps } from "@opentui/react";
import type { SpinnerName } from "cli-spinners";
import cliSpinners from "cli-spinners";
import { z } from "zod";

import { useTheme } from "@/components/ui/theme-provider";
import { useAnimation } from "@/hooks/use-animation";

export type SpinnerType = SpinnerName;

const spinnerNameSchema = z.custom<SpinnerName>((value) => {
	const parsed = z.string().safeParse(value);
	return parsed.success && Object.hasOwn(cliSpinners, parsed.data);
});
export const spinnerNames = z
	.array(spinnerNameSchema)
	.parse(Object.keys(cliSpinners));

export interface SpinnerProps extends OpenTUIBoxProps {
	type?: SpinnerType;
	label?: string;
	color?: string;
	fps?: number;
	frames?: string[];
}

export const Spinner = ({
	type = "dots",
	label,
	color,
	fps = 12,
	frames: customFrames,
	...props
}: SpinnerProps) => {
	const theme = useTheme();
	const builtin = cliSpinners[type] ?? cliSpinners.dots;
	const useCustomFrames = customFrames !== undefined;
	const frames = useCustomFrames ? customFrames : builtin.frames;
	const frame = useAnimation(
		useCustomFrames ? fps : { intervalMs: builtin.interval },
	);
	const icon = frames[frame % frames.length];
	const resolvedColor = color ?? theme.colors.primary;

	return (
		<box alignItems="center" flexDirection="row" {...props}>
			<text fg={resolvedColor}>{icon}</text>
			{label ? <text marginLeft={1}>{label}</text> : null}
		</box>
	);
};
