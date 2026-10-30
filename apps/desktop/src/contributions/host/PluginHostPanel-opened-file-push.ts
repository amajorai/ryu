import type { OpenedFileAccess } from "@ryu/app-host/opened-file";
import type { HostPush } from "@ryu/app-host/rpc";
import { useEffect, useRef } from "react";

/** Poll the host-opened file and push its metadata into the connected frame. */
export function useOpenedFilePush(
	fileAccess: OpenedFileAccess | undefined,
	connectedNonce: string | null,
	nonce: string
) {
	const filePushRef = useRef<((message: HostPush) => void) | null>(null);
	useEffect(() => {
		if (!fileAccess || connectedNonce !== nonce) {
			return;
		}
		let stopped = false;
		let revision: string | undefined;
		let inFlight = false;
		const refresh = async () => {
			if (stopped || inFlight) {
				return;
			}
			inFlight = true;
			try {
				const snapshot = await fileAccess.read();
				if (!stopped && snapshot.revision !== revision) {
					revision = snapshot.revision;
					filePushRef.current?.({
						kind: "ryu-widget-set-globals",
						globals: {
							openedFile: {
								uri: fileAccess.uri,
								name: fileAccess.name,
								editable: fileAccess.editable,
								revision,
							},
						},
					});
				}
			} catch {
				// The reader surfaces errors on its next scoped read; polling never fabricates content.
			} finally {
				inFlight = false;
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), 1000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [fileAccess, connectedNonce, nonce]);
	return filePushRef;
}
