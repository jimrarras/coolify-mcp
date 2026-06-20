import { describe, it, expect } from "vitest";
import * as server from "./server.js";

describe("server module", () => {
  it("exports main for the CLI dispatcher", () => {
    expect(typeof (server as { main?: unknown }).main).toBe("function");
  });
});
