/**
 * BM25 relevance ranking for tool discovery — the "Level 2" of Dynamic Context
 * Loading. Ranks a tool catalog against a query so an agent finds the right tool
 * without eager-loading every schema into context (the "Tools Tax").
 *
 * BM25 is the classic term-frequency ranking (with saturation + document-length
 * normalization) — and it's exactly what Anthropic's built-in tool-search tool
 * uses for its natural-language variant. It stays pure, deterministic, and
 * dependency-free (no embedding model). Following that feature, tools are indexed
 * over their name, description, and argument names + descriptions; the name is
 * weighted higher so name matches surface first.
 */

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "for",
  "and",
  "or",
  "in",
  "on",
  "with",
  "by",
  "is",
  "are",
  "be",
  "this",
  "that",
  "it",
  "as",
  "at",
  "from",
  "my",
  "i",
  "me",
  "please",
  "want",
  "need",
  "get",
  "can",
  "how",
  "do",
  "use",
  "using",
]);

/** Raw significant tokens (with repeats — term frequencies matter for BM25). */
function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Split text into lowercased, de-duplicated significant tokens. */
export function tokenize(text: string): string[] {
  return Array.from(new Set(terms(text)));
}

export interface RankableTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RankedTool<T extends RankableTool = RankableTool> {
  tool: T;
  score: number;
}

// BM25 parameters (standard defaults).
const K1 = 1.2;
const B = 0.75;
/** How many times to repeat name tokens in a tool's document (name weighting). */
const NAME_BOOST = 3;

/** Build the searchable term list for one tool (name-boosted + args). */
function toolTerms(tool: RankableTool): string[] {
  const out: string[] = [];
  const nameTerms = terms(tool.name ?? "");
  for (let i = 0; i < NAME_BOOST; i++) out.push(...nameTerms);
  if (tool.description) out.push(...terms(tool.description));

  const props = (tool.inputSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [argName, argSchema] of Object.entries(props)) {
    out.push(...terms(argName));
    if (typeof argSchema?.description === "string") out.push(...terms(argSchema.description));
  }
  return out;
}

interface Doc {
  tf: Map<string, number>;
  length: number;
}

/**
 * Rank tools by BM25 relevance to a query. With a non-empty query, only tools
 * with a positive score are returned (best first, name-tiebroken), capped at
 * `limit`. With an empty query, returns the first `limit` tools unranked.
 */
export function rankTools<T extends RankableTool>(
  query: string,
  tools: T[],
  limit = 5,
): RankedTool<T>[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return tools.slice(0, limit).map((tool) => ({ tool, score: 0 }));
  }

  // Build the per-tool documents and corpus statistics.
  const docs: Doc[] = tools.map((tool) => {
    const ts = toolTerms(tool);
    const tf = new Map<string, number>();
    for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { tf, length: ts.length };
  });

  const N = docs.length || 1;
  const avgdl = docs.reduce((sum, d) => sum + d.length, 0) / N || 1;

  // Document frequency per query term.
  const df = new Map<string, number>();
  for (const qt of queryTokens) {
    let count = 0;
    for (const d of docs) if (d.tf.has(qt)) count++;
    df.set(qt, count);
  }

  const scoreDoc = (doc: Doc): number => {
    let score = 0;
    for (const qt of queryTokens) {
      const f = doc.tf.get(qt);
      if (!f) continue;
      const n = df.get(qt) ?? 0;
      // "Plus" IDF variant — always non-negative.
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const denom = f + K1 * (1 - B + (B * doc.length) / avgdl);
      score += idf * ((f * (K1 + 1)) / denom);
    }
    return score;
  };

  return tools
    .map((tool, i) => ({ tool, score: scoreDoc(docs[i]) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit);
}
