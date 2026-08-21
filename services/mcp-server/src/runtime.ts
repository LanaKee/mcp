import { loadEnvFile } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDemoData } from "./data-store.js";
import { PostgresDataRepository } from "./postgres-repository.js";
import {
  InMemoryDataRepository,
  type DataRepository
} from "./repository.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

export function loadRepositoryEnvironment(): void {
  try {
    loadEnvFile(resolve(repositoryRoot, ".env"));
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "ENOENT") throw error;
  }
}

export async function createDataRepository(): Promise<DataRepository> {
  loadRepositoryEnvironment();
  const configured = (process.env.DATA_REPOSITORY ?? "auto").toLowerCase();
  if (["memory", "in-memory", "disabled", "off"].includes(configured)) {
    return new InMemoryDataRepository(await loadDemoData());
  }
  if (!["auto", "postgres"].includes(configured)) {
    throw new Error(
      "DATA_REPOSITORY must be auto, postgres, memory, or disabled"
    );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    if (configured === "postgres") {
      throw new Error(
        "DATA_REPOSITORY=postgres requires DATABASE_URL; no in-memory fallback was used"
      );
    }
    return new InMemoryDataRepository(await loadDemoData());
  }
  const repository = PostgresDataRepository.fromConnectionString(databaseUrl);
  const readiness = await repository.readiness();
  if (!readiness.ready) {
    await repository.close();
    throw new Error(
      `PostgreSQL repository is not ready: ${readiness.detail ?? "unknown"}`
    );
  }
  return repository;
}
