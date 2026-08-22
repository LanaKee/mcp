import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRawCorpus, retrieveRawContext } from "./raw-rag.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("raw RAG corpus", () => {
  it("retrieves unnormalized CSV rows with their source path", async () => {
    const root = resolve(tmpdir(), `raw-rag-${Date.now()}-${Math.random()}`);
    roots.push(root);
    await mkdir(resolve(root, "datasets"), { recursive: true });
    await writeFile(
      resolve(root, "datasets/population.csv"),
      "연도,지역,인구\n2026,김천시,132550\n2026,구미시,402691\n"
    );

    const corpus = await loadRawCorpus(root, ["datasets/population.csv"]);
    const context = retrieveRawContext(corpus, "2026년 김천시 인구는?");

    expect(corpus.loadedFiles).toBe(1);
    expect(context).toContain("raw_file=datasets/population.csv");
    expect(context).toContain("김천시,132550");
  });

  it("does not read a source outside the corpus root", async () => {
    const root = resolve(tmpdir(), `raw-rag-${Date.now()}-${Math.random()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });

    const corpus = await loadRawCorpus(root, ["../outside.csv"]);

    expect(corpus.loadedFiles).toBe(0);
    expect(corpus.skippedFiles).toBe(1);
  });
});
