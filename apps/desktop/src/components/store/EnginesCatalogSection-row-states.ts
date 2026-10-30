import { useLiteralMessages } from "@ryu/i18n/react";
import { useRef, useState } from "react";
import { useVoiceAuthority } from "@/src/hooks/useVoiceAuthority.ts";
import {
	EMPTY_ROW_STATE,
	type PendingKind,
	type RowState,
} from "./EnginesCatalogSection-model.ts";

export function useRowStates() {
	const tl = useLiteralMessages();
	const { authority, isCurrent } = useVoiceAuthority("engine-row-actions");
	const pendingRows = useRef(
		new Map<string, { authority: typeof authority }>()
	);
	const [rowView, setRowView] = useState({
		authority,
		rows: {} as Record<string, RowState>,
	});
	const rowStates = rowView.authority === authority ? rowView.rows : {};
	const rowState = (name: string): RowState =>
		rowStates[name] ?? EMPTY_ROW_STATE;
	const patchRow = (name: string, patch: Partial<RowState>) => {
		if (!isCurrent()) {
			return;
		}
		setRowView((prev) => {
			const rows = prev.authority === authority ? prev.rows : {};
			return {
				authority,
				rows: {
					...rows,
					[name]: { ...(rows[name] ?? EMPTY_ROW_STATE), ...patch },
				},
			};
		});
	};
	const runAction = async (
		name: string,
		kind: PendingKind,
		action: () => Promise<void>
	) => {
		if (
			!isCurrent() ||
			pendingRows.current.get(name)?.authority === authority
		) {
			return;
		}
		const ticket = { authority };
		pendingRows.current.set(name, ticket);
		patchRow(name, { pending: kind, error: null, gatewayStale: false });
		try {
			await action();
		} catch (e) {
			if (isCurrent()) {
				patchRow(name, {
					error:
						e instanceof Error
							? e.message
							: tl("Failed to {kind} {name}", { kind, name }),
				});
			}
		} finally {
			if (pendingRows.current.get(name) === ticket) {
				pendingRows.current.delete(name);
				if (isCurrent()) {
					patchRow(name, { pending: null });
				}
			}
		}
	};
	return { rowState, patchRow, runAction };
}
