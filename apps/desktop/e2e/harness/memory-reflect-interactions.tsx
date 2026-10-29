import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { MemoryReflectPage } from "../../src/components/memory/MemoryLibrary.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const CORE_URL = "http://127.0.0.1:5201";
const SETTINGS_KEY = "ryu:e2e:memory-reflect-settings";

const ReflectSettingsSchema = z.object({
	break_nudges: z.boolean(),
	quiet_hours_enabled: z.boolean(),
	quiet_hours_end: z.number(),
	quiet_hours_start: z.number(),
});
type ReflectSettings = z.infer<typeof ReflectSettingsSchema>;

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	query: Record<string, string>;
	status: number;
}

interface ReflectFixture {
	breakNudgesWriteFailuresRemaining: number;
	failNextDashboard: number;
	failNextUsageReview: number;
	forceUnsupportedReflect: boolean;
	readonly requests: CapturedRequest[];
	settings: ReflectSettings;
}

declare global {
	interface Window {
		__memoryReflectFixture?: ReflectFixture;
	}
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

function readSettings(): ReflectSettings {
	const stored = localStorage.getItem(SETTINGS_KEY);
	if (stored) {
		try {
			return ReflectSettingsSchema.parse(JSON.parse(stored));
		} catch {
			localStorage.removeItem(SETTINGS_KEY);
		}
	}
	const initial = {
		break_nudges: true,
		quiet_hours_enabled: true,
		quiet_hours_end: 8,
		quiet_hours_start: 22,
	};
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(initial));
	return initial;
}

function dashboard(period: string) {
	const periodTitle =
		period === "30d"
			? "Core migration planning"
			: period === "90d"
				? "Long-range agent routines"
				: "Focused regression coverage";
	return {
		activity: [
			{ count: period === "30d" ? 12 : 4, label: "Conversations", trend: 0 },
			{ count: 18, label: "Messages", trend: null },
			{ count: 3, label: "Active days", trend: null },
		],
		generated_at: Date.now(),
		insights: [
			{
				body: "A fixture-backed observation with a stable readback.",
				id: `insight-${period}`,
				title: periodTitle,
				tone: "positive",
			},
		],
		period,
		topics: [
			{
				count: period === "30d" ? 5 : 2,
				name: periodTitle,
				summary: `${period} topic summary`,
			},
		],
	};
}

function installFixture(): ReflectFixture {
	const params = new URLSearchParams(window.location.search);
	const fixture: ReflectFixture = {
		breakNudgesWriteFailuresRemaining: 0,
		failNextDashboard: 0,
		failNextUsageReview: params.has("unsupported") ? 1 : 0,
		forceUnsupportedReflect: params.has("unsupported"),
		requests: [],
		settings: readSettings(),
	};
	window.__memoryReflectFixture = fixture;

	window.fetch = async (input, init) => {
		const requestUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(requestUrl, window.location.href);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		let body: ProofJsonValue = null;
		if (isNativeText(init?.body)) {
			body = parseProofJson(init.body);
		}
		const captured: CapturedRequest = {
			body,
			method,
			path: url.pathname,
			query: Object.fromEntries(url.searchParams),
			status: 0,
		};
		fixture.requests.push(captured);
		const finish = <Payload,>(responseBody: Payload, status = 200) => {
			captured.status = status;
			return json(responseBody, status);
		};

		if (url.pathname === "/api/memory/reflect" && method === "GET") {
			if (fixture.forceUnsupportedReflect) {
				fixture.forceUnsupportedReflect = false;
				return finish({ error: "Reflect projection unavailable." }, 404);
			}
			if (fixture.failNextDashboard > 0) {
				fixture.failNextDashboard -= 1;
				return finish(
					{ error: "Reflect service temporarily unavailable." },
					503
				);
			}
			return finish(dashboard(url.searchParams.get("period") ?? "7d"));
		}
		if (url.pathname === "/api/usage-review" && method === "GET") {
			if (fixture.failNextUsageReview > 0) {
				fixture.failNextUsageReview -= 1;
				return finish({ error: "Usage review is unavailable." }, 404);
			}
			return finish({ metrics: {}, period: {}, topics: [] });
		}
		if (url.pathname === "/api/memory/reflect/settings" && method === "GET") {
			return finish({ settings: fixture.settings });
		}
		if (url.pathname === "/api/memory/reflect/settings" && method === "PATCH") {
			const patch = ReflectSettingsSchema.partial().parse(body ?? {});
			if (
				"break_nudges" in patch &&
				fixture.breakNudgesWriteFailuresRemaining > 0
			) {
				fixture.breakNudgesWriteFailuresRemaining -= 1;
				return finish({ error: "Settings write rejected." }, 503);
			}
			fixture.settings = { ...fixture.settings, ...patch };
			localStorage.setItem(SETTINGS_KEY, JSON.stringify(fixture.settings));
			return finish({ settings: fixture.settings });
		}
		if (url.pathname === "/api/memory" && method === "GET") {
			return finish({ memories: [] });
		}
		if (url.pathname.startsWith("/api/preferences/") && method === "GET") {
			return finish({ error: "preference_not_found" }, 404);
		}
		return finish({});
	};
	return fixture;
}

const node = {
	name: "Memory Reflect fixture node",
	token: "memory-reflect-fixture-token",
	url: CORE_URL,
	userJwt: null,
};
useNodeStore.setState({
	autoSelect: false,
	defaultNode: node.name,
	nodes: [node],
});
installFixture();

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Memory Reflect harness root is missing.");
}
createRoot(rootElement).render(
	<I18nProvider>
		<main className="min-h-screen bg-background p-6 text-foreground">
			<p className="mb-4 text-muted-foreground text-xs uppercase tracking-section">
				Production route: /library/memory/reflect
			</p>
			<MemoryReflectPage />
		</main>
		<Toaster position="bottom-right" theme="dark" />
	</I18nProvider>
);
