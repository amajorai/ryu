import { useCallback, useEffect, useId, useMemo, useRef } from "react";

type TranscriptTarget = {
	url: string;
	token?: string | null;
	userJwt?: string | null;
};

/** Isolate SDK state without remounting the composer or exposing credentials in ids. */
export function useChatTranscriptOwner(
	target: TranscriptTarget,
	conversationId: string
) {
	const instanceId = useId();
	const generation = useRef(0);
	const authority = useMemo(
		() => ({
			id: `${instanceId}:${++generation.current}`,
			target: {
				url: target.url,
				token: target.token ?? null,
				userJwt: target.userJwt ?? null,
			},
		}),
		[instanceId, target.url, target.token ?? null, target.userJwt ?? null]
	);
	const owner = useMemo(
		() => ({ authority, conversationId }),
		[authority, conversationId]
	);
	const currentOwner = useRef(owner);
	currentOwner.current = owner;
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const isCurrent = useCallback(
		() => mounted.current && currentOwner.current === owner,
		[owner]
	);
	return { sdkId: `${authority.id}:${conversationId}`, isCurrent };
}

/** The installed SDK setter dereferences a mutable current-Chat ref. */
export function useOwnedChatMessages<T>(
	isCurrent: () => boolean,
	setter: (next: T) => void
) {
	return useCallback(
		(next: T) => {
			if (isCurrent()) setter(next);
		},
		[isCurrent, setter]
	);
}

/** Capture the old instance-bound SDK stop; never stop its replacement. */
export function useStopReplacedChat(stop: () => Promise<void>) {
	useEffect(
		() => () => {
			void stop();
		},
		[stop]
	);
}
