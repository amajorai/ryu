// Type-level assertions for the result-mode projections. `expectTypeOf` is
// checked by `tsc --noEmit` (check-types); at runtime it is a no-op.

import { describe, expect, expectTypeOf, test } from "bun:test";
import type {
	Box,
	BoxStreamEvent,
	MailInbox,
	ManagedAgentEvent,
	ManagedAgentSession,
	ManagedAgentsList,
	NotificationEvent,
	NotifyStreamItem,
} from "@ryuhq/client";
import type {
	ConnectUsageLine,
	ConnectUsageReport,
} from "./connect/namespace.ts";
import type {
	GatewayChatCompletion,
	GatewayChatCompletionChunk,
	GatewayModelList,
} from "./gateway/namespace.ts";
import type * as Services from "./index.ts";
import type { Paginated } from "./pagination.ts";
import type {
	PassportConnectionList,
	PassportProfileList,
} from "./passport/namespace.ts";
import type { RyuResult, Safe } from "./result.ts";
import { Ryu } from "./ryu.ts";
import type { SitesDeployResult, SitesProject } from "./sites/namespace.ts";
import type { CallOptions } from "./transport/fetch-shim.ts";

describe("Safe<T>", () => {
	test("promise methods become RyuResult, iterables and sync values are untouched", () => {
		interface Sample {
			count: number;
			get(id: string): Promise<{ id: string }>;
			nested: { list(limit?: number): Promise<string[]> };
			stream(): AsyncGenerator<number>;
			url(): string;
		}
		expectTypeOf<Safe<Sample>["get"]>().toEqualTypeOf<
			(id: string) => Promise<RyuResult<{ id: string }>>
		>();
		expectTypeOf<Safe<Sample>["nested"]["list"]>().toEqualTypeOf<
			(limit?: number) => Promise<RyuResult<string[]>>
		>();
		expectTypeOf<Safe<Sample>["stream"]>().toEqualTypeOf<
			() => AsyncGenerator<number>
		>();
		expectTypeOf<Safe<Sample>["url"]>().toEqualTypeOf<() => string>();
		expectTypeOf<Safe<Sample>["count"]>().toEqualTypeOf<number>();
		expect(true).toBe(true);
	});

	test("RyuResult narrows on error", () => {
		const narrow = (result: RyuResult<{ id: string }>) => {
			if (result.error) {
				expectTypeOf(result.data).toEqualTypeOf<null>();
				return null;
			}
			expectTypeOf(result.data).toEqualTypeOf<{ id: string }>();
			expectTypeOf(result.meta.status).toEqualTypeOf<number>();
			return result.data.id;
		};
		expect(
			narrow({
				data: { id: "x" },
				error: null,
				meta: {
					attempts: 1,
					deprecation: null,
					idempotencyKey: null,
					rateLimit: null,
					replayed: false,
					requestId: null,
					status: 200,
				},
			})
		).toBe("x");
	});
});

describe("namespace projections", () => {
	const throwing = new Ryu({ env: {} });
	const objects = new Ryu({ env: {}, result: "object" });

	test("throw mode keeps the client signatures", () => {
		expectTypeOf(throwing.notify.publish).returns.toEqualTypeOf<
			Promise<NotificationEvent>
		>();
		expectTypeOf(throwing.box.get).returns.toEqualTypeOf<Promise<Box>>();
		expectTypeOf(throwing.mail.inboxes.list).returns.toEqualTypeOf<
			Promise<MailInbox[]>
		>();
		expectTypeOf(throwing.managedAgents.sessions.get).returns.toEqualTypeOf<
			Promise<ManagedAgentSession>
		>();
		expectTypeOf(throwing.managedAgents.sessions.stream).returns.toEqualTypeOf<
			AsyncGenerator<ManagedAgentEvent>
		>();
		expect(throwing.resultMode).toBe("throw");
	});

	test("object mode resolves to RyuResult and leaves streams alone", () => {
		expectTypeOf(objects.notify.publish).returns.toEqualTypeOf<
			Promise<RyuResult<NotificationEvent>>
		>();
		expectTypeOf(objects.notify.events.stream).returns.toEqualTypeOf<
			AsyncGenerator<NotifyStreamItem>
		>();
		expectTypeOf(objects.box.execStream).returns.toEqualTypeOf<
			AsyncGenerator<BoxStreamEvent>
		>();
		expectTypeOf(objects.managedAgents.sessions.list).returns.toEqualTypeOf<
			Promise<RyuResult<ManagedAgentsList<ManagedAgentSession>>>
		>();
		expectTypeOf(objects.mail.inboxes.list).returns.toEqualTypeOf<
			Promise<RyuResult<MailInbox[]>>
		>();
		expect(objects.resultMode).toBe("object");
	});

	test("object mode keeps connect.usage.iterate beside the callable usage", () => {
		expectTypeOf(objects.connect.usage).parameters.toEqualTypeOf<
			Parameters<typeof throwing.connect.usage>
		>();
		expectTypeOf(objects.connect.usage).returns.toEqualTypeOf<
			Promise<RyuResult<ConnectUsageReport>>
		>();
		expectTypeOf(objects.connect.usage.iterate).returns.toEqualTypeOf<
			Paginated<ConnectUsageLine, ConnectUsageReport>
		>();
		expectTypeOf(throwing.safe.connect.usage.iterate).returns.toEqualTypeOf<
			Paginated<ConnectUsageLine, ConnectUsageReport>
		>();
		expectTypeOf(objects.connect.tools.search).returns.toEqualTypeOf<
			Promise<RyuResult<Services.ConnectToolSearchResult>>
		>();
	});

	test("ryu.safe is object mode whatever the client mode", () => {
		expectTypeOf(throwing.safe.notify.events.get).returns.toEqualTypeOf<
			Promise<RyuResult<NotificationEvent>>
		>();
		expectTypeOf(
			throwing.safe.managedAgents.agents.get
		).parameters.toEqualTypeOf<
			Parameters<typeof throwing.managedAgents.agents.get>
		>();
	});

	test("Passport and Sites project the same way", () => {
		expectTypeOf(throwing.sites.deploy).returns.toEqualTypeOf<
			Promise<SitesDeployResult>
		>();
		expectTypeOf(throwing.safe.sites.deploy).returns.toEqualTypeOf<
			Promise<RyuResult<SitesDeployResult>>
		>();
		expectTypeOf(objects.sites.projects.list).returns.toEqualTypeOf<
			Promise<RyuResult<SitesProject[]>>
		>();
		expectTypeOf(objects.passport.profiles.list).returns.toEqualTypeOf<
			Promise<RyuResult<PassportProfileList>>
		>();
		expectTypeOf(
			throwing.safe.passport.runtime.connections.list
		).returns.toEqualTypeOf<Promise<RyuResult<PassportConnectionList>>>();
		expectTypeOf(objects.passport.connections.list).parameters.toEqualTypeOf<
			Parameters<typeof throwing.passport.connections.list>
		>();
		expect(objects.resultMode).toBe("object");
	});

	test("Gateway create({ stream: true }) stays an async iterable in object mode", () => {
		const params = { messages: [], model: "m" };
		const streamed = () =>
			objects.gateway.chat.completions.create({ ...params, stream: true });
		expectTypeOf(streamed).returns.toEqualTypeOf<
			AsyncGenerator<GatewayChatCompletionChunk>
		>();
		const plain = () => objects.gateway.chat.completions.create(params);
		expectTypeOf(plain).returns.toEqualTypeOf<
			Promise<RyuResult<GatewayChatCompletion>>
		>();
		expectTypeOf(objects.gateway.models.list).returns.toEqualTypeOf<
			Promise<RyuResult<GatewayModelList>>
		>();
		expect(objects.resultMode).toBe("object");
	});

	test(".with() keeps the mode and the parameters", () => {
		expectTypeOf(throwing.notify.with).parameters.toEqualTypeOf<
			[CallOptions]
		>();
		expectTypeOf(throwing.notify.with({}).publish).returns.toEqualTypeOf<
			Promise<NotificationEvent>
		>();
		expectTypeOf(objects.notify.with({}).publish).returns.toEqualTypeOf<
			Promise<RyuResult<NotificationEvent>>
		>();
		expectTypeOf(objects.notify.publish).parameters.toEqualTypeOf<
			Parameters<typeof throwing.notify.publish>
		>();
	});
});

describe("wrapped client types are nameable from @ryuhq/services", () => {
	const ryu = new Ryu({ env: {} });

	test("namespace parameters and results use the re-exported types", () => {
		expectTypeOf(ryu.mail.messages.get).returns.toEqualTypeOf<
			Promise<Services.MailMessage>
		>();
		expectTypeOf<
			Parameters<typeof ryu.notify.publish>[0]
		>().toEqualTypeOf<Services.NotifyEventInput>();
		expectTypeOf(ryu.notify.events.list).returns.toEqualTypeOf<
			Promise<Services.NotifyEventList>
		>();
		expectTypeOf<
			Parameters<typeof ryu.box.create>[0]
		>().toEqualTypeOf<Services.CreateBoxInput>();
		expectTypeOf(ryu.box.get).returns.toEqualTypeOf<Promise<Services.Box>>();
		expectTypeOf(ryu.managedAgents.sessions.get).returns.toEqualTypeOf<
			Promise<Services.ManagedAgentSession>
		>();
		expectTypeOf<Services.ManagedAgent>().toEqualTypeOf<
			import("@ryuhq/client").ManagedAgent
		>();
		expect(ryu.resultMode).toBe("throw");
	});
});
