import http from "node:http";
import net from "node:net";

/**
 * Local proxy that outbound traffic from a sandboxed target is forced through
 * (via `http_proxy`/`https_proxy` env vars).
 *
 * It does two jobs:
 *   1. **Audit** — every outbound HTTP request and HTTPS CONNECT is logged to
 *      stderr so you can see exactly where a server is sending data.
 *   2. **Enforce** — if an `isAllowed` predicate is supplied, destinations that
 *      fail the check are blocked (HTTP 403 / refused CONNECT) instead of
 *      forwarded. Without a predicate the proxy is audit-only (legacy behavior).
 *
 * Enforcement here backs the OS sandbox: on macOS Seatbelt only grants a blanket
 * `network-outbound`, and on Linux bwrap network is all-or-nothing, so per-domain
 * allow/deny is only real because this proxy applies it.
 */
export class NetworkAuditProxy {
  private server: http.Server;
  private port = 0;
  private readonly isAllowed: (host: string) => boolean;

  constructor(isAllowed?: (host: string) => boolean) {
    // Default: allow everything (pure audit mode).
    this.isAllowed = isAllowed ?? (() => true);

    this.server = http.createServer((req, res) => {
      const url = req.url || "";

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch (err: any) {
        res.writeHead(400);
        res.end(`Invalid URL: ${err.message}`);
        return;
      }

      const port = parsedUrl.port || "80";
      const hostKey = `${parsedUrl.hostname}:${port}`;

      if (!this.isAllowed(hostKey)) {
        console.error(
          `\x1b[31m🚫 [NETWORK BLOCKED] HTTP request to ${hostKey} denied by sandbox policy\x1b[0m`,
        );
        res.writeHead(403);
        res.end(`Blocked by run-mcp sandbox network policy: ${hostKey}`);
        return;
      }

      console.error(`\x1b[36m🌐 [NETWORK AUDIT] HTTP request to: ${url}\x1b[0m`);

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.pathname + parsedUrl.search,
        method: req.method,
        headers: req.headers,
      };

      const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on("error", (err) => {
        res.writeHead(502);
        res.end(`Proxy Error: ${err.message}`);
      });

      req.pipe(proxyReq);
    });

    // Handle HTTPS CONNECT tunnel
    this.server.on("connect", (req, clientSocket, head) => {
      const parts = req.url ? req.url.split(":") : [];
      const hostname = parts[0];
      const port = parts[1] ? Number.parseInt(parts[1], 10) : 443;
      const hostKey = `${hostname}:${port}`;

      if (!this.isAllowed(hostKey)) {
        console.error(
          `\x1b[31m🚫 [NETWORK BLOCKED] HTTPS connection to ${hostKey} denied by sandbox policy\x1b[0m`,
        );
        clientSocket.end(
          `HTTP/1.1 403 Forbidden\r\n\r\nBlocked by run-mcp sandbox network policy: ${hostKey}`,
        );
        return;
      }

      console.error(
        `\x1b[36m🌐 [NETWORK AUDIT] HTTPS connection established to: ${hostname}:${port}\x1b[0m`,
      );

      const serverSocket = net.connect(port, hostname, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
      });

      serverSocket.on("error", (err) => {
        clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\nProxy Connection Error: ${err.message}`);
      });
      clientSocket.on("error", () => {
        serverSocket.end();
      });
    });
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.on("error", (err) => {
        reject(err);
      });
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        resolve(this.port);
      });
    });
  }

  async close(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  getPort(): number {
    return this.port;
  }
}
