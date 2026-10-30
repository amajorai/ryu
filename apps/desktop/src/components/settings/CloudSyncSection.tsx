import { Button } from "@ryu/ui/components/button.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sileo } from "sileo";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, apiUrl, toTarget } from "@/src/lib/api/client.ts";
import {
	getNodeAuthState,
	type NodeAuthState,
} from "@/src/lib/api/node-auth.ts";
import {
	DEFAULT_CLOUD_SYNC,
	getCloudSyncEnabled,
	setCloudSyncEnabled,
} from "@/src/lib/api/preferences.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

const SYNC_PREFERENCE_PATH = "/api/preferences/cloud-sync-enabled";
interface SyncResource {
	acceptedRevision: number;
	observers: Set<(writer: ApiTarget) => void>;
	pendingWrites: number;
}
// A pending request can outlive its view. Keep its node-wide revision and notify
// other mounted views in this window when Core accepts the captured write.
const syncResources = new Map<string, SyncResource>();
function getSyncResource(endpoint: string): SyncResource {
	const existing = syncResources.get(endpoint);
	if (existing) {
		return existing;
	}
	const created: SyncResource = {
		acceptedRevision: 0,
		pendingWrites: 0,
		observers: new Set(),
	};
	syncResources.set(endpoint, created);
	return created;
}
function releaseSyncResource(endpoint: string, resource: SyncResource) {
	if (
		resource.pendingWrites === 0 &&
		resource.observers.size === 0 &&
		syncResources.get(endpoint) === resource
	) {
		syncResources.delete(endpoint);
	}
}

/**
 * The cross-device sync switch (M10). Writes Core's `cloud-sync-enabled` pref on
 * the active node; Core's sync loop re-reads it every tick, so a flip takes effect
 * without a restart (`apps/core/src/server/sync.rs`).
 *
 * The loop also needs the NODE to be signed in; and `RYU_SYNC_ENABLED` in the
 * node's environment takes precedence over the UI preference, so OFF here does
 * not prove sync is off on a node that sets it.
 */
export function CloudSyncSection() {
	const activeNode = useActiveNode();
	const target: ApiTarget = useMemo(
		() => toTarget(activeNode),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);

	// The object identifies this connection lifetime, including A -> B -> A.
	const currentTarget = useRef(target);
	currentTarget.current = target;
	const mounted = useRef(false);
	const readGeneration = useRef(0);
	const pendingTarget = useRef<ApiTarget | null>(null);
	const [savingTarget, setSavingTarget] = useState<ApiTarget | null>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const [enabled, setEnabled] = useState(DEFAULT_CLOUD_SYNC);
	const [nodeAuth, setNodeAuth] = useState<NodeAuthState>(null);
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState(false);
	const [reloadKey, setReloadKey] = useState(0);

	useEffect(() => {
		let endpoint: string;
		try {
			endpoint = apiUrl(target, SYNC_PREFERENCE_PATH);
		} catch {
			return;
		}
		const resource = getSyncResource(endpoint);
		const onAccepted = (writer: ApiTarget) => {
			if (
				!mounted.current ||
				currentTarget.current !== target ||
				writer === target
			) {
				return;
			}
			readGeneration.current += 1;
			setLoaded(false);
			setReloadKey((current) => current + 1);
		};
		resource.observers.add(onAccepted);
		return () => {
			resource.observers.delete(onAccepted);
			releaseSyncResource(endpoint, resource);
		};
	}, [target]);

	useEffect(() => {
		const generation = ++readGeneration.current;
		let cancelled = false;
		setLoaded(false);
		setLoadError(false);
		Promise.all([getCloudSyncEnabled(target), getNodeAuthState(target)])
			.then(([syncOn, auth]) => {
				if (
					cancelled ||
					!mounted.current ||
					currentTarget.current !== target ||
					generation !== readGeneration.current
				) {
					return;
				}
				setEnabled(syncOn);
				setNodeAuth(auth);
				setLoaded(true);
			})
			.catch(() => {
				if (
					cancelled ||
					!mounted.current ||
					currentTarget.current !== target ||
					generation !== readGeneration.current
				) {
					return;
				}
				setLoadError(true);
			});
		return () => {
			cancelled = true;
		};
	}, [target, reloadKey]);

	const handleToggle = useCallback(
		async (next: boolean) => {
			if (
				!loaded ||
				nodeAuth === "signed-out" ||
				pendingTarget.current === target
			) {
				return;
			}
			let resource: string;
			try {
				resource = apiUrl(target, SYNC_PREFERENCE_PATH);
			} catch {
				return;
			}
			const previous = enabled;
			const shared = getSyncResource(resource);
			const previousRevision = shared.acceptedRevision;
			shared.pendingWrites += 1;
			pendingTarget.current = target;
			setSavingTarget(target);
			setEnabled(next);
			let saved = false;
			try {
				saved = await setCloudSyncEnabled(target, next);
			} catch {
				// The captured node may refuse the write after its view is retired.
			} finally {
				if (pendingTarget.current === target) {
					pendingTarget.current = null;
				}
				if (mounted.current && currentTarget.current === target) {
					setSavingTarget(null);
				}
			}
			// Publish Core's accepted node-wide outcome before checking the origin
			// view's lifetime. A remounted view still needs authoritative readback.
			if (saved) {
				shared.acceptedRevision += 1;
				for (const observer of shared.observers) {
					observer(target);
				}
			}
			shared.pendingWrites -= 1;
			releaseSyncResource(resource, shared);
			if (!mounted.current) {
				return;
			}
			if (saved) {
				if (currentTarget.current === target) {
					// A reconciliation GET may contain a snapshot from before this
					// accepted write. Its body must not replace the newer value.
					readGeneration.current += 1;
					setLoaded(true);
					setLoadError(false);
					setEnabled(next);
					return;
				}
				// Current subscribers were notified through the physical resource.
				return;
			}
			if (currentTarget.current !== target) {
				return;
			}
			if (shared.acceptedRevision === previousRevision) {
				setEnabled(previous);
			} else {
				// Another connection's accepted save changed the same node while
				// this request was pending; the pre-write Boolean is obsolete.
				readGeneration.current += 1;
				setLoaded(false);
				setReloadKey((current) => current + 1);
			}
			sileo.error({
				title: "Couldn't save your sync choice",
				description: "Check your connection to this node and try again.",
			});
		},
		[enabled, loaded, nodeAuth, target]
	);

	// Fail open on an unreadable auth status: only a node that is known to be
	// signed out blocks the switch, so an unreachable/older Core cannot lock it.
	const signedOut = nodeAuth === "signed-out";
	const description = signedOut
		? "Sign in on this node to sync across devices. Until then, syncing stays paused even when this is on."
		: "Off by default. When on, this node mirrors your chats and editable Spaces documents to your Ryu account so your other devices can pick them up. Binary file attachments stay local. Takes effect within a minute, with no restart.";

	return (
		<SettingsSection
			caption="Keep chats and Spaces documents in step across the devices signed in to your account. Everything stays on this device until you turn this on."
			title="Cross-device sync"
		>
			{loadError ? (
				<div className="mx-3 flex flex-col items-start gap-3 rounded-lg bg-muted p-4">
					<p className="text-muted-foreground text-sm">
						We couldn't read this node's sync settings.
					</p>
					<Button
						onClick={() => setReloadKey((current) => current + 1)}
						size="sm"
						variant="ghost"
					>
						Retry
					</Button>
				</div>
			) : (
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Sync my chats and Spaces across devices"
								checked={enabled}
								disabled={!loaded || signedOut || savingTarget === target}
								id="cloud-sync-enabled"
								onCheckedChange={handleToggle}
							/>
						}
						description={description}
						title="Sync my chats and Spaces across devices"
					/>
				</SettingsGroup>
			)}
		</SettingsSection>
	);
}
