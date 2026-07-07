import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { TargetManager } from "./target-manager.js";
import schema from "./schema/mcp-schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true, strict: false });
(addFormats as any)(ajv);
ajv.addSchema(schema, "mcp-schema.json");

// Compile validators against JSON Schema $defs
const validateServerCapabilities = ajv.compile({
  $ref: "mcp-schema.json#/$defs/ServerCapabilities",
});
const validateImplementation = ajv.compile({ $ref: "mcp-schema.json#/$defs/Implementation" });
const validateListToolsResult = ajv.compile({ $ref: "mcp-schema.json#/$defs/ListToolsResult" });
const validateListResourcesResult = ajv.compile({
  $ref: "mcp-schema.json#/$defs/ListResourcesResult",
});
const validateListPromptsResult = ajv.compile({ $ref: "mcp-schema.json#/$defs/ListPromptsResult" });

export interface ValidationCheck {
  name: string;
  status: "PASS" | "WARN" | "FAIL";
  message?: string;
}

export interface ValidationReport {
  success: boolean;
  status: "PASS" | "WARN" | "FAIL";
  checks: ValidationCheck[];
}

export async function validateProtocol(
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<ValidationReport> {
  const checks: ValidationCheck[] = [];
  let target: TargetManager | null = null;

  // Helper to push checks
  const addCheck = (name: string, status: "PASS" | "WARN" | "FAIL", message?: string) => {
    checks.push({ name, status, message });
  };

  const requestWithTimeout = async (
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 2000,
  ): Promise<any> => {
    return Promise.race([
      target!.requestRaw(method, params),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Request to "${method}" timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  };

  try {
    // 1. Connection check
    target = new TargetManager(command, args, { sandbox: "none" });

    // Set custom env if provided
    if (env) {
      for (const [k, v] of Object.entries(env)) {
        process.env[k] = v;
      }
    }

    try {
      await Promise.race([
        target.connect(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Handshake connection timed out after 5000ms")), 5000),
        ),
      ]);
      addCheck("handshake_connection", "PASS", "Connected and completed initialization handshake.");
    } catch (err: any) {
      addCheck("handshake_connection", "FAIL", `Failed to connect/initialize: ${err.message}`);
      return finalizeReport(checks);
    }

    // 2. Server Implementation Metadata Check
    const versionInfo = target.getServerVersion();
    if (versionInfo) {
      const valid = validateImplementation(versionInfo);
      if (valid) {
        addCheck(
          "implementation_metadata",
          "PASS",
          `Server implementation: "${versionInfo.name}" (version: ${versionInfo.version})`,
        );
      } else {
        const errors = ajv.errorsText(validateImplementation.errors);
        addCheck(
          "implementation_metadata",
          "WARN",
          `Server implementation format is invalid: ${errors}`,
        );
      }
    } else {
      addCheck(
        "implementation_metadata",
        "FAIL",
        "Server did not provide implementation name/version in handshake.",
      );
    }

    // 3. Server Capabilities Check
    const capabilities = target.getServerCapabilities();
    if (capabilities) {
      const valid = validateServerCapabilities(capabilities);
      if (valid) {
        const capsList = Object.keys(capabilities).filter((k) => (capabilities as any)[k]);
        addCheck(
          "server_capabilities",
          "PASS",
          `Server advertised capabilities: ${capsList.join(", ") || "none"}`,
        );
      } else {
        const errors = ajv.errorsText(validateServerCapabilities.errors);
        addCheck(
          "server_capabilities",
          "FAIL",
          `Server advertised capabilities structure is invalid: ${errors}`,
        );
      }
    } else {
      addCheck("server_capabilities", "WARN", "Server advertised no capabilities.");
    }

    // 4. Tools Capability Auditing
    const hasToolsCap = !!capabilities?.tools;
    try {
      const toolsResult = (await requestWithTimeout("tools/list")) as any;
      if (!hasToolsCap) {
        // Did not advertise tools, but listing tools returned something
        if (toolsResult?.tools && toolsResult.tools.length > 0) {
          addCheck(
            "tools_capability",
            "WARN",
            "Server did not advertise tools capability but returned tools on tools/list.",
          );
        } else {
          addCheck(
            "tools_capability",
            "PASS",
            "Server correctly returned empty or no tools (no capability advertised).",
          );
        }
      } else {
        // Advertised capability, now validate response
        const valid = (validateListToolsResult as any)(toolsResult);
        if (valid) {
          addCheck(
            "tools_capability",
            "PASS",
            `tools/list returned ${toolsResult.tools.length} valid tool(s).`,
          );

          // Audit individual tools
          for (const tool of toolsResult.tools) {
            const toolName = tool.name;
            if (!toolName || typeof toolName !== "string") {
              addCheck(
                "tool_schema_validation",
                "FAIL",
                "Found tool with missing or non-string name.",
              );
              continue;
            }

            if (!tool.description) {
              addCheck(
                "tool_schema_validation",
                "WARN",
                `Tool "${toolName}" is missing a description.`,
              );
            }

            const schema = tool.inputSchema;
            if (!schema || typeof schema !== "object") {
              addCheck(
                "tool_schema_validation",
                "FAIL",
                `Tool "${toolName}" has missing or invalid inputSchema.`,
              );
              continue;
            }

            if (schema.type !== "object") {
              addCheck(
                "tool_schema_validation",
                "WARN",
                `Tool "${toolName}" inputSchema type is "${schema.type}" instead of "object".`,
              );
            }

            // Check that required properties actually exist in properties
            if (Array.isArray(schema.required)) {
              const properties = schema.properties || {};
              for (const reqProp of schema.required) {
                if (!properties[reqProp]) {
                  addCheck(
                    "tool_schema_validation",
                    "FAIL",
                    `Tool "${toolName}" requires property "${reqProp}" but it is not defined under properties.`,
                  );
                }
              }
            }
          }
        } else {
          const errors = ajv.errorsText(validateListToolsResult.errors);
          addCheck(
            "tools_capability",
            "FAIL",
            `tools/list response violated the schema: ${errors}`,
          );
        }
      }
    } catch (err: any) {
      if (hasToolsCap) {
        addCheck(
          "tools_capability",
          "FAIL",
          `Server advertised tools but tools/list failed: ${err.message}`,
        );
      } else {
        // clean failure or method not found is acceptable when not advertised
        addCheck(
          "tools_capability",
          "PASS",
          "tools/list correctly unavailable/ignored (no capability advertised).",
        );
      }
    }

    // 5. Resources Capability Auditing
    const hasResourcesCap = !!capabilities?.resources;
    try {
      const resourcesResult = (await requestWithTimeout("resources/list")) as any;
      if (!hasResourcesCap) {
        if (resourcesResult?.resources && resourcesResult.resources.length > 0) {
          addCheck(
            "resources_capability",
            "WARN",
            "Server did not advertise resources capability but returned resources on resources/list.",
          );
        } else {
          addCheck(
            "resources_capability",
            "PASS",
            "Server correctly returned empty or no resources.",
          );
        }
      } else {
        const valid = (validateListResourcesResult as any)(resourcesResult);
        if (valid) {
          addCheck(
            "resources_capability",
            "PASS",
            `resources/list returned ${resourcesResult.resources.length} valid resource(s).`,
          );

          for (const res of resourcesResult.resources) {
            if (!res.uri || typeof res.uri !== "string") {
              addCheck(
                "resource_validation",
                "FAIL",
                "Found resource with missing or non-string URI.",
              );
            }
            if (!res.name || typeof res.name !== "string") {
              addCheck(
                "resource_validation",
                "WARN",
                `Resource at ${res.uri || "unknown"} is missing a name.`,
              );
            }
          }
        } else {
          const errors = ajv.errorsText(validateListResourcesResult.errors);
          addCheck(
            "resources_capability",
            "FAIL",
            `resources/list response violated the schema: ${errors}`,
          );
        }
      }
    } catch (err: any) {
      if (hasResourcesCap) {
        addCheck(
          "resources_capability",
          "FAIL",
          `Server advertised resources but resources/list failed: ${err.message}`,
        );
      } else {
        addCheck(
          "resources_capability",
          "PASS",
          "resources/list correctly unavailable/ignored (no capability advertised).",
        );
      }
    }

    // 6. Prompts Capability Auditing
    const hasPromptsCap = !!capabilities?.prompts;
    try {
      const promptsResult = (await requestWithTimeout("prompts/list")) as any;
      if (!hasPromptsCap) {
        if (promptsResult?.prompts && promptsResult.prompts.length > 0) {
          addCheck(
            "prompts_capability",
            "WARN",
            "Server did not advertise prompts capability but returned prompts on prompts/list.",
          );
        } else {
          addCheck("prompts_capability", "PASS", "Server correctly returned empty or no prompts.");
        }
      } else {
        const valid = (validateListPromptsResult as any)(promptsResult);
        if (valid) {
          addCheck(
            "prompts_capability",
            "PASS",
            `prompts/list returned ${promptsResult.prompts.length} valid prompt(s).`,
          );

          for (const p of promptsResult.prompts) {
            if (!p.name || typeof p.name !== "string") {
              addCheck(
                "prompt_validation",
                "FAIL",
                "Found prompt with missing or non-string name.",
              );
            }
            if (p.arguments) {
              if (!Array.isArray(p.arguments)) {
                addCheck(
                  "prompt_validation",
                  "FAIL",
                  `Prompt "${p.name}" arguments field is not an array.`,
                );
              } else {
                for (const arg of p.arguments) {
                  if (!arg.name || typeof arg.name !== "string") {
                    addCheck(
                      "prompt_validation",
                      "FAIL",
                      `Prompt "${p.name}" has an argument with missing/non-string name.`,
                    );
                  }
                }
              }
            }
          }
        } else {
          const errors = ajv.errorsText(validateListPromptsResult.errors);
          addCheck(
            "prompts_capability",
            "FAIL",
            `prompts/list response violated the schema: ${errors}`,
          );
        }
      }
    } catch (err: any) {
      if (hasPromptsCap) {
        addCheck(
          "prompts_capability",
          "FAIL",
          `Server advertised prompts but prompts/list failed: ${err.message}`,
        );
      } else {
        addCheck(
          "prompts_capability",
          "PASS",
          "prompts/list correctly unavailable/ignored (no capability advertised).",
        );
      }
    }

    // 7. Stderr Audit
    const stderrLines = target.getStderrLines();
    const stderrChecks = stderrLines.join("\n");
    if (
      stderrChecks.includes("UnhandledPromiseRejectionWarning") ||
      stderrChecks.includes("Unhandled Promise Rejection") ||
      stderrChecks.includes("SyntaxError:") ||
      stderrChecks.includes("ReferenceError:")
    ) {
      addCheck(
        "stderr_warnings",
        "WARN",
        "Detected unhandled promise rejections or runtime error logs in server stderr.",
      );
    } else {
      addCheck("stderr_warnings", "PASS", "No fatal runtime crash logs detected in server stderr.");
    }
  } catch (err: any) {
    addCheck(
      "unexpected_validator_error",
      "FAIL",
      `Validator ran into an unhandled exception: ${err.message}`,
    );
  } finally {
    if (target) {
      await target.close().catch(() => {});
    }
  }

  return finalizeReport(checks);
}

function finalizeReport(checks: ValidationCheck[]): ValidationReport {
  let hasFail = false;
  let hasWarn = false;

  for (const c of checks) {
    if (c.status === "FAIL") hasFail = true;
    if (c.status === "WARN") hasWarn = true;
  }

  const status = hasFail ? "FAIL" : hasWarn ? "WARN" : "PASS";
  return {
    success: !hasFail,
    status,
    checks,
  };
}
