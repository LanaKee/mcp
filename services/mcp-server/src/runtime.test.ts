import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataRepository } from "./runtime.js";

describe("repository runtime selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the in-memory repository when explicitly disabled", async () => {
    vi.stubEnv("DATA_REPOSITORY", "disabled");
    const repository = await createDataRepository();
    expect(repository.mode).toBe("memory");
    await repository.close();
  });

  it("does not silently fall back when PostgreSQL is explicitly requested", async () => {
    vi.stubEnv("DATA_REPOSITORY", "postgres");
    vi.stubEnv("DATABASE_URL", "");
    await expect(createDataRepository()).rejects.toThrow(
      "requires DATABASE_URL; demo fallback was removed"
    );
  });

  it("does not silently load demo data when auto mode has no database", async () => {
    vi.stubEnv("DATA_REPOSITORY", "auto");
    vi.stubEnv("DATABASE_URL", "");
    await expect(createDataRepository()).rejects.toThrow("demo fallback was removed");
  });
});
