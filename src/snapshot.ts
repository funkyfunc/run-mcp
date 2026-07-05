import { createHash } from "node:crypto";

// ─── Snapshot types for reconnect diffing ──────────────────────────────────

export interface ToolSnapshot {
  name: string;
  hash: string;
}

export interface ResourceSnapshot {
  uri: string;
  name: string;
}

export interface PromptSnapshot {
  name: string;
  hash: string;
}

export interface Snapshot {
  tools?: ToolSnapshot[];
  resources?: ResourceSnapshot[];
  resourceTemplates?: { uriTemplate: string; name: string }[];
  prompts?: PromptSnapshot[];
}

export interface DiffEntry {
  added: string[];
  removed: string[];
  modified: string[];
}

/**
 * Hash a tool/prompt definition for change detection.
 * Includes description + schema so we detect both schema and doc changes.
 */
export function hashDefinition(obj: Record<string, unknown>): string {
  return createHash("md5").update(JSON.stringify(obj)).digest("hex").slice(0, 12);
}

/**
 * Compute a diff between two lists of named+hashed items.
 */
export function computeDiff(
  prev: { name: string; hash: string }[],
  curr: { name: string; hash: string }[],
): DiffEntry {
  const prevMap = new Map(prev.map((p) => [p.name, p.hash]));
  const currMap = new Map(curr.map((c) => [c.name, c.hash]));

  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  for (const [name, hash] of currMap) {
    if (!prevMap.has(name)) {
      added.push(name);
    } else if (prevMap.get(name) !== hash) {
      modified.push(name);
    }
  }
  for (const name of prevMap.keys()) {
    if (!currMap.has(name)) {
      removed.push(name);
    }
  }

  return { added, removed, modified };
}

/**
 * Compute a diff between two resource lists (no hash — just presence).
 */
export function computeResourceDiff(prev: ResourceSnapshot[], curr: ResourceSnapshot[]): DiffEntry {
  const prevUris = new Set(prev.map((r) => r.uri));
  const currUris = new Set(curr.map((r) => r.uri));

  const added = [...currUris].filter((u) => !prevUris.has(u));
  const removed = [...prevUris].filter((u) => !currUris.has(u));

  return { added, removed, modified: [] };
}

/**
 * Compute a diff between two resource template lists (no hash — just presence).
 */
export function computeResourceTemplateDiff(
  prev: { uriTemplate: string; name: string }[],
  curr: { uriTemplate: string; name: string }[],
): DiffEntry {
  const prevUris = new Set(prev.map((t) => t.uriTemplate));
  const currUris = new Set(curr.map((t) => t.uriTemplate));

  const added = [...currUris].filter((u) => !prevUris.has(u));
  const removed = [...prevUris].filter((u) => !currUris.has(u));

  return { added, removed, modified: [] };
}

/**
 * Format a diff entry as a human-readable summary line.
 */
export function formatDiffLine(label: string, diff: DiffEntry): string {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`+${diff.added.length} added`);
  if (diff.modified.length > 0) parts.push(`~${diff.modified.length} modified`);
  if (diff.removed.length > 0) parts.push(`-${diff.removed.length} removed`);

  if (parts.length === 0) return `  ${label}: unchanged`;

  const details = parts.join(", ");
  const names = [...diff.added, ...diff.modified, ...diff.removed];
  return `  ${label}: ${details} (${names.join(", ")})`;
}

/**
 * Take a snapshot of an MCP server's current primitives via TargetManager.
 */
export async function takeSnapshot(target: {
  connected: boolean;
  getServerCapabilities: () => any;
  listTools: () => Promise<any>;
  listResources: () => Promise<any>;
  listResourceTemplates: () => Promise<any>;
  listPrompts: () => Promise<any>;
}): Promise<Snapshot> {
  if (!target?.connected) return {};

  const snap: Snapshot = {};
  const caps = target.getServerCapabilities() ?? {};

  if (caps.tools) {
    try {
      const { tools } = await target.listTools();
      snap.tools = tools.map((t: any) => ({
        name: t.name,
        hash: hashDefinition({
          description: t.description,
          inputSchema: t.inputSchema,
        }),
      }));
    } catch {
      /* ignore */
    }
  }

  if (caps.resources) {
    try {
      const { resources } = await target.listResources();
      snap.resources = resources.map((r: any) => ({
        uri: r.uri,
        name: r.name ?? "",
      }));
    } catch {
      /* ignore */
    }
    try {
      const { resourceTemplates } = await target.listResourceTemplates();
      snap.resourceTemplates = resourceTemplates.map((t: any) => ({
        uriTemplate: t.uriTemplate,
        name: t.name ?? "",
      }));
    } catch {
      /* ignore */
    }
  }

  if (caps.prompts) {
    try {
      const { prompts } = await target.listPrompts();
      snap.prompts = prompts.map((p: any) => ({
        name: p.name,
        hash: hashDefinition({ description: p.description }),
      }));
    } catch {
      /* ignore */
    }
  }

  return snap;
}

/**
 * Compute diff between a previous snapshot and current, formatted as text lines.
 */
export function computeSnapshotDiff(previous: Snapshot, current: Snapshot): string[] {
  const lines: string[] = ["", "Changes since last connection:"];

  if (current.tools && previous.tools) {
    lines.push(formatDiffLine("Tools", computeDiff(previous.tools, current.tools)));
  }
  if (current.resources && previous.resources) {
    lines.push(
      formatDiffLine("Resources", computeResourceDiff(previous.resources, current.resources)),
    );
  }
  if (current.resourceTemplates && previous.resourceTemplates) {
    lines.push(
      formatDiffLine(
        "Resource Templates",
        computeResourceTemplateDiff(previous.resourceTemplates, current.resourceTemplates),
      ),
    );
  }
  if (current.prompts && previous.prompts) {
    lines.push(formatDiffLine("Prompts", computeDiff(previous.prompts, current.prompts)));
  }

  // If only "unchanged" entries, simplify
  const hasChanges = lines.some(
    (l) => l.includes("+") || l.includes("~") || l.includes("-removed"),
  );
  if (!hasChanges) {
    return ["", "Changes since last connection: none"];
  }

  return lines;
}
