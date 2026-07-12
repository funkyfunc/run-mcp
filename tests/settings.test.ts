import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import {
  resolvePath,
  matchDomain,
  SandboxPolicy,
  loadSettings,
  escapeSbplString,
} from "../src/settings.js";

describe("settings path resolution", () => {
  it("resolves home directory prefix ~", () => {
    const res = resolvePath("~/test", "/workspace");
    expect(res).toBe(resolve(homedir(), "test"));
  });

  it("resolves home directory prefix $HOME", () => {
    const res = resolvePath("$HOME/test/path", "/workspace");
    expect(res).toBe(resolve(homedir(), "test/path"));
  });

  it("resolves absolute paths unchanged", () => {
    const res = resolvePath("/etc/passwd", "/workspace");
    expect(res).toBe(resolve("/etc/passwd"));
  });

  it("resolves relative paths to settings file directory", () => {
    const res = resolvePath("./relative/file.txt", "/workspace");
    expect(res).toBe(resolve("/workspace/relative/file.txt"));
  });
});

describe("SBPL profile injection hardening", () => {
  it("escapes double quotes and backslashes in SBPL string literals", () => {
    expect(escapeSbplString('a"b')).toBe('a\\"b');
    expect(escapeSbplString("a\\b")).toBe("a\\\\b");
  });

  it("rejects values containing control characters", () => {
    expect(() => escapeSbplString("a\nb")).toThrow(/control character/i);
    expect(() => escapeSbplString("a\x00b")).toThrow(/control character/i);
  });

  it("neutralizes a crafted deny path so it cannot break out of the profile", () => {
    const policy = new SandboxPolicy();
    // A malicious project-scoped config could try to inject SBPL directives.
    const evil = '/tmp/x") (allow network*) (subpath "/';
    policy.mergeConfig({ file: { deny: { read: [evil] } } }, "/workspace");

    const profile = policy.getSeatbeltProfile({
      tmp: "/tmp",
      cwd: "/workspace",
      nodeBinDir: "/usr/local/bin",
      nodeInstallDir: "/usr/local",
    });

    // The injected raw directive must NOT appear unescaped; the quote is escaped.
    expect(profile).not.toContain('(subpath "/tmp/x") (allow network*)');
    expect(profile).toContain('\\"');
  });
});

describe("settings domain matching", () => {
  it("matches simple domains", () => {
    expect(matchDomain("api.github.com", "api.github.com")).toBe(true);
    expect(matchDomain("api.github.com", "github.com")).toBe(false);
  });

  it("matches wildcard domains", () => {
    expect(matchDomain("api.github.com", "*.github.com")).toBe(true);
    expect(matchDomain("web.github.com", "*.github.com")).toBe(true);
    expect(matchDomain("github.com", "*.github.com")).toBe(false);
  });

  it("matches wildcards with ports", () => {
    expect(matchDomain("localhost:3000", "localhost:3000")).toBe(true);
    expect(matchDomain("localhost:3000", "localhost:*")).toBe(true);
    expect(matchDomain("localhost:3000", "*:3000")).toBe(true);
    expect(matchDomain("localhost:3000", "localhost:5000")).toBe(false);
  });

  it("matches global wildcard", () => {
    expect(matchDomain("anydomain.com", "*")).toBe(true);
  });
});

describe("SandboxPolicy validation rules", () => {
  it("applies Deny-Wins precedence", () => {
    const policy = new SandboxPolicy();

    // Add to allow list
    policy.fileReadAllow.add(resolve("/workspace/data"));
    policy.fileReadAllow.add(resolve("/workspace/logs"));

    // Add to deny list
    policy.fileReadDeny.add(resolve("/workspace/data/sensitive.json"));

    // Verify allowed path
    expect(policy.isFileReadAllowed("/workspace/logs")).toBe(true);
    expect(policy.isFileReadAllowed("/workspace/data/normal.json")).toBe(true);

    // Verify denied path (subpath match under Deny list)
    expect(policy.isFileReadAllowed("/workspace/data/sensitive.json")).toBe(false);
  });

  it("supports network allow/deny precedence", () => {
    const policy = new SandboxPolicy();

    policy.networkAllow.add("*.github.com");
    policy.networkDeny.add("api.github.com");

    expect(policy.isNetworkAllowed("web.github.com")).toBe(true);
    expect(policy.isNetworkAllowed("api.github.com")).toBe(false); // Deny wins
  });

  it("supports merging CLI overrides", () => {
    const policy = new SandboxPolicy();
    policy.mergeCliOverrides({
      allowRead: ["/cli/allow"],
      denyRead: ["/cli/deny"],
      allowNet: ["*.cli.net"],
    });

    expect(policy.isFileReadAllowed("/cli/allow")).toBe(true);
    expect(policy.isFileReadAllowed("/cli/deny")).toBe(false);
    expect(policy.isNetworkAllowed("api.cli.net")).toBe(true);
  });
});

describe("loadSettings file loading and hierarchy", () => {
  const tmpDir = resolve("./tmp-settings-test");

  it("loads and merges configurations in precedence order", () => {
    mkdirSync(join(tmpDir, ".run-mcp"), { recursive: true });

    // Local configuration
    writeFileSync(
      join(tmpDir, ".run-mcp", "settings.local.json"),
      JSON.stringify({
        sandbox: {
          file: {
            allow: {
              read: ["/local/allow"],
            },
            deny: {
              read: ["/local/deny"],
            },
          },
          network: {
            allow: ["local.net"],
          },
        },
      }),
    );

    // Project configuration
    writeFileSync(
      join(tmpDir, ".run-mcp", "settings.json"),
      JSON.stringify({
        sandbox: {
          file: {
            allow: {
              read: ["/project/allow"],
            },
          },
          network: {
            allow: ["project.net"],
          },
        },
      }),
    );

    const settings = loadSettings(tmpDir);
    expect(settings.sandbox?.file?.allow?.read).toContain(resolve("/local/allow"));
    expect(settings.sandbox?.file?.allow?.read).toContain(resolve("/project/allow"));
    expect(settings.sandbox?.file?.deny?.read).toContain(resolve("/local/deny"));
    expect(settings.sandbox?.network?.allow).toContain("local.net");
    expect(settings.sandbox?.network?.allow).toContain("project.net");

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("SandboxPolicy seatbelt audit profile", () => {
  it("generates strict lockdown profile when audit option is true", () => {
    const policy = new SandboxPolicy();
    const profile = policy.getSeatbeltProfile({
      tmp: "/tmp",
      cwd: "/workspace",
      nodeBinDir: "/usr/local/bin",
      nodeInstallDir: "/usr/local",
      audit: true,
    });

    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain("(deny process-fork)");
    expect(profile).toContain("(deny process-exec*)");
    expect(profile).not.toContain("(allow file-write*");
  });
});

describe("SandboxPolicy credential protection rules", () => {
  it("automatically denies reading sensitive credential paths if network is allowed", () => {
    const policy = new SandboxPolicy();
    policy.networkAllow.add("example.com");
    policy.applyCredentialProtections();

    const cwd = process.cwd();
    const sshPath = resolvePath("~/.ssh", cwd);
    const awsPath = resolvePath("~/.aws", cwd);

    expect(policy.fileReadDeny.has(sshPath)).toBe(true);
    expect(policy.fileReadDeny.has(awsPath)).toBe(true);
  });

  it("does not deny reading credential paths if they are explicitly allowed", () => {
    const policy = new SandboxPolicy();
    const cwd = process.cwd();
    const sshPath = resolvePath("~/.ssh", cwd);

    policy.fileReadAllow.add(sshPath);
    policy.networkAllow.add("example.com");
    policy.applyCredentialProtections();

    expect(policy.fileReadDeny.has(sshPath)).toBe(false);
  });
});
