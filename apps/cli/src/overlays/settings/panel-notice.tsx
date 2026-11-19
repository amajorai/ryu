/* @jsxImportSource @opentui/react */
// A settings panel's one-line notice. The notice carries whether it reports a
// failure, so its colour never depends on reading the (already translated)
// text: "Konnte nicht widerrufen" is as red as "Could not revoke".

import { useCallback, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";

export interface PanelNotice {
	kind: "error" | "ok";
	text: string;
}

/** Notice state: `setMessage` reports a result, `setFailure` an error. */
export function usePanelNotice() {
	const [notice, setNotice] = useState<PanelNotice | null>(null);
	const setMessage = useCallback((text: string) => {
		setNotice(text ? { kind: "ok", text } : null);
	}, []);
	const setFailure = useCallback((text: string) => {
		setNotice(text ? { kind: "error", text } : null);
	}, []);
	return { notice, setFailure, setMessage };
}

/** The notice line, coloured by its kind (nothing when there is none). */
export function PanelNoticeText({
	error = false,
	notice,
}: {
	/** Force the error colour (the whole panel failed to load). */
	error?: boolean;
	notice: PanelNotice | null;
}) {
	const theme = useTheme();
	if (!notice) {
		return null;
	}
	return (
		<text
			fg={
				error || notice.kind === "error"
					? theme.colors.error
					: theme.colors.success
			}
		>
			{notice.text}
		</text>
	);
}
