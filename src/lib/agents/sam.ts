import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { normalizeSam, samResponse } from "../domain";
import { boundedText } from "../http";

type RecordInput = ReturnType<typeof normalizeSam>[number];
export interface SamAgentDependencies {
  apiKey: string;
  persist: (record: RecordInput, signal: AbortSignal) => Promise<void>;
  fetch?: typeof fetch;
  now?: Date;
  maxPages?: number;
}

// No model interprets source text or selects credentials, URLs, organizations or RPCs.
// LangChain tools are capabilities held in closures, never in graph state/results.
export async function runSamAgent(deps: SamAgentDependencies) {
  if (!deps.apiKey) throw new Error("SAM configuration required");
  if (
    [process.env.LANGCHAIN_TRACING_V2, process.env.LANGSMITH_TRACING].some(
      (value) => value?.toLowerCase() === "true",
    )
  )
    throw new Error("External agent tracing must be disabled");
  const maxPages = z
    .number()
    .int()
    .min(1)
    .max(5)
    .parse(deps.maxPages ?? 5);
  const signal = AbortSignal.timeout(55000);
  const now = deps.now ?? new Date();
  const date = (d: Date) =>
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
  const State = Annotation.Root({
    offset: Annotation<number>(),
    pages: Annotation<number>(),
    ingested: Annotation<number>(),
    skipped: Annotation<number>(),
    total: Annotation<number>(),
    records: Annotation<RecordInput[]>(),
    more: Annotation<boolean>(),
  });
  const search = tool(
    async ({ offset }) => {
      const url = new URL("https://api.sam.gov/opportunities/v2/search");
      url.search = new URLSearchParams({
        api_key: deps.apiKey,
        postedFrom: date(new Date(now.getTime() - 7 * 86400000)),
        postedTo: date(now),
        ncode: "561720",
        limit: "100",
        offset: String(offset),
      }).toString();
      try {
        const response = await (deps.fetch ?? fetch)(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
          cache: "no-store",
          redirect: "error",
        });
        if (!response.ok) throw new Error("Source unavailable");
        const raw = samResponse.parse(
          JSON.parse(await boundedText(response, 2000000)),
        );
        const total = z
          .number()
          .int()
          .nonnegative()
          .safeParse(raw.totalRecords);
        if (!total.success) throw new Error("Source pagination unavailable");
        return JSON.stringify({
          records: normalizeSam(raw),
          count: raw.opportunitiesData.length,
          total: total.data,
        });
      } catch {
        // Provider exceptions can contain the credential-bearing request URL.
        throw new Error("SAM source failed; retry the bounded run");
      }
    },
    {
      name: "search_sam_opportunities",
      description:
        "Read one bounded page from the official SAM API; no arbitrary URLs.",
      schema: z.object({
        offset: z.number().int().min(0).max(400).multipleOf(100),
      }),
    },
  );
  const graph = new StateGraph(State)
    .addNode("search", async (state) => {
      signal.throwIfAborted();
      const page = JSON.parse(
        await search.invoke({ offset: state.offset }, { callbacks: [] }),
      ) as {
        records: RecordInput[];
        count: number;
        total: number;
      };
      if (page.count < 100 && state.offset + page.count < page.total)
        throw new Error("Incomplete SAM page");
      return {
        records: page.records,
        total: page.total,
        pages: state.pages + 1,
        skipped: state.skipped + page.count - page.records.length,
        more: page.count === 100 && state.offset + page.count < page.total,
      };
    })
    .addNode("persist", async (state) => {
      for (const record of state.records) {
        signal.throwIfAborted();
        try {
          await deps.persist(record, signal);
        } catch {
          throw new Error("SAM persistence failed; replay is deduplicated");
        }
      }
      return {
        ingested: state.ingested + state.records.length,
        records: [],
        offset: state.offset + 100,
      };
    })
    .addEdge(START, "search")
    .addEdge("search", "persist")
    .addConditionalEdges("persist", (state) =>
      state.more && state.pages < maxPages ? "search" : END,
    )
    .compile();
  const result = await graph.invoke(
    {
      offset: 0,
      pages: 0,
      ingested: 0,
      skipped: 0,
      total: 0,
      records: [],
      more: false,
    },
    { recursionLimit: 20, callbacks: [] },
  );
  return {
    agent: "sam-collector",
    framework: "langchain/langgraph",
    source: "sam",
    ingested: result.ingested,
    skipped: result.skipped,
    pages: result.pages,
    totalRecords: result.total,
    windowDays: 7,
    paginationRequired: result.more,
  };
}
