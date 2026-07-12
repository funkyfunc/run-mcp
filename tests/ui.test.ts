import { describe, it, expect } from "vitest";
import { sanitizeServerText, stripAnsi } from "../src/repl/ui.js";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

describe("sanitizeServerText (terminal escape injection defense)", () => {
  it("leaves ordinary text untouched", () => {
    expect(sanitizeServerText("hello world")).toBe("hello world");
  });

  it("keeps newlines and tabs", () => {
    expect(sanitizeServerText("a\nb\tc")).toBe("a\nb\tc");
  });

  it("strips SGR color sequences", () => {
    expect(sanitizeServerText(`${ESC}[31mred${ESC}[0m`)).toBe("red");
  });

  it("strips cursor / screen manipulation (CSI) sequences", () => {
    expect(sanitizeServerText(`${ESC}[2J${ESC}[Hpwned`)).toBe("pwned");
  });

  it("strips an OSC 52 clipboard-hijack sequence", () => {
    const attack = `before${ESC}]52;c;ZXZpbA==${BEL}after`;
    expect(sanitizeServerText(attack)).toBe("beforeafter");
  });

  it("strips OSC terminated by ST (ESC backslash)", () => {
    const attack = `x${ESC}]0;title${ESC}\\y`;
    expect(sanitizeServerText(attack)).toBe("xy");
  });

  it("removes stray control chars (BEL, NUL, DEL) but not printable text", () => {
    const s = `a${BEL}b${String.fromCharCode(0x00)}c${String.fromCharCode(0x7f)}d`;
    expect(sanitizeServerText(s)).toBe("abcd");
  });
});

describe("stripAnsi (display-width helper)", () => {
  it("removes multi-parameter SGR without eating surrounding text", () => {
    expect(stripAnsi(`${ESC}[1;31;40mX${ESC}[0m`)).toBe("X");
  });
});
