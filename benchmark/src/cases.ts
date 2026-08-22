/**
 * Loads and validates the case suite.
 *
 * Validation is strict because a malformed case degrades quietly: a missing
 * tolerance would default to zero and mark every answer wrong, which reads as a
 * dramatic result rather than the bug it is.
 */

import { readFileSync } from "node:fs";
import type { BenchmarkCase, CaseCategory, Expectation, GroundTruthSpec } from "./types.js";

const CATEGORIES: readonly CaseCategory[] = [
  "common_knowledge",
  "recency",
  "hyperlocal",
  "precision",
  "abstention",
  "provenance"
];

function fail(line: number, message: string): never {
  throw new Error(`benchmark case (line ${line}): ${message}`);
}

function asRecord(value: unknown, line: number, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(line, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseGroundTruth(raw: unknown, line: number): GroundTruthSpec {
  const spec = asRecord(raw, line, "groundTruth");
  const kind = spec.kind;
  switch (kind) {
    case "population_year":
      if (typeof spec.region !== "string" || typeof spec.year !== "number") {
        fail(line, "population_year needs region and year");
      }
      return { kind, region: spec.region, year: spec.year };
    case "local_tax_total":
      if (
        typeof spec.region !== "string" ||
        typeof spec.fiscalYear !== "number" ||
        typeof spec.amountSemantics !== "string"
      ) {
        fail(line, "local_tax_total needs region, fiscalYear and amountSemantics");
      }
      return {
        kind,
        region: spec.region,
        fiscalYear: spec.fiscalYear,
        amountSemantics: spec.amountSemantics
      };
    case "council_party_seats":
      if (typeof spec.party !== "string") fail(line, "council_party_seats needs party");
      return { kind, party: spec.party };
    case "council_bill_count_year":
    case "press_release_count_year":
      if (typeof spec.year !== "number") fail(line, `${kind} needs year`);
      return { kind, year: spec.year };
    case "policy_program_any":
      return { kind };
    default:
      fail(line, `unknown groundTruth.kind: ${String(kind)}`);
  }
}

function parseExpectation(raw: unknown, line: number): Expectation {
  const expect = asRecord(raw, line, "expect");
  if (expect.type === "absent") return { type: "absent" };
  if (expect.type !== "numeric") fail(line, `unknown expect.type: ${String(expect.type)}`);
  if (typeof expect.tolerancePercent !== "number" || expect.tolerancePercent < 0) {
    fail(line, "numeric expectation needs a non-negative tolerancePercent");
  }
  if (typeof expect.unit !== "string") fail(line, "numeric expectation needs a unit");
  return {
    type: "numeric",
    tolerancePercent: expect.tolerancePercent,
    unit: expect.unit
  };
}

export function parseBenchmarkCases(contents: string): BenchmarkCase[] {
  const cases: BenchmarkCase[] = [];
  const seen = new Set<string>();
  const lines = contents.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]?.trim();
    if (text === undefined || text.length === 0) continue;
    const lineNumber = index + 1;

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (caught) {
      fail(lineNumber, `invalid JSON: ${(caught as Error).message}`);
    }
    const record = asRecord(raw, lineNumber, "case");

    const { id, question, rationale, category, requireCitation, manualBaselineMinutes } = record;
    if (typeof id !== "string" || id.length === 0) fail(lineNumber, "id is required");
    if (seen.has(id)) fail(lineNumber, `duplicate id: ${id}`);
    seen.add(id);
    if (typeof question !== "string" || question.length === 0) {
      fail(lineNumber, "question is required");
    }
    if (typeof rationale !== "string" || rationale.length === 0) {
      fail(lineNumber, "rationale is required so the suite can be reviewed");
    }
    if (typeof category !== "string" || !CATEGORIES.includes(category as CaseCategory)) {
      fail(lineNumber, `unknown category: ${String(category)}`);
    }
    if (typeof requireCitation !== "boolean") fail(lineNumber, "requireCitation is required");
    if (typeof manualBaselineMinutes !== "number" || manualBaselineMinutes <= 0) {
      fail(lineNumber, "manualBaselineMinutes must be positive");
    }

    cases.push({
      id,
      category: category as CaseCategory,
      question,
      rationale,
      groundTruth: parseGroundTruth(record.groundTruth, lineNumber),
      expect: parseExpectation(record.expect, lineNumber),
      requireCitation,
      manualBaselineMinutes
    });
  }

  if (cases.length === 0) throw new Error("benchmark case file is empty");
  return cases;
}

export function loadBenchmarkCases(path: string): BenchmarkCase[] {
  return parseBenchmarkCases(readFileSync(path, "utf8"));
}
