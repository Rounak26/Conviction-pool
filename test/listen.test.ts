import { describe, expect, it } from "vitest";
import { listenAddress } from "../src/listen.js";

describe("listenAddress", () => {
  it("defaults to localhost:5173 for local development", () => {
    expect(listenAddress({})).toEqual({ host: "127.0.0.1", port: 5173 });
  });

  it("binds 0.0.0.0 on Render's PORT", () => {
    expect(listenAddress({ RENDER: "true", PORT: "10000" })).toEqual({ host: "0.0.0.0", port: 10000 });
  });

  it("uses PORT locally without exposing the server", () => {
    expect(listenAddress({ PORT: "8080" })).toEqual({ host: "127.0.0.1", port: 8080 });
  });

  it("lets HOST override the default", () => {
    expect(listenAddress({ HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(listenAddress({ RENDER: "true", HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
  });

  it("falls back to 5173 for an empty or invalid PORT", () => {
    expect(listenAddress({ PORT: "" }).port).toBe(5173);
    expect(listenAddress({ PORT: "abc" }).port).toBe(5173);
  });
});
