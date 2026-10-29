import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	getPreference,
	setKeybindingEntry,
} from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

function authority(target: ApiTarget): string {
	return JSON.stringify([target.url, target.token, target.userJwt ?? null]);
}
function parseDocument(raw: string | null): Record<string, string | null> {
	if (raw === null) {
		return {};
	}
	const value: unknown = JSON.parse(raw);
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.values(value).some(
			(entry) => entry !== null && typeof entry !== "string"
		)
	) {
		throw new Error("Invalid plugin shortcut document");
	}
	return value as Record<string, string | null>;
}

/** Per-entry writes (applied atomically by Core) preserve unrelated overrides; a result for a node the editor has left is not applied to the UI. */
export function usePluginShortcutOverrides(target: ApiTarget) {
	const getNode = useActiveNodeGetter();
	const [state, setState] = useState<{
		key: string;
		overrides: Record<string, string | null>;
		status: "loading" | "ready" | "error";
	}>({ key: "", overrides: {}, status: "loading" });
	const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
	const epoch = useRef(0);
	const readSequence = useRef(0);
	const alive = useRef(false);
	const busy = useRef(new Map<string, { generation: number }>());
	const currentKey = useRef(authority(target));
	const key = authority(target);
	useEffect(() => {
		alive.current = true;
		currentKey.current = authority(toTarget(getNode()));
		const dispose = useNodeStore.subscribe(() => {
			const nextKey = authority(toTarget(getNode()));
			if (currentKey.current !== nextKey) {
				currentKey.current = nextKey;
				epoch.current += 1;
			}
		});
		return () => {
			alive.current = false;
			epoch.current += 1;
			dispose();
		};
	}, [getNode]);
	const load = useCallback(async () => {
		if (!alive.current) {
			return;
		}
		const generation = epoch.current;
		const readId = ++readSequence.current;
		const readTarget = toTarget(getNode());
		const readKey = authority(readTarget);
		setState({ key: readKey, overrides: {}, status: "loading" });
		try {
			const overrides = parseDocument(
				await getPreference(readTarget, "keybindings")
			);
			if (
				alive.current &&
				readId === readSequence.current &&
				generation === epoch.current &&
				readKey === authority(toTarget(getNode()))
			) {
				setState({ key: readKey, overrides, status: "ready" });
			}
		} catch {
			if (
				alive.current &&
				readId === readSequence.current &&
				generation === epoch.current &&
				readKey === authority(toTarget(getNode()))
			) {
				setState({ key: readKey, overrides: {}, status: "error" });
			}
		}
	}, [getNode]);
	useEffect(() => {
		if (key === authority(toTarget(getNode()))) {
			void load();
		}
	}, [key, load, getNode]);
	const save = async (appId: string, value: string | null | undefined) => {
		if (
			!alive.current ||
			busy.current.has(key) ||
			state.key !== key ||
			state.status !== "ready" ||
			authority(toTarget(getNode())) !== key
		) {
			return;
		}
		const writeTarget = toTarget(getNode());
		const writeKey = authority(writeTarget);
		const owner = { generation: epoch.current };
		busy.current.set(writeKey, owner);
		setPending(new Set(busy.current.keys()));
		const stillCurrent = () =>
			alive.current &&
			owner.generation === epoch.current &&
			writeKey === authority(toTarget(getNode()));
		try {
			// Core applies this one entry under its own lock and answers with the
			// whole stored document, so a concurrent edit of another shortcut (from
			// another window) is kept rather than overwritten by a stale copy.
			const next = parseDocument(
				await setKeybindingEntry(writeTarget, `plugin:${appId}`, value)
			);
			if (stillCurrent()) {
				setState({ key: writeKey, overrides: next, status: "ready" });
			}
		} catch {
			if (stillCurrent()) {
				toast.error({ title: "Couldn't update plugin shortcut" });
			}
		} finally {
			if (busy.current.get(writeKey) === owner) {
				busy.current.delete(writeKey);
			}
			if (alive.current) {
				setPending(new Set(busy.current.keys()));
			}
		}
	};
	return {
		overrides: state.key === key ? state.overrides : {},
		disabled: state.key !== key || state.status !== "ready" || pending.has(key),
		error: state.key === key && state.status === "error",
		retry: load,
		save,
	};
}
