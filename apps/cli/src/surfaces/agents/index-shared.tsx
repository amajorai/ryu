/* @jsxImportSource @opentui/react */
import { z } from "zod";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { HINT, hintText } from "../../core/keymap.ts";

export const EDIT_LABEL_WIDTH = 16;
export const PICKER_HEIGHT = 11;
export const EDIT_BACK_HINT = hintText([HINT.back]);
export const PICKER_HINT = hintText([
	HINT.move,
	{ keys: "Space/Enter", label: "toggle" },
	{ keys: "0", label: "none" },
	HINT.retry,
	HINT.back,
]);

export type Theme = ReturnType<typeof useTheme>;

const agentErrorSchema = z.instanceof(Error);
export function errText(
	err: Parameters<typeof agentErrorSchema.safeParse>[0]
): string {
	const parsed = agentErrorSchema.safeParse(err);
	return parsed.success ? parsed.data.message : String(err);
}

// A page header echoing the desktop page chrome: a bold title, a muted subtitle,
// and a muted key-hint line so the surface is self-describing without the shell.
export function PageHeader({
	title,
	subtitle,
	hint,
}: {
	hint: string;
	subtitle: string;
	title: string;
}) {
	const theme = useTheme();
	return (
		<box flexDirection="column" paddingLeft={1} paddingTop={1}>
			<text fg={theme.colors.foreground}>
				<b>{title}</b>
			</text>
			<text fg={theme.colors.mutedForeground}>{subtitle}</text>
			<text fg={theme.colors.mutedForeground}>{hint}</text>
		</box>
	);
}

export type FieldKey =
	| "name"
	| "title"
	| "engine"
	| "model"
	| "description"
	| "systemPrompt"
	| "personaDisplayName"
	| "personaTone"
	| "orchestrator"
	| "canCreateAgents"
	| "tools"
	| "skills"
	| "inference"
	| "identity"
	| "accountAccess";

export interface FieldDef {
	key: FieldKey;
	kind?: "text" | "toggle" | "picker" | "sampling" | "identity" | "access";
	label: string;
	placeholder: string;
}

export type PickerKind = "tools" | "skills";
export type CatalogStatus = "idle" | "loading" | "ready" | "error";

export interface PickerCatalog<T> {
	error: string | null;
	items: T[];
	status: CatalogStatus;
}

export const emptyCatalog = <T,>(): PickerCatalog<T> => ({
	error: null,
	items: [],
	status: "idle",
});
