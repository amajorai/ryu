// One of a renderer's settings driven from inside the view: the live param
// is the source of truth, an in-view control changes it at once and saves
// the choice through `InterfacePort.updateSettings` (so it survives a
// remount and shows in Settings → Appearance → Interfaces), and a new param
// from the host (Settings, a reset) replaces the local value. Hosts without
// `updateSettings` still get the change for as long as the view is mounted.

import type {
	InterfacePort,
	InterfaceSettingValue,
} from "@ryuhq/protocol/interfaces";
import { useCallback, useRef, useState } from "react";

export type SettingUpdate<V> = V | ((current: V) => V);

export function useInterfaceSetting<V extends InterfaceSettingValue>(
	port: InterfacePort,
	key: string,
	param: V
): [V, (next: SettingUpdate<V>) => void] {
	const [value, setValue] = useState<V>(param);
	const [seenParam, setSeenParam] = useState<V>(param);
	if (seenParam !== param) {
		setSeenParam(param);
		setValue(param);
	}
	const latest = useRef(value);
	latest.current = value;
	const portRef = useRef(port);
	portRef.current = port;
	const update = useCallback(
		(next: SettingUpdate<V>) => {
			const resolved =
				typeof next === "function"
					? (next as (current: V) => V)(latest.current)
					: next;
			if (resolved === latest.current) {
				return;
			}
			latest.current = resolved;
			setValue(resolved);
			portRef.current.updateSettings?.({ [key]: resolved });
		},
		[key]
	);
	return [value, update];
}
