import { describe, expect, it } from "vitest";
import { classifyDatabaseError } from "./db.js";

describe("database error reporting", () => {
  it("classifies PostgreSQL errors without exposing URL credentials", () => {
    const issue = classifyDatabaseError(
      Object.assign(
        new Error(
          "connect failed for postgresql://private-user:private-password@localhost:5432/mcp"
        ),
        { code: "ECONNREFUSED" }
      )
    );
    expect(issue.kind).toBe("connection_refused");
    expect(issue.message).not.toContain("private-user");
    expect(issue.message).not.toContain("private-password");
  });
});
