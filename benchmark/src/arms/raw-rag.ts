import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { lexicalSearch, type SearchDocument } from "@gb/retrieval";
import { strFromU8, unzipSync } from "fflate";
import iconv from "iconv-lite";
import * as XLSX from "xlsx";
import type { ChatCompletion } from "../../../services/mcp-server/src/llm-planner.js";
import type { ArmResponse } from "../types.js";
import { extractAttributions, extractSourceIds, SHARED_INSTRUCTION } from "./prompt.js";

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 1_200;
const MAX_CONTEXT_CHARS = 14_000;
const SUPPORTED_EXTENSIONS = new Set([".csv", ".json", ".xml", ".xlsx", ".hwpx"]);

interface RawMetadata extends Record<string, unknown> {
  path: string;
}

export interface RawCorpus {
  documents: SearchDocument<RawMetadata>[];
  files: SearchDocument<RawMetadata>[];
  loadedFiles: number;
  skippedFiles: number;
}

function decodeText(buffer: Buffer): string {
  const utf8 = buffer.toString("utf8");
  return utf8.includes("\uFFFD") ? iconv.decode(buffer, "cp949") : utf8;
}

function stripXml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function workbookText(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: "buffer", raw: true });
  return workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    return sheet ? `[sheet=${sheetName}]\n${XLSX.utils.sheet_to_csv(sheet)}` : "";
  }).join("\n");
}

function hwpxText(buffer: Buffer): string {
  const archive = unzipSync(buffer);
  return Object.entries(archive)
    .filter(([name]) => /^Contents\/section\d+\.xml$/i.test(name))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, bytes]) => stripXml(strFromU8(bytes)))
    .join("\n");
}

function chunks(path: string, text: string): SearchDocument<RawMetadata>[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const header = extname(path).toLowerCase() === ".csv" ? lines[0] ?? "" : "";
  const documents: SearchDocument<RawMetadata>[] = [];
  const files: SearchDocument<RawMetadata>[] = [];
  let current = "";
  for (const line of lines) {
    const next = current.length === 0 ? line : `${current}\n${line}`;
    if (next.length <= MAX_DOCUMENT_CHARS) {
      current = next;
      continue;
    }
    if (current) {
      documents.push({
        id: `${path}#${documents.length + 1}`,
        title: path,
        text: header && !current.startsWith(header) ? `${header}\n${current}` : current,
        metadata: { path }
      });
    }
    current = line;
  }
  if (current) {
    documents.push({
      id: `${path}#${documents.length + 1}`,
      title: path,
      text: header && !current.startsWith(header) ? `${header}\n${current}` : current,
      metadata: { path }
    });
  }
  return documents;
}

export async function loadRawCorpus(
  repositoryRoot: string,
  sourcePaths: string[]
): Promise<RawCorpus> {
  const rootPrefix = `${resolve(repositoryRoot)}${sep}`;
  const documents: SearchDocument<RawMetadata>[] = [];
  const files: SearchDocument<RawMetadata>[] = [];
  let loadedFiles = 0;
  let skippedFiles = 0;

  for (const sourcePath of [...new Set(sourcePaths)].sort()) {
    const absolute = resolve(repositoryRoot, sourcePath);
    const extension = extname(absolute).toLowerCase();
    if (!absolute.startsWith(rootPrefix) || !SUPPORTED_EXTENSIONS.has(extension)) {
      skippedFiles += 1;
      continue;
    }
    try {
      const fileStat = await stat(absolute);
      if (fileStat.size > MAX_SOURCE_BYTES) {
        skippedFiles += 1;
        continue;
      }
      const buffer = await readFile(absolute);
      const text =
        extension === ".xlsx"
          ? workbookText(buffer)
          : extension === ".hwpx"
            ? hwpxText(buffer)
            : extension === ".xml"
              ? stripXml(decodeText(buffer))
              : decodeText(buffer);
      documents.push(...chunks(sourcePath.normalize("NFC"), text));
      files.push({
        id: sourcePath,
        title: sourcePath,
        text: `${sourcePath}\n${text.slice(0, 8_000)}`,
        metadata: { path: sourcePath.normalize("NFC") }
      });
      loadedFiles += 1;
    } catch {
      skippedFiles += 1;
    }
  }
  return { documents, files, loadedFiles, skippedFiles };
}

export function retrieveRawContext(corpus: RawCorpus, question: string): string {
  // Selecting likely files before row/chunk retrieval is both the normal
  // two-stage RAG shape and essential for bounded memory on large raw corpora.
  const selectedPaths = new Set(
    lexicalSearch(question, corpus.files, { limit: 20 }).map(
      (match) => match.metadata.path
    )
  );
  if (selectedPaths.size === 0) return "(원본 파일에서 검색 결과 없음)";
  const matches = lexicalSearch(
    question,
    corpus.documents.filter((document) => selectedPaths.has(document.metadata.path)),
    { limit: 12 }
  );
  if (matches.length === 0) return "(원본 파일에서 검색 결과 없음)";
  let used = 0;
  const rendered: string[] = [];
  for (const match of matches) {
    const block = `[raw_file=${match.metadata.path}]\n${match.text}`;
    if (used + block.length > MAX_CONTEXT_CHARS) break;
    rendered.push(block);
    used += block.length;
  }
  return rendered.join("\n\n");
}

export async function runRawRagArm(
  corpus: RawCorpus,
  client: ChatCompletion,
  question: string
): Promise<ArmResponse> {
  const startedAt = Date.now();
  const context = retrieveRawContext(corpus, question);
  const prompt = [
    SHARED_INSTRUCTION,
    "",
    "아래 내용은 정규화, 지표 정의, coverage 판정 없이 원본 공공데이터 파일에서 단순 검색한 결과입니다.",
    "오직 검색 결과에 근거해 답하고, 근거가 없으면 확인할 수 없다고 답하십시오.",
    "",
    "[원본 검색 결과]",
    context,
    "",
    `질문: ${question}`,
    "",
    "답변:"
  ].join("\n");
  try {
    const text = await client.complete(prompt);
    return {
      arm: "raw_rag",
      text,
      transcript: `[검색 컨텍스트]\n${context}\n\n[최종 답변]\n${text}`,
      citedSourceIds: extractSourceIds(text),
      citedAttributions: extractAttributions(text),
      declined: null,
      latencyMs: Date.now() - startedAt,
      error: null
    };
  } catch (caught) {
    return {
      arm: "raw_rag",
      text: "",
      transcript: `[검색 컨텍스트]\n${context}`,
      citedSourceIds: [],
      citedAttributions: [],
      declined: null,
      latencyMs: Date.now() - startedAt,
      error: (caught as Error).message
    };
  }
}
