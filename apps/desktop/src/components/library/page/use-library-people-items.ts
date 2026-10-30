import {
	AudioWave01Icon,
	UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useMemo } from "react";
import { SECTION_ICONS } from "@/src/components/layout/sidebar-sections.ts";
import { useChannelStatus } from "@/src/hooks/useChannelStatus.ts";
import { useChannels } from "@/src/hooks/useChannels.ts";
import { useIdentities } from "@/src/hooks/useIdentities.ts";
import { useMeetings } from "@/src/hooks/useMeetings.ts";
import { useTeams } from "@/src/hooks/useTeams.ts";
import { CHANNEL_LABELS } from "@/src/lib/api/channels.ts";
import { normalizeTimestamp, stampRecent } from "@/src/lib/library.ts";
import {
	channelStatusKind,
	type LibraryItem,
	mutationResult,
} from "./library-sections.ts";
import type { LibraryTabsValue } from "./library-tabs.ts";

/** Groups, meetings, channels and identities, normalised into `LibraryItem`s. */
export function useLibraryPeopleItems({
	openTab,
	openTeam,
}: {
	openTab: LibraryTabsValue["openTab"];
	openTeam: (id: string | null) => void;
}) {
	const {
		teams,
		create: createTeam,
		remove: removeTeam,
		update: updateTeam,
	} = useTeams();
	const {
		meetings,
		loading: meetingsLoading,
		remove: removeMeeting,
		rename: renameMeeting,
	} = useMeetings();
	const {
		channels,
		loading: channelsLoading,
		remove: removeChannel,
		update: updateChannel,
	} = useChannels();
	// Live bot liveness from the control plane's status stream; the socket only
	// opens once there is a channel to paint.
	const channelLiveStates = useChannelStatus(channels.length > 0);
	const {
		profiles,
		loading: identitiesLoading,
		remove: removeIdentity,
	} = useIdentities();

	const teamItems = useMemo<LibraryItem[]>(
		() =>
			teams.map((t) => ({
				type: "team",
				id: t.id,
				name: t.name,
				subtitle:
					t.description ??
					`${formatCount(t.members.length) ?? "—"} ${t.members.length === 1 ? "member" : "members"}`,
				badge: null,
				icon: UserMultiple02Icon,
				updatedAt: normalizeTimestamp(t.updatedAt ?? t.createdAt),
				open: () => {
					stampRecent("team", t.id);
					openTeam(t.id);
				},
				// A team opens a DIALOG, not a route — "open in new tab" has nothing to
				// point at, and its name is edited in that same dialog.
				remove: () => {
					return Promise.resolve(removeTeam(t.id)).then(mutationResult);
				},
			})),
		[teams, openTeam, removeTeam]
	);

	const meetingItems = useMemo<LibraryItem[]>(
		() =>
			meetings.map((m) => ({
				type: "meeting",
				id: m.id,
				name: m.title,
				subtitle: m.status === "recording" ? "Recording…" : null,
				badge: m.status === "recording" ? "Live" : null,
				icon: AudioWave01Icon,
				updatedAt: normalizeTimestamp(m.updated_at ?? m.created_at),
				open: () => openTab(`/meetings/${m.id}`, { title: m.title }),
				openInNewTab: () =>
					openTab(`/meetings/${m.id}`, { title: m.title, forceNew: true }),
				rename: (title: string) => {
					return Promise.resolve(renameMeeting(m.id, title)).then(
						mutationResult
					);
				},
				remove: () => {
					return Promise.resolve(removeMeeting(m.id)).then(mutationResult);
				},
			})),
		[meetings, openTab, renameMeeting, removeMeeting]
	);

	const channelItems = useMemo<LibraryItem[]>(
		() =>
			channels.map((c) => ({
				type: "channel",
				id: c.id,
				name: c.name,
				subtitle: CHANNEL_LABELS[c.channelType],
				badge: c.enabled ? null : "Disabled",
				status: c.enabled
					? channelStatusKind(channelLiveStates.get(c.id))
					: null,
				icon: SECTION_ICONS.channels,
				updatedAt: normalizeTimestamp(c.updatedAt ?? c.createdAt),
				open: () => openTab(`/channels/${c.id}`, { title: c.name }),
				openInNewTab: () =>
					openTab(`/channels/${c.id}`, { title: c.name, forceNew: true }),
				rename: (name: string) => {
					return Promise.resolve(updateChannel(c.id, { name })).then(
						mutationResult
					);
				},
				remove: () => {
					return Promise.resolve(removeChannel(c.id)).then(mutationResult);
				},
			})),
		[channelLiveStates, channels, openTab, updateChannel, removeChannel]
	);

	const identityItems = useMemo<LibraryItem[]>(
		() =>
			profiles.map((p) => {
				const count = p.connections.length;
				const authenticated = p.connections.filter(
					(c) => c.status === "AUTHENTICATED"
				).length;
				const latest = p.connections.reduce(
					(max, c) => Math.max(max, c.updated_at ?? c.created_at ?? 0),
					0
				);
				return {
					type: "identity" as const,
					id: p.profile_id,
					name: p.profile_id,
					subtitle: `${formatCount(count) ?? "—"} ${count === 1 ? "connection" : "connections"}`,
					badge:
						count > 0
							? `${formatCount(authenticated) ?? "—"}/${formatCount(count) ?? "—"} signed in`
							: null,
					icon: SECTION_ICONS.identities,
					updatedAt: normalizeTimestamp(latest),
					open: () => {
						stampRecent("identity", p.profile_id);
						openTab(`/identities/profile/${encodeURIComponent(p.profile_id)}`, {
							title: p.profile_id,
						});
					},
					openInNewTab: () => {
						stampRecent("identity", p.profile_id);
						openTab(`/identities/profile/${encodeURIComponent(p.profile_id)}`, {
							title: p.profile_id,
							forceNew: true,
						});
					},
					// A profile IS its id — there is nothing to rename it to.
					remove: () => {
						return Promise.resolve(removeIdentity(p.profile_id)).then(
							mutationResult
						);
					},
				};
			}),
		[profiles, openTab, removeIdentity]
	);

	return {
		channelItems,
		channelsLoading,
		createTeam,
		identitiesLoading,
		identityItems,
		meetingItems,
		meetingsLoading,
		teamItems,
		teams,
		updateTeam,
	};
}
