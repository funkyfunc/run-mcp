import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import { NetworkAuditProxy } from "../src/proxy-audit.js";

describe("NetworkAuditProxy", () => {
  let proxy: NetworkAuditProxy;
  let proxyPort: number;
  let consoleSpy: any;

  beforeEach(async () => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    proxy = new NetworkAuditProxy();
    proxyPort = await proxy.start();
  });

  afterEach(async () => {
    await proxy.close();
    consoleSpy.mockRestore();
  });

  it("successfully proxies HTTP request and logs destination", async () => {
    // 1. Start a mock target HTTP server
    const targetServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("target response");
    });

    const targetPort = await new Promise<number>((resolve) => {
      targetServer.listen(0, "127.0.0.1", () => {
        const addr = targetServer.address();
        resolve((addr as any).port);
      });
    });

    // 2. Make an HTTP request through the proxy
    await new Promise<void>((resolve, reject) => {
      const options = {
        hostname: "127.0.0.1",
        port: proxyPort,
        path: `http://127.0.0.1:${targetPort}/api/test`,
        method: "GET",
      };

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          expect(data).toBe("target response");
          resolve();
        });
      });

      req.on("error", (err) => reject(err));
      req.end();
    });

    // 3. Verify console audit logs
    const calls = consoleSpy.mock.calls.map((c: any) => c[0]);
    expect(calls.some((c: string) => c.includes("[NETWORK AUDIT] HTTP request to:"))).toBe(true);

    // Cleanup target
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
  });

  it("successfully proxies HTTPS CONNECT request and logs destination", async () => {
    // 1. Start a mock target TCP server (to simulate HTTPS server)
    const targetServer = net.createServer((socket) => {
      socket.on("data", (data) => {
        if (data.toString().startsWith("GET / ")) {
          socket.write("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\npong");
        }
      });
    });

    const targetPort = await new Promise<number>((resolve) => {
      targetServer.listen(0, "127.0.0.1", () => {
        const addr = targetServer.address();
        resolve((addr as any).port);
      });
    });

    // 2. Make a CONNECT request to establish a tunnel
    await new Promise<void>((resolve, reject) => {
      const connReq = http.request({
        hostname: "127.0.0.1",
        port: proxyPort,
        method: "CONNECT",
        path: `127.0.0.1:${targetPort}`,
      });

      connReq.on("connect", (res, socket) => {
        // Send a mock HTTP payload over the established tunnel
        socket.write("GET / HTTP/1.1\r\n\r\n");

        let response = "";
        socket.on("data", (chunk) => {
          response += chunk.toString();
          if (response.includes("pong")) {
            socket.end();
            resolve();
          }
        });
      });

      connReq.on("error", (err) => reject(err));
      connReq.end();
    });

    // 3. Verify console audit logs
    const calls = consoleSpy.mock.calls.map((c: any) => c[0]);
    expect(
      calls.some((c: string) =>
        c.includes("[NETWORK AUDIT] HTTPS connection established to: 127.0.0.1"),
      ),
    ).toBe(true);

    // Cleanup target
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
  });
});

describe("NetworkAuditProxy enforcement", () => {
  let consoleSpy: any;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("blocks HTTP requests to disallowed hosts with 403 and logs the block", async () => {
    // Predicate: only allow example.com, deny everything else (e.g. 127.0.0.1)
    const proxy = new NetworkAuditProxy((host) => host.startsWith("example.com"));
    const proxyPort = await proxy.start();

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: proxyPort,
          path: "http://127.0.0.1:9/blocked",
          method: "GET",
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(status).toBe(403);
    const calls = consoleSpy.mock.calls.map((c: any) => c[0]);
    expect(calls.some((c: string) => c.includes("[NETWORK BLOCKED]"))).toBe(true);

    await proxy.close();
  });

  it("refuses CONNECT tunnels to disallowed hosts", async () => {
    const proxy = new NetworkAuditProxy((host) => host.startsWith("example.com"));
    const proxyPort = await proxy.start();

    const blocked = await new Promise<boolean>((resolve) => {
      const connReq = http.request({
        hostname: "127.0.0.1",
        port: proxyPort,
        method: "CONNECT",
        path: "127.0.0.1:9",
      });
      // Node fires "connect" even for a non-2xx CONNECT response, so a refused
      // tunnel is signalled by a non-200 status (we return 403) rather than 200.
      connReq.on("connect", (res, socket) => {
        socket.destroy();
        resolve((res.statusCode ?? 0) !== 200);
      });
      connReq.on("error", () => resolve(true));
      connReq.end();
    });

    expect(blocked).toBe(true);
    const calls = consoleSpy.mock.calls.map((c: any) => c[0]);
    expect(calls.some((c: string) => c.includes("[NETWORK BLOCKED]"))).toBe(true);

    await proxy.close();
  });
});
