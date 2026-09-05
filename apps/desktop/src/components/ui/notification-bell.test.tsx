import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationBell } from "@/components/ui/notification-bell.tsx";

describe("NotificationBell", () => {
	test("renders the unread count and live accessible status", () => {
		const html = renderToStaticMarkup(
			<NotificationBell count={12} max={99} size={40} />
		);

		expect(html).toContain('data-slot="notification-bell"');
		expect(html).toContain('role="status"');
		expect(html).toContain("Notifications, 12 unread");
		expect(html).toContain("#FF3B30");
	});

	test("does not render a count badge when the inbox is empty", () => {
		const html = renderToStaticMarkup(<NotificationBell count={0} />);

		expect(html).toContain("Notifications");
		expect(html).not.toContain("Notifications, 0 unread");
		expect(html).not.toContain("#FF3B30");
	});
});
