import { Button } from "@ryu/ui/components/button";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sileo } from "sileo";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { toTarget, type ApiTarget } from "@/src/lib/api/client.ts";

export interface VoicePreferenceAuthority {
	target: ApiTarget;
	pendingWrite: Promise<void> | null;
}

/** An opaque mount identity changes only when the request authority changes. */
export function useVoicePreferenceScope() {
	const node = useActiveNode();
	const url = node.url;
	const token = node.token ?? null;
	const userJwt = node.userJwt ?? null;
	const scopeSequence = useRef(0);
	const authorities = useRef<VoicePreferenceAuthority[]>([]);
	return useMemo(() => {
		scopeSequence.current += 1;
		let resource = authorities.current.find(
			(entry) =>
				entry.target.url === url &&
				entry.target.token === token &&
				entry.target.userJwt === userJwt
		);
		if (!resource) {
			resource = {
				target: toTarget({ url, token, userJwt }),
				pendingWrite: null,
			};
			authorities.current.push(resource);
		}
		return { id: scopeSequence.current, target: resource.target, resource };
	}, [url, token, userJwt]);
}

export function useVoicePreference<T>(
	target: ApiTarget,
	defaults: T,
	read: (target: ApiTarget) => Promise<T>,
	write: (target: ApiTarget, next: T) => Promise<boolean>,
	resource: VoicePreferenceAuthority
) {
	const [prefs, setPrefs] = useState(defaults);
	const [loaded, setLoaded] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<"read" | "write" | null>(null);
	const failedSave = useRef<T | null>(null);
	const pendingRef = useRef(false);
	const mounted = useRef(true);
	const readVersion = useRef(0);
	const load = useCallback(async () => {
		const version = ++readVersion.current;
		setLoaded(false);
		setError(null);
		try {
			// Returning to an authority must read after its previous write settles.
			await resource.pendingWrite;
			if (!mounted.current || version !== readVersion.current) return;
			const saved = await read(target);
			if (!mounted.current || version !== readVersion.current) return;
			setPrefs(saved);
			setLoaded(true);
		} catch {
			if (mounted.current && version === readVersion.current) setError("read");
		}
	}, [target, read, resource]);
	useEffect(() => {
		mounted.current = true;
		void load();
		return () => {
			mounted.current = false;
			++readVersion.current;
		};
	}, [load]);
	const persist = useCallback(
		async (next: T) => {
			if (
				!mounted.current ||
				!loaded ||
				pendingRef.current ||
				resource.pendingWrite
			)
				return;
			pendingRef.current = true;
			let settleWrite: () => void = () => {};
			resource.pendingWrite = new Promise<void>((resolve) => {
				settleWrite = resolve;
			});
			setPending(true);
			setError(null);
			try {
				if (!(await write(target, next)))
					throw new Error("Voice preference was not saved.");
				if (!mounted.current) return;
				setPrefs(next);
				failedSave.current = null;
			} catch (cause) {
				if (!mounted.current) return;
				failedSave.current = next;
				setError("write");
				sileo.error({
					title: "Could not save voice settings",
					description: cause instanceof Error ? cause.message : String(cause),
				});
			} finally {
				resource.pendingWrite = null;
				settleWrite();
				pendingRef.current = false;
				if (mounted.current) setPending(false);
			}
		},
		[loaded, target, write, resource]
	);
	const retry = () => {
		if (error === "read") void load();
		else if (failedSave.current !== null) void persist(failedSave.current);
	};
	return {
		prefs,
		persist,
		disabled: !loaded || pending,
		error,
		retry,
		pending,
	};
}

export function VoicePreferenceStatus({
	error,
	retry,
	pending,
}: {
	error: "read" | "write" | null;
	retry: () => void;
	pending: boolean;
}) {
	if (!error) return null;
	return (
		<div role="alert">
			<p>
				{error === "read"
					? "Could not load voice settings. Your saved settings have not been changed."
					: "Could not save voice settings. The previous saved settings are still selected."}
			</p>
			<Button disabled={pending} onClick={retry} size="sm" variant="ghost">
				Retry
			</Button>
		</div>
	);
}
