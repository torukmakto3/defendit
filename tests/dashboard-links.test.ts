import { describe, expect, it } from "vitest";
import { dashboardWorkspaceHref } from "../src/lib/dashboard-links";

describe("dashboard workspace links", () => {
  const token = "tok_abc";

  it("opens Learn on flashcards for a creator who has a file", () => {
    expect(dashboardWorkspaceHref({ token, role: "creator", status: "uploaded" })).toBe(`/d/${token}/learn`);
    expect(dashboardWorkspaceHref({ token, role: "creator", status: "defended" })).toBe(`/d/${token}/learn`);
  });

  it("keeps a creator with no file on the request page", () => {
    expect(dashboardWorkspaceHref({ token, role: "creator", status: "pending" })).toBe(`/d/${token}`);
  });

  it("keeps every receiver row on the request page", () => {
    for (const status of ["pending", "uploaded", "defended"]) {
      expect(dashboardWorkspaceHref({ token, role: "receiver", status })).toBe(`/d/${token}`);
    }
  });
});
