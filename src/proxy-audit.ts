import http from "node:http";
import net from "node:net";

export class NetworkAuditProxy {
  private server: http.Server;
  private port = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      const url = req.url || "";
      console.error(`\x1b[36m🌐 [NETWORK AUDIT] HTTP request to: ${url}\x1b[0m`);

      try {
        const parsedUrl = new URL(url);
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
      } catch (err: any) {
        res.writeHead(400);
        res.end(`Invalid URL: ${err.message}`);
      }
    });

    // Handle HTTPS CONNECT tunnel
    this.server.on("connect", (req, clientSocket, head) => {
      const parts = req.url ? req.url.split(":") : [];
      const hostname = parts[0];
      const port = parts[1] ? Number.parseInt(parts[1], 10) : 443;

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
