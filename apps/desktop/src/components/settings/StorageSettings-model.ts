import { formatByteSize } from "@ryu/i18n/format-intl";
import { useMemo } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import type { ValidateResult } from "@/src/lib/api/data-path.ts";

/** Core refuses an export passphrase shorter than this (`data_path.rs`). */
export const MIN_BACKUP_PASSPHRASE_CHARS = 12;

/** Profiles a copy can target.
 *
 *  Mirrors the non-release rows of `PROFILE_PORT_OFFSETS`
 *  (apps/core/src/profile.rs) — the profiles that have their own port offset, data
 *  dir and keychain slot. `release` is deliberately absent: copying INTO your
 *  primary profile is a restore, which belongs to Backup & restore where it is
 *  guarded accordingly. */
export const PROFILE_COPY_TARGETS = [
	"dev",
	"canary",
	"nightly",
	"beta",
] as const;

/** One decimal at every scale ("512.0 B", "4.7 GB"), in the UI locale. */
export function humanBytes(n: number): string {
	return formatByteSize(n, undefined, {
		fractionDigits: 1,
		maxUnit: "terabyte",
	});
}

export interface PickedTarget {
	path: string;
	validation: ValidateResult;
}

/**
 * The selected node's authority. Every read and write on this tab is bound to
 * the node that is selected NOW, so a node switch rereads and a reply from the
 * previous node is discarded instead of being shown as this node's state.
 */
export function useSelectedNodeTarget(): ApiTarget {
	const node = useActiveNode();
	return useMemo(
		() => toTarget({ url: node.url, token: node.token, userJwt: node.userJwt }),
		[node.url, node.token, node.userJwt]
	);
}

export interface ProgressState {
	copied: number;
	phase: string;
	total: number;
}
