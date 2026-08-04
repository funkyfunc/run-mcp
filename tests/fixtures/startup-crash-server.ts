#!/usr/bin/env node

/**
 * A server that dies during startup after writing a diagnostic to stderr —
 * the single most common failure an agent hits while developing a server.
 * Used to prove the connect-failure path surfaces that diagnostic instead of
 * the transport's opaque "Connection closed".
 */

process.stderr.write("[startup-crash] FATAL: cannot find module './db-config.js'\n");
process.stderr.write("[startup-crash]   at loadConfig (src/index.js:12:9)\n");
process.exit(1);
