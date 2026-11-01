import { configureSettingsApi } from "@ryu/settings";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

export const TOKEN_KEY = "ryu_session_token";
export const BACKEND_URL = "http://localhost:3000";
export const FRONTEND_URL = "http://localhost:3000";

interface ProfileSession {
	user: {
		email: string;
		id: string;
		image: string | null;
		name: string | null;
	};
}

const INITIAL_SESSION: ProfileSession = {
	user: {
		email: "morgan@example.test",
		id: "profile-proof-user",
		image: null,
		name: "Morgan Example",
	},
};

const PROOF_TOKEN = "profile-tab-proof-token";

configureSettingsApi({ getToken: () => PROOF_TOKEN });

/** The profile banner captures the active token to drop stale-account writes. */
export function getActiveToken(): string {
	return PROOF_TOKEN;
}

export function useSession() {
	const [data, setData] = useState<ProfileSession | null>(null);
	const refetch = useCallback(async () => {
		const response = await fetch("/api/auth/get-session");
		if (!response.ok) {
			throw new Error(`Session read failed: ${response.status}`);
		}
		const session = z
			.object({
				user: z.object({
					email: z.string(),
					id: z.string(),
					image: z.string().nullable(),
					name: z.string().nullable(),
				}),
			})
			.parse(await response.json());
		setData(session);
		return { data: session };
	}, []);

	useEffect(() => {
		void refetch().catch(() => setData(INITIAL_SESSION));
	}, [refetch]);

	return { data, refetch };
}
