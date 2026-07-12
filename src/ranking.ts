/**
 * Lightweight relevance ranking for tool discovery — the "Level 2" of Dynamic
 * Context Loading. Given a query and a tool catalog, rank tools by how well their
 * name/description match, so an agent can find the right tool without eager-
 * loading every schema into context (the "Tools Tax").
 *
 * This uses lexical token-overlap scoring, not sentence embeddings. Embeddings
 * rank better, but a zero-dependency local CLI can't ship a model; lexical
 * ranking is the pragmatic default and keeps this pure and instant. The scoring
 * is intentionally simple and deterministic so results are explainable.
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

/** Split text into lowercased, de-duplicated significant tokens. */
export function tokenize(text: string): string[] {
  const raw = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return Array.from(new Set(raw));
}

export interface RankableTool {
  name: string;
  description?: string;
  [key: string]: unknown;
}

export interface RankedTool<T extends RankableTool = RankableTool> {
  tool: T;
  score: number;
}

/**
 * Score one tool against pre-tokenized query terms. Name matches weigh more than
 * description matches; whole-query substring hits get a bonus. Returns 0 for no
 * overlap.
 */
export function scoreTool(queryTokens: string[], query: string, tool: RankableTool): number {
  if (queryTokens.length === 0) return 0;
  const name = tool.name ?? "";
  const description = tool.description ?? "";
  const nameTokens = new Set(tokenize(name));
  const descTokens = new Set(tokenize(description));
  const lowerName = name.toLowerCase();
  const lowerDesc = description.toLowerCase();

  let score = 0;
  for (const qt of queryTokens) {
    if (nameTokens.has(qt)) score += 3;
    else if (lowerName.includes(qt)) score += 2; // partial name hit (e.g. "screenshot" vs "shot")
    if (descTokens.has(qt)) score += 1;
  }
  // Whole-query substring bonus.
  const q = query.trim().toLowerCase();
  if (q && lowerName.includes(q)) score += 3;
  else if (q && lowerDesc.includes(q)) score += 1;

  return score;
}

/**
 * Rank tools by relevance to a query. With a non-empty query, only tools with a
 * positive score are returned (best first, name-tiebroken), capped at `limit`.
 * With an empty query, returns the first `limit` tools unranked (score 0).
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

  return tools
    .map((tool) => ({ tool, score: scoreTool(queryTokens, query, tool) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit);
}
