import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationRow, SubscriptionRow } from "./notification-rows";

const subscription = {
  id: "watch-internal",
  title: "Design review",
  uri: "example:resource-secret-id",
  source: "Design library",
  status: "Subscribed",
  remoteStatus: "Pending",
  tools: ["get-resource"],
  chat: "Review team",
  description: "Detailed description",
  updatedAt: 1710000000000,
  scheduledAt: "2027-01-05T11:00:00Z",
};
const notification = {
  id: 124,
  source: "Design library",
  receivedAt: 1710000000000,
  readAt: null,
  sessionId: "chat-internal",
  kind: "updated",
  status: "Completed",
  message: "Review is ready.",
  content:
    '{"name":"Cover review","id":"resource-internal","message":"Review is ready."}',
};

describe("collapsed notification center rows", () => {
  it("shows the subscription title, server, schedule and status and defers technical details and actions", () => {
    const html = renderToStaticMarkup(
      <SubscriptionRow item={subscription} onUnsubscribe={() => {}} />,
    );
    for (const visible of [
      "Design review",
      "Design library",
      "Pending",
      "Scheduled",
      'aria-expanded="false"',
    ])
      expect(html).toContain(visible);
    for (const deferred of [
      "watch-internal",
      "example:resource-secret-id",
      "Review team",
      "get-resource",
      "Detailed description",
      "Unsubscribe",
    ])
      expect(html).not.toContain(deferred);
  });
  it("shows a generic title for an unnamed resource and surfaces a failing subscription", () => {
    const html = renderToStaticMarkup(
      <SubscriptionRow
        item={{
          ...subscription,
          title: subscription.uri,
          status: "Failed",
          scheduledAt: null,
        }}
        onUnsubscribe={() => {}}
      />,
    );
    expect(html).toContain(">Resource<");
    expect(html).toContain("Subscription · Failed");
    expect(html).not.toContain(subscription.uri);
    expect(html).not.toContain("Scheduled");
  });
  it("uses returned titles and read state without mounting structured data in a collapsed notification", () => {
    const html = renderToStaticMarkup(
      <NotificationRow item={notification} writing={false} onRead={() => {}} />,
    );
    for (const visible of [
      "Cover review",
      "Design library",
      "Completed",
      "<time",
      'aria-label="Unread"',
      'aria-expanded="false"',
    ])
      expect(html).toContain(visible);
    for (const deferred of [
      "chat-internal",
      "resource-internal",
      "Notification ID",
      "<pre",
    ])
      expect(html).not.toContain(deferred);
  });
  it("handles text-only and protected events without inventing a resource title", () => {
    const row = { ...notification, readAt: 1710000000100, content: null };
    const render = (message: string | null) =>
      renderToStaticMarkup(
        <NotificationRow
          item={{ ...row, message }}
          writing={false}
          onRead={() => {}}
        />,
      );
    expect(render("Review is ready.")).toContain("Review is ready.");
    const restricted = render(null);
    expect(restricted).toContain("Resource updated");
    expect(restricted).not.toContain('aria-label="Unread"');
  });
});
