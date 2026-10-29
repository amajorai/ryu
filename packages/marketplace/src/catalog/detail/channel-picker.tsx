import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
// packages/marketplace/src/catalog/detail/channel-picker.tsx
//
// The release-train selector shown beside a listing's install control.
//
// A listing can publish more than one train — `stable` plus any of `beta`, `rc`,
// `nightly`, `canary`, whatever its published versions spell — and the train is
// read off the version itself (`1.4.0-beta.2` IS the beta channel), never
// declared. This component only PRESENTS what the host resolved; it invents
// nothing, which is why a listing with a single train renders no control at all
// rather than a dropdown with one entry.
//
// Two rules it exists to make visible:
//
//   - a channel selects only its OWN builds, so a prerelease train can sit BEHIND
//     stable (a beta cut before the last patch is genuinely older), and
//   - a train that is browse-only — derived from a repository's git tags rather
//     than served by the marketplace — can never be installed, so it is shown as
//     context and never as a choice.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { useEffect, useState } from "react";
import { stabilityLabel } from "../stability.ts";
import type { CatalogChannel } from "../types.ts";

/** The train every listing has, and the one a picker defaults to. */
export const STABLE_CHANNEL = "stable";

/** Display label for a channel. Reuses the store's stability vocabulary so
 *  "beta" reads as "Beta" in the picker exactly as it reads on a badge, and an
 *  unrecognised train (an author's own `edge`, say) still renders legibly rather
 *  than being dropped. */
export function channelLabel(channel: string): string {
	if (channel === STABLE_CHANNEL) {
		return "Stable";
	}
	return stabilityLabel(channel) ?? channel;
}

/** Load the trains a listing publishes.
 *
 *  Returns an empty list on any failure. That is deliberate and load-bearing: a
 *  failed read means "unknown", and the caller renders no picker — it must never
 *  be allowed to collapse into "stable is the only option", because that is
 *  indistinguishable from a listing whose betas simply could not be fetched. */
export function useListingChannels(
	id: string,
	repo: string | null | undefined,
	fetchChannels:
		| ((id: string, repo?: string | null) => Promise<CatalogChannel[]>)
		| undefined
) {
	const [channels, setChannels] = useState<CatalogChannel[]>([]);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (!fetchChannels) {
			return;
		}
		// A question nothing can answer is not worth asking. Channels resolve one of
		// two ways: by a SCOPED marketplace id (`@scope/name`), or by a git repo URL.
		// The git catalog publishes each listing under its DIRECTORY BASENAME
		// (`tools/generate-marketplace.mjs` sets `name: dirName`, explicitly not the
		// manifest id), and no alias table maps a basename onto a plugin id — so a
		// bare `hook-observers` with no repo can never match anything upstream. It
		// cost one guaranteed-empty request per preview open, and against an older
		// Core it was a 400 in the console.
		//
		// Returning empty here keeps the "empty means UNKNOWN, never stable-only"
		// contract above intact: the caller renders no picker, which is the same
		// thing a failed fetch produces.
		const askable = Boolean(repo) || id.startsWith("@");
		if (!askable) {
			setChannels([]);
			return;
		}
		let live = true;
		setLoading(true);
		fetchChannels(id, repo)
			.then((resolved) => {
				if (live) {
					setChannels(resolved);
				}
			})
			.catch(() => {
				if (live) {
					setChannels([]);
				}
			})
			.finally(() => {
				if (live) {
					setLoading(false);
				}
			});
		return () => {
			live = false;
		};
	}, [id, repo, fetchChannels]);

	return { channels, loading };
}

/** Compare two versions the way semver precedence does, well enough to answer
 *  "is the target older?" — numeric release parts first, then the rule that
 *  matters here: a version WITH a prerelease suffix ranks below the same release
 *  without one (`1.4.0-beta.1 < 1.4.0`). Returns `null` when either version
 *  cannot be read, so an unparseable one says nothing rather than guessing. */
function comparePrecedence(a: string, b: string): number | null {
	const parse = (raw: string) => {
		const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(
			raw.trim()
		);
		if (!match) {
			return null;
		}
		return {
			parts: [
				Number(match[1] ?? 0),
				Number(match[2] ?? 0),
				Number(match[3] ?? 0),
			],
			pre: match[4] ?? "",
		};
	};
	const left = parse(a);
	const right = parse(b);
	if (!(left && right)) {
		return null;
	}
	for (let i = 0; i < 3; i++) {
		const delta = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
		if (delta !== 0) {
			return delta;
		}
	}
	if (left.pre === right.pre) {
		return 0;
	}
	if (!left.pre) {
		return 1;
	}
	if (!right.pre) {
		return -1;
	}
	return left.pre < right.pre ? -1 : 1;
}

/** The sentence a channel switch is confirmed against: what is installed, what
 *  the target train currently holds, and — when it applies — that the move goes
 *  BACKWARDS. The last part is the reason this dialog exists at all. */
export function ChannelSwitchSummary({
	channels,
	installedVersion,
	target,
}: {
	channels: CatalogChannel[];
	installedVersion?: string | null;
	/** The train being switched to. `null` is stable. */
	target: string | null;
}) {
	const tl = useLiteralMessages();
	const name = channelLabel(target ?? STABLE_CHANNEL);
	const targetVersion =
		channels.find((c) => c.channel === (target ?? STABLE_CHANNEL))?.version ??
		null;

	if (!targetVersion) {
		// A train with nothing published on it. Following it is still a legitimate
		// choice — it is how you subscribe to a channel before its first build — but
		// it must not read as "you will be updated to something".
		const buildName = name.toLowerCase();
		return installedVersion
			? tl(
					"Nothing is published on the {name} channel yet. You will stay on {installedVersion} until a {buildName} build appears.",
					{ buildName, installedVersion, name }
				)
			: tl(
					"Nothing is published on the {name} channel yet. You will stay where you are until a {buildName} build appears.",
					{ buildName, name }
				);
	}

	const delta =
		installedVersion && comparePrecedence(targetVersion, installedVersion);
	const goesBackwards = isNativeNumber(delta) && delta < 0;

	return (
		<>
			{name} currently holds <strong>{targetVersion}</strong>
			{installedVersion ? <> — you have {installedVersion}</> : null}.{" "}
			{goesBackwards
				? "That is OLDER than what you are running: every prerelease ranks below its stable release, so this moves the app backwards. Switching back later installs whatever that channel holds then, not the build you have now."
				: "Later updates will follow this channel instead of the one you are on now."}
		</>
	);
}

export function ChannelPicker({
	channels,
	value,
	onChange,
}: {
	channels: CatalogChannel[];
	/** The selected train. `null` means stable. */
	value: string | null;
	onChange: (channel: string | null) => void;
}) {
	const tl = useLiteralMessages();
	const installable = channels.filter(
		(c) => c.installable !== false || c.channel === STABLE_CHANNEL
	);
	// One train is not a choice. Nothing renders rather than a dropdown whose only
	// option is the thing that would have happened anyway.
	if (installable.length < 2) {
		return null;
	}

	const selected = value ?? STABLE_CHANNEL;
	const selectedVersion = installable.find(
		(c) => c.channel === selected
	)?.version;

	return (
		<div className="flex items-center gap-2">
			<Select
				onValueChange={(next) =>
					onChange(next === STABLE_CHANNEL ? null : next)
				}
				value={selected}
			>
				<SelectTrigger className="h-8 w-[9.5rem]" size="sm">
					<SelectValue placeholder="Stable" />
				</SelectTrigger>
				<SelectContent>
					{installable.map((channel) => (
						<SelectItem key={channel.channel} value={channel.channel}>
							{channelLabel(channel.channel)}
							{channel.version ? (
								<span className="ml-2 font-mono text-muted-foreground text-xs">
									{channel.version}
								</span>
							) : null}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{selected === STABLE_CHANNEL ? null : (
				// Said plainly, because it is the one thing about prerelease trains
				// people get wrong: a build here is not "the newest version", it is the
				// newest version ON THIS TRAIN, and it may be older and less tested.
				<Badge variant="outline">
					{selectedVersion
						? tl("Pre-release · {version}", { version: selectedVersion })
						: "Pre-release"}
				</Badge>
			)}
		</div>
	);
}
