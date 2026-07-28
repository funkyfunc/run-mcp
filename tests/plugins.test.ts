import { describe, it, expect } from "vitest";
import { ResponseInterceptor } from "../src/interceptor.js";
import { mockTarget } from "./helpers.js";
import { compressText, outputCompressionPlugin, type InterceptorPlugin } from "../src/plugins.js";

describe("compressText", () => {
  it("minifies pretty-printed JSON losslessly", () => {
    const pretty = JSON.stringify({ a: 1, b: [2, 3], c: "x" }, null, 2);
    const { text, savedChars } = compressText(pretty);
    expect(savedChars).toBeGreaterThan(0);
    // Parsed value is identical (lossless).
    expect(JSON.parse(text)).toEqual(JSON.parse(pretty));
    // Result is the minified form.
    expect(text).toBe(JSON.stringify({ a: 1, b: [2, 3], c: "x" }));
  });

  it("inflation guard: already-minified JSON and plain text are unchanged", () => {
    const minified = JSON.stringify({ a: 1 });
    expect(compressText(minified).savedChars).toBe(0);
    expect(compressText(minified).text).toBe(minified);

    const plain = "just some plain text with no slack";
    expect(compressText(plain).savedChars).toBe(0);
    expect(compressText(plain).text).toBe(plain);
  });

  it("does not touch non-JSON prose by default (byte-perfect)", () => {
    const code = "const x = 1;\n\n\n  trailing   \nend";
    expect(compressText(code).text).toBe(code);
  });

  it("aggressive mode collapses blank lines and trailing whitespace", () => {
    const messy = "line1   \n\n\n\nline2\t\nline3";
    const { text, savedChars } = compressText(messy, { aggressive: true });
    expect(savedChars).toBeGreaterThan(0);
    expect(text).toBe("line1\n\nline2\nline3");
  });
});

describe("outputCompressionPlugin", () => {
  it("compresses a JSON tool result and reports savings", async () => {
    const interceptor = new ResponseInterceptor({ plugins: [outputCompressionPlugin()] });
    const pretty = JSON.stringify({ hello: "world", nums: [1, 2, 3] }, null, 2);
    const target = mockTarget({ content: [{ type: "text", text: pretty }] });

    const { result, metadata } = await interceptor.callToolWithMetadata(target, "data", {});
    const out = (result as any).content[0].text;
    expect(out.length).toBeLessThan(pretty.length);
    expect(JSON.parse(out)).toEqual(JSON.parse(pretty));
    expect(metadata.findings.some((f) => f.plugin === "output-compression")).toBe(true);
  });

  it("leaves a non-JSON result untouched by default", async () => {
    const interceptor = new ResponseInterceptor({ plugins: [outputCompressionPlugin()] });
    const text = "plain result, nothing to compress";
    const target = mockTarget({ content: [{ type: "text", text }] });
    const { result } = await interceptor.callToolWithMetadata(target, "x", {});
    expect((result as any).content[0].text).toBe(text);
  });
});

describe("interceptor plugin pipeline", () => {
  it("processToolList runs registered plugins in order", async () => {
    const suffixer = (tag: string): InterceptorPlugin => ({
      name: `suffix-${tag}`,
      onToolsList(tools, report) {
        for (const tool of tools) tool.name = `${tool.name}-${tag}`;
        report({ plugin: `suffix-${tag}`, severity: "info", message: "ran" });
        return tools;
      },
    });
    const interceptor = new ResponseInterceptor({ plugins: [suffixer("a"), suffixer("b")] });
    const { tools, findings } = await interceptor.processToolList([{ name: "x" }]);
    // Second plugin sees the first plugin's output.
    expect(tools[0].name).toBe("x-a-b");
    expect(findings.map((f) => f.plugin)).toEqual(["suffix-a", "suffix-b"]);
  });

  it("runs onToolResult hooks over a tool call result", async () => {
    const redactor: InterceptorPlugin = {
      name: "test-redactor",
      onToolResult(result, ctx) {
        const content = (result as any).content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === "text") item.text = item.text.replace(/secret/g, "[REDACTED]");
          }
        }
        ctx.report({ plugin: "test-redactor", severity: "info", message: "ran" });
        return result;
      },
    };
    const interceptor = new ResponseInterceptor({ plugins: [redactor] });
    const target = mockTarget({ content: [{ type: "text", text: "my secret token" }] });

    const { result, metadata } = await interceptor.callToolWithMetadata(target, "echo", {});
    expect((result as any).content[0].text).toBe("my [REDACTED] token");
    expect(metadata.findings.some((f) => f.plugin === "test-redactor")).toBe(true);
  });

  it("is a no-op when no plugins are registered", async () => {
    const interceptor = new ResponseInterceptor();
    const { tools, findings } = await interceptor.processToolList([{ name: "a" }]);
    expect(tools).toEqual([{ name: "a" }]);
    expect(findings).toEqual([]);
  });
});
