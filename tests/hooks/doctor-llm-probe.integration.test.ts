import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

/**
 * Production-boundary test for doctor section 12 (issue #24, codex turn-1
 * finding 4 / CR-3): drives the REAL `clawmem doctor` CLI as a subprocess
 * against live local fixture endpoints, so deleting the probe, its issues++
 * wiring, or its outcome branches reds this file — a unit test on the probe
 * function alone cannot see the doctor wiring.
 *
 * The scratch INDEX_PATH keeps the run off any real vault; the embed/rerank
 * URLs point at an unreachable local port so those sections degrade to their
 * non-fatal could-not-probe paths quickly.
 */

const BIN = resolve(import.meta.dir, "../../bin/clawmem");

let workDir: string;
let okServer: ReturnType<typeof Bun.serve>;
let squatServer: ReturnType<typeof Bun.serve>;
let wrongShapeServer: ReturnType<typeof Bun.serve>;
let deadPort: number;

beforeAll(() => {
  workDir = mkdtempSync(resolve(tmpdir(), "clawmem-doctor-probe-"));
  okServer = Bun.serve({
    port: 0,
    fetch: () => Response.json({ choices: [{ message: { content: "OK" } }], model: "fixture-ok" }),
  });
  // The issue's own repro shape: a service that answers HTTP but 501s the POST.
  squatServer = Bun.serve({
    port: 0,
    fetch: () => new Response("Unsupported method ('POST')", { status: 501 }),
  });
  wrongShapeServer = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: true }),
  });
  const tmp = Bun.serve({ port: 0, fetch: () => new Response("x") });
  deadPort = tmp.port!;
  tmp.stop(true);
});

afterAll(() => {
  okServer?.stop(true);
  squatServer?.stop(true);
  wrongShapeServer?.stop(true);
  rmSync(workDir, { recursive: true, force: true });
});

// Bun.spawn (async), NOT Bun.spawnSync: the fixture servers live in THIS test
// process, and spawnSync blocks the event loop while the child runs — the
// subprocess's probe would time out against fixtures that can never answer.
async function runDoctor(llmUrl: string): Promise<string> {
  const proc = Bun.spawn([BIN, "doctor"], {
    env: {
      ...process.env,
      INDEX_PATH: resolve(workDir, "scratch.sqlite"),
      CLAWMEM_LLM_URL: llmUrl,
      // Keep the other inference sections on their fast non-fatal paths.
      CLAWMEM_EMBED_URL: `http://127.0.0.1:${deadPort}`,
      CLAWMEM_RERANK_URL: `http://127.0.0.1:${deadPort}`,
      CLAWMEM_NO_LOCAL_MODELS: "true",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return out + err;
}

describe("doctor LLM endpoint shape probe (production boundary)", () => {
  it("reports a squatted port (non-2xx) as red NOT-serving, contributing to issues", async () => {
    const out = await runDoctor(`http://127.0.0.1:${squatServer.port}`);
    const line = out.split("\n").find(l => l.includes("LLM endpoint:"));
    expect(line).toBeDefined();
    expect(line!).toContain("✗");
    expect(line!).toContain("HTTP 501");
    expect(line!).toContain("NOT serving chat completions");
    // The red line must flow into doctor's failure state, not just print.
    expect(out).toContain("issue(s) found");
  }, 60000);

  it("reports a proper endpoint as green with the served model name", async () => {
    const out = await runDoctor(`http://127.0.0.1:${okServer.port}`);
    const line = out.split("\n").find(l => l.includes("LLM endpoint:"));
    expect(line).toBeDefined();
    expect(line!).toContain("✓");
    expect(line!).toContain("serves chat completions");
    expect(line!).toContain("fixture-ok");
  }, 60000);

  it("reports a 200-but-wrong-shape body as red with the shape detail", async () => {
    const out = await runDoctor(`http://127.0.0.1:${wrongShapeServer.port}`);
    const line = out.split("\n").find(l => l.includes("LLM endpoint:"));
    expect(line).toBeDefined();
    expect(line!).toContain("✗");
    expect(line!).toContain("not a chat-completions response");
  }, 60000);
});
