// Refreshes the vault queries when Core reports a vault change, while the
// component using it is mounted (see `lib/vault-change-stream.ts`).

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { openVaultChangeStream } from "@/src/lib/api/vault-events.ts";
import { watchVaultChanges } from "@/src/lib/vault-change-stream.ts";

export function useVaultChangeStream(target: ApiTarget): void {
	const queryClient = useQueryClient();
	const { token, url, userJwt } = target;
	useEffect(() => {
		const controller = new AbortController();
		watchVaultChanges({
			onChange: () => {
				queryClient.invalidateQueries({ queryKey: ["vault"] });
			},
			open: (signal) => openVaultChangeStream({ token, url, userJwt }, signal),
			signal: controller.signal,
		}).catch(() => undefined);
		return () => controller.abort();
	}, [queryClient, token, url, userJwt]);
}
