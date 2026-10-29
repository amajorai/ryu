import type { useSession } from "@/lib/auth-client.ts";

/** The Better Auth session as `useSession()` reports it (null when signed out). */
export type SessionData = ReturnType<typeof useSession>["data"];
