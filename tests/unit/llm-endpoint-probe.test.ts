import { describe, it, expect, afterAll } from "bun:test";

/**
 * LlamaCpp.probeChatCompletionsShape (issue #24, codex turn-1 findings 3+4):
 * the doctor's LLM-shape probe, tested against REAL local fixture servers so
 * the classification taxonomy (ok / http / shape / transport) is pinned by
 * live HTTP, not by a mocked fetch. The no-think and model/apiKey pass-through
 * assertions read the request body the fixture actually received.
 */

import { LlamaCpp } from "../../src/llm.ts";

type Recorded = { body: any; auth: string | null };

function fixtureServer(handler: (req: Request, recorded: Recorded[]) => Response | Promise<Response>) {
  const recorded: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const auth = req.headers.get("authorization");
      let body: any = null;
      try { body = await req.json(); } catch { /* non-JSON request — not expected */ }
      recorded.push({ body, auth });
      return handler(req, recorded);
    },
  });
  return { server, recorded, url: `http://127.0.0.1:${server.port}` };
}

const servers: { stop: () => void }[] = [];
afterAll(() => { for (const s of servers) s.stop(); });

describe("probeChatCompletionsShape", () => {
  it("classifies a proper chat-completions response as ok and reports the model", async () => {
    const fx = fixtureServer(() =>
      Response.json({ choices: [{ message: { content: "OK" } }], model: "fixture-model" })
    );
    servers.push(fx.server);

    const r = await LlamaCpp.probeChatCompletionsShape({ url: fx.url });
    expect(r).toEqual({ status: "ok", model: "fixture-model" });
    // Default request shape: qwen3 default model, no-think suffix on by default.
    expect(fx.recorded[0]?.body?.model).toBe("qwen3");
    expect(String(fx.recorded[0]?.body?.messages?.[0]?.content)).toContain("/no_think");
    expect(fx.recorded[0]?.auth).toBeNull();
  });

  it("classifies non-2xx as http with the status (the squatted-port signature)", async () => {
    const fx = fixtureServer(() => new Response("Unsupported method ('POST')", { status: 501 }));
    servers.push(fx.server);

    const r = await LlamaCpp.probeChatCompletionsShape({ url: fx.url });
    expect(r).toEqual({ status: "http", httpStatus: 501 });
  });

  it("classifies 200 with an empty choices array as shape (choices:[] proves nothing)", async () => {
    const fx = fixtureServer(() => Response.json({ choices: [] }));
    servers.push(fx.server);

    const r = await LlamaCpp.probeChatCompletionsShape({ url: fx.url });
    expect(r.status).toBe("shape");
    if (r.status === "shape") expect(r.detail).toContain("choices");
  });

  it("classifies 200 with a non-string message.content as shape", async () => {
    const fx = fixtureServer(() => Response.json({ choices: [{ message: { content: 123 } }] }));
    servers.push(fx.server);

    const r = await LlamaCpp.probeChatCompletionsShape({ url: fx.url });
    expect(r.status).toBe("shape");
    if (r.status === "shape") expect(r.detail).toContain("content");
  });

  it("classifies 200 with a non-JSON body as shape (a squatter serving HTML)", async () => {
    const fx = fixtureServer(() => new Response("<html>hi</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    servers.push(fx.server);

    const r = await LlamaCpp.probeChatCompletionsShape({ url: fx.url });
    expect(r.status).toBe("shape");
  });

  it("classifies an unreachable endpoint as transport", async () => {
    // Grab a port that is genuinely free by binding and immediately stopping.
    const tmp = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const deadUrl = `http://127.0.0.1:${tmp.port}`;
    tmp.stop(true);

    const r = await LlamaCpp.probeChatCompletionsShape({ url: deadUrl, timeoutMs: 3000 });
    expect(r.status).toBe("transport");
  });

  it("honors noThink=false (no Qwen control token) and passes model + apiKey through", async () => {
    const fx = fixtureServer(() =>
      Response.json({ choices: [{ message: { content: "OK" } }], model: "m" })
    );
    servers.push(fx.server);

    const r = await LlamaCpp.probeChatCompletionsShape({
      url: fx.url,
      apiKey: "test-key",
      model: "custom-model",
      noThink: false,
    });
    expect(r.status).toBe("ok");
    const req = fx.recorded[0]!;
    expect(String(req.body?.messages?.[0]?.content)).not.toContain("/no_think");
    expect(req.body?.model).toBe("custom-model");
    expect(req.auth).toBe("Bearer test-key");
  });
});
