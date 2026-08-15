import { describe, expect, it } from "vitest";
import { errorMessage, sanitizeMessage } from "../src/sanitize.js";

describe("log sanitization", () => {
  it("removes RPC credentials in URL paths and query strings", () => {
    const input = "URL: https://rpc.example/v2/SUPERSECRET?key=ALSOSECRET\nRequest failed";
    const output = sanitizeMessage(input);
    expect(output).not.toContain("SUPERSECRET");
    expect(output).not.toContain("ALSOSECRET");
    expect(output).toContain("[redacted-url]");
  });

  it("sanitizes Error messages", () => {
    expect(errorMessage(new Error("POST http://localhost:8545/rpc-secret failed"))).toBe(
      "POST [redacted-url] failed",
    );
  });
});
