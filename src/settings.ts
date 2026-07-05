import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

export interface FileRules {
  read?: string[];
  write?: string[];
}

export interface SandboxConfig {
  file?: {
    allow?: FileRules;
    deny?: FileRules;
  };
  network?: {
    allow?: string[];
    deny?: string[];
  };
}

export interface Settings {
  sandbox?: SandboxConfig;
}

export function resolvePath(p: string, settingsFileDir: string): string {
  if (p.startsWith("~")) {
    return resolve(homedir(), p.slice(1).replace(/^[/\\]/, ""));
  }
  if (p.startsWith("$HOME")) {
    return resolve(homedir(), p.slice(5).replace(/^[/\\]/, ""));
  }
  if (isAbsolute(p)) {
    return resolve(p);
  }
  return resolve(settingsFileDir, p);
}

export function matchDomain(host: string, pattern: string): boolean {
  if (pattern === "*") return true;

  // Extract hostname and port if present
  const [hostName, hostPort] = host.split(":");
  const [patternName, patternPort] = pattern.split(":");

  // If port is specified in pattern, match it
  if (patternPort && patternPort !== "*") {
    if (hostPort !== patternPort) return false;
  }

  // Match hostname using wildcard
  const regexPattern = patternName.replace(/\./g, "\\.").replace(/\*/g, ".*");
  const regex = new RegExp(`^${regexPattern}$`, "i");
  return regex.test(hostName);
}

export class SandboxPolicy {
  // Allowlists (Absolute paths or patterns)
  readonly fileReadAllow = new Set<string>();
  readonly fileWriteAllow = new Set<string>();
  readonly networkAllow = new Set<string>();

  // Denylists (Absolute paths or patterns)
  readonly fileReadDeny = new Set<string>();
  readonly fileWriteDeny = new Set<string>();
  readonly networkDeny = new Set<string>();

  constructor() {}

  /**
   * Merge a SandboxConfig block into the policy.
   * Path rules are resolved relative to the settingsFileDir.
   */
  mergeConfig(config: SandboxConfig, settingsFileDir: string): void {
    // 1. File Allow read/write
    if (config.file?.allow?.read) {
      for (const p of config.file.allow.read) {
        this.fileReadAllow.add(resolvePath(p, settingsFileDir));
      }
    }
    if (config.file?.allow?.write) {
      for (const p of config.file.allow.write) {
        this.fileWriteAllow.add(resolvePath(p, settingsFileDir));
      }
    }

    // 2. File Deny read/write
    if (config.file?.deny?.read) {
      for (const p of config.file.deny.read) {
        this.fileReadDeny.add(resolvePath(p, settingsFileDir));
      }
    }
    if (config.file?.deny?.write) {
      for (const p of config.file.deny.write) {
        this.fileWriteDeny.add(resolvePath(p, settingsFileDir));
      }
    }

    // 3. Network Allow/Deny
    if (config.network?.allow) {
      for (const host of config.network.allow) {
        this.networkAllow.add(host);
      }
    }
    if (config.network?.deny) {
      for (const host of config.network.deny) {
        this.networkDeny.add(host);
      }
    }
  }

  /**
   * Merge raw command line overrides.
   * CLI overrides are resolved relative to the process CWD.
   */
  mergeCliOverrides(options: {
    allowRead?: string[];
    allowWrite?: string[];
    allowNet?: string[];
    denyRead?: string[];
    denyWrite?: string[];
    denyNet?: string[];
  }): void {
    const cwd = process.cwd();
    if (options.allowRead) {
      for (const p of options.allowRead) this.fileReadAllow.add(resolvePath(p, cwd));
    }
    if (options.allowWrite) {
      for (const p of options.allowWrite) this.fileWriteAllow.add(resolvePath(p, cwd));
    }
    if (options.allowNet) {
      for (const host of options.allowNet) this.networkAllow.add(host);
    }
    if (options.denyRead) {
      for (const p of options.denyRead) this.fileReadDeny.add(resolvePath(p, cwd));
    }
    if (options.denyWrite) {
      for (const p of options.denyWrite) this.fileWriteDeny.add(resolvePath(p, cwd));
    }
    if (options.denyNet) {
      for (const host of options.denyNet) this.networkDeny.add(host);
    }
  }

  /**
   * Automatically deny reading sensitive credential directories if network outbound is allowed.
   */
  applyCredentialProtections(): void {
    if (this.networkAllow.size > 0 && !this.networkDeny.has("*")) {
      const sensitivePatterns = [
        "~/.ssh",
        "~/.aws",
        "~/.kube",
        "~/.config/gcloud",
        "~/.netrc",
        "~/.npmrc",
      ];
      const cwd = process.cwd();
      for (const pattern of sensitivePatterns) {
        const resolved = resolvePath(pattern, cwd);
        if (!this.fileReadAllow.has(resolved)) {
          this.fileReadDeny.add(resolved);
        }
      }
    }
  }

  /**
   * Evaluates if a file read path is allowed, under Deny-Wins precedence.
   */
  isFileReadAllowed(p: string): boolean {
    const absPath = resolve(p);

    // Deny Wins: if matched by any deny path (prefix/subpath match)
    for (const denyPath of this.fileReadDeny) {
      if (absPath === denyPath || absPath.startsWith(denyPath + "/")) {
        return false;
      }
    }

    // Allow list check
    for (const allowPath of this.fileReadAllow) {
      if (absPath === allowPath || absPath.startsWith(allowPath + "/")) {
        return true;
      }
    }

    return false;
  }

  /**
   * Evaluates if a file write path is allowed, under Deny-Wins precedence.
   */
  isFileWriteAllowed(p: string): boolean {
    const absPath = resolve(p);

    // Deny Wins
    for (const denyPath of this.fileWriteDeny) {
      if (absPath === denyPath || absPath.startsWith(denyPath + "/")) {
        return false;
      }
    }

    // Allow list check
    for (const allowPath of this.fileWriteAllow) {
      if (absPath === allowPath || absPath.startsWith(allowPath + "/")) {
        return true;
      }
    }

    return false;
  }

  /**
   * Evaluates if network access to a host (hostname:port or hostname) is allowed.
   */
  isNetworkAllowed(host: string): boolean {
    // Deny Wins
    for (const denyPattern of this.networkDeny) {
      if (matchDomain(host, denyPattern)) {
        return false;
      }
    }

    // Allow list check
    for (const allowPattern of this.networkAllow) {
      if (matchDomain(host, allowPattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Generate Scheme-based macOS Seatbelt profile.
   */
  getSeatbeltProfile(options: {
    tmp: string;
    cwd: string;
    nodeBinDir: string;
    nodeInstallDir: string;
    audit?: boolean;
  }): string {
    if (options.audit) {
      return `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(deny process-fork)
(deny process-exec*)
(allow process-exec*
  (subpath "/System")
  (subpath "/usr")
  (subpath "/bin")
  (subpath "${options.nodeBinDir}")
)
(deny file-read*)
(allow file-read*
  (literal "/")
  (subpath "/System")
  (subpath "/usr")
  (subpath "/dev")
  (subpath "/private/var")
  (subpath "/var")
  (subpath "/private/etc")
  (subpath "/etc")
  (subpath "${options.nodeBinDir}")
  (subpath "${options.nodeInstallDir}")
  (subpath "${options.cwd}")
  (path-ancestors "${options.cwd}")
  (path-ancestors "${options.nodeBinDir}")
)
`;
    }

    const readDirectives = Array.from(this.fileReadAllow)
      .map((p) => `  (subpath "${p}")`)
      .join("\n");
    const writeDirectives = Array.from(this.fileWriteAllow)
      .map((p) => `  (subpath "${p}")`)
      .join("\n");

    const readDenyDirectives = Array.from(this.fileReadDeny)
      .map((p) => `  (subpath "${p}")`)
      .join("\n");
    const writeDenyDirectives = Array.from(this.fileWriteDeny)
      .map((p) => `  (subpath "${p}")`)
      .join("\n");

    // Network allow rules
    let netRules: string;
    if (this.networkAllow.size > 0 && !this.networkDeny.has("*")) {
      // Allow outbound network to whitelisted domains
      netRules = `(allow network-outbound)\n`;
      // If there are explicit denies, we handle them
      if (this.networkDeny.size > 0) {
        for (const pattern of this.networkDeny) {
          if (pattern !== "*") {
            // Note: macOS Seatbelt resolved IPs or domains can be denied.
            // In allow default posture, we can explicitly deny specific domains.
            netRules += `(deny network-outbound (remote ip "${pattern}"))\n`;
          }
        }
      }
    } else {
      netRules = `(deny network*)\n`;
    }

    return `(version 1)
(allow default)
${netRules}
(deny file-write*)
(allow file-write*
  (subpath "${options.tmp}")
  (subpath "/private/tmp")
  (subpath "/tmp")
${writeDirectives}
)
${writeDenyDirectives ? `(deny file-write*\n${writeDenyDirectives}\n)\n` : ""}
(deny file-read*)
(allow file-read*
  (literal "/")
  (subpath "/System")
  (subpath "/usr")
  (subpath "/dev")
  (subpath "/private/var")
  (subpath "/var")
  (subpath "/private/etc")
  (subpath "/etc")
  (subpath "/private/tmp")
  (subpath "/tmp")
  (subpath "${options.nodeBinDir}")
  (subpath "${options.nodeInstallDir}")
  (subpath "${options.cwd}")
  (subpath "${options.tmp}")
  (path-ancestors "${options.cwd}")
  (path-ancestors "${options.nodeBinDir}")
${readDirectives}
)
${readDenyDirectives ? `(deny file-read*\n${readDenyDirectives}\n)\n` : ""}
`;
  }
}

/**
 * Scan and load settings files across Managed, User, Project, and Local scopes.
 */
export function loadSettings(cwd: string = process.cwd()): Settings {
  const settings: Settings = { sandbox: {} };
  const loadedConfigs: { config: SandboxConfig; dir: string }[] = [];

  // 1. Managed (Enterprise) Settings
  let managedPath: string;
  if (process.platform === "darwin") {
    managedPath = "/Library/Application Support/run-mcp/settings.json";
  } else if (process.platform === "win32") {
    managedPath = join(process.env.ProgramFiles || "C:\\Program Files", "run-mcp", "settings.json");
  } else {
    managedPath = "/etc/run-mcp/settings.json";
  }
  if (existsSync(managedPath)) {
    try {
      const config = JSON.parse(readFileSync(managedPath, "utf8"));
      if (config.sandbox) loadedConfigs.push({ config: config.sandbox, dir: dirname(managedPath) });
    } catch {
      // ignore parsing error
    }
  }

  // 2. Global User Settings
  const userPath = join(homedir(), ".run-mcp", "settings.json");
  if (existsSync(userPath)) {
    try {
      const config = JSON.parse(readFileSync(userPath, "utf8"));
      if (config.sandbox) loadedConfigs.push({ config: config.sandbox, dir: dirname(userPath) });
    } catch {
      // ignore parsing error
    }
  }

  // 3. Project Settings
  const projectPath = join(cwd, ".run-mcp", "settings.json");
  if (existsSync(projectPath)) {
    try {
      const config = JSON.parse(readFileSync(projectPath, "utf8"));
      if (config.sandbox) loadedConfigs.push({ config: config.sandbox, dir: dirname(projectPath) });
    } catch {
      // ignore parsing error
    }
  }

  // 4. Local Settings (ignored in source control)
  const localPath = join(cwd, ".run-mcp", "settings.local.json");
  if (existsSync(localPath)) {
    try {
      const config = JSON.parse(readFileSync(localPath, "utf8"));
      if (config.sandbox) loadedConfigs.push({ config: config.sandbox, dir: dirname(localPath) });
    } catch {
      // ignore parsing error
    }
  }

  // Resolve Policy from loaded configs in hierarchical order:
  // Precedence is Managed -> Local -> Project -> User.
  // We can merge them into a single SandboxPolicy.
  const policy = new SandboxPolicy();
  for (const item of loadedConfigs) {
    policy.mergeConfig(item.config, item.dir);
  }

  // Return resolved sandbox configuration representing the policy
  settings.sandbox = {
    file: {
      allow: {
        read: Array.from(policy.fileReadAllow),
        write: Array.from(policy.fileWriteAllow),
      },
      deny: {
        read: Array.from(policy.fileReadDeny),
        write: Array.from(policy.fileWriteDeny),
      },
    },
    network: {
      allow: Array.from(policy.networkAllow),
      deny: Array.from(policy.networkDeny),
    },
  };

  return settings;
}
