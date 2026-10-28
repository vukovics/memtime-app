import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const DEMO_URL = "https://interview-api.memtime-demo.deno.net/api/v1";

describe("loadConfig", () => {
  it("throws an error naming API_KEY when API_KEY is missing", () => {
    expect(() => loadConfig({})).toThrow(/API_KEY/);
  });

  it("throws an error naming API_KEY when API_KEY is empty", () => {
    expect(() => loadConfig({ API_KEY: "" })).toThrow(/API_KEY/);
  });

  it("applies defaults for PORT and UPSTREAM_BASE_URL", () => {
    const config = loadConfig({ API_KEY: "secret" });
    expect(config.apiKey).toBe("secret");
    expect(config.port).toBe(3000);
    expect(config.upstreamBaseUrl).toBe(DEMO_URL);
  });

  it("respects an explicit PORT", () => {
    const config = loadConfig({ API_KEY: "secret", PORT: "8080" });
    expect(config.port).toBe(8080);
  });

  it.each(["abc", "0", "65536"])(
    "throws an error naming PORT for invalid PORT %s",
    (port) => {
      expect(() => loadConfig({ API_KEY: "secret", PORT: port })).toThrow(
        /PORT/,
      );
    },
  );

  it("respects an explicit UPSTREAM_BASE_URL", () => {
    const config = loadConfig({
      API_KEY: "secret",
      UPSTREAM_BASE_URL: "https://example.com/api",
    });
    expect(config.upstreamBaseUrl).toBe("https://example.com/api");
  });
});
