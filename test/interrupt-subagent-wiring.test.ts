/**
 * interrupt-subagent-wiring.test.ts — the interrupt_subagent path.
 *
 * Interrupt is abort with the record kept addressable: the run's abort signal
 * fires, the record lands on "interrupted" (never overwritten by the settling
 * run), the session survives for `resume`, and the caller — who ordered the
 * stop and reads its outcome in the tool result — gets no second notification.
 *
 * The plain rejections (unknown id, non-running status) are single-line guards
 * whose failure is immediately visible in the tool's own reply; only the
 * not-running one is covered, because it is what makes a queued agent
 * un-interruptible (no session to come back to).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, makePi, textOf } from "./helpers/boot-extension.js";

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
    ...overrides,
  } as any;
}

/**
 * A runAgent that creates its session at once and settles only when the abort
 * signal it was given fires — the shape of a real run under `session.abort()`,
 * which resolves (not rejects) with whatever text it had produced so far.
 */
function abortableRun(partialText = "half done") {
  const session = fakeSession();
  vi.mocked(runAgent).mockImplementation(
    (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise((resolve) => {
        opts.onSessionCreated?.(session);
        opts.signal?.addEventListener("abort", () => {
          resolve({ responseText: partialText, session, aborted: false, steered: false });
        }, { once: true });
      }) as any,
  );
  return session;
}

async function spawnBackground(tools: Map<string, any>): Promise<string> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "interrupt wiring agent", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

const interrupt = (tools: Map<string, any>, agent_id: string) =>
  tools.get("interrupt_subagent").execute("tc-int", { agent_id }, undefined, undefined, ctx());

describe("interrupt_subagent", () => {
  it("registers beside the other subagent tools", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    expect(tools.has("interrupt_subagent")).toBe(true);
  });

  it("fires the run's abort signal, lands on 'interrupted', and keeps the session", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const session = abortableRun("half done");

    const id = await spawnBackground(tools);
    await flush();

    const result = await interrupt(tools, id);
    const text = textOf(result);
    expect(text).toContain(`Interrupted agent ${id}`);
    expect(text).toContain("half done");
    expect(text).toContain("resume");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:interrupted", { id });

    // The settling run must not flip the status back to "completed", and the
    // session must still be there to resume.
    const r = await tools.get("get_subagent_result").execute("tc-get", { agent_id: id }, undefined, undefined, ctx());
    const status = textOf(r);
    expect(status).toContain("interrupted");
    expect(status).not.toContain("completed");
    expect(session.dispose).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.();
  });

  it("does not raise a completion notification for a stop the caller ordered", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    abortableRun();

    const id = await spawnBackground(tools);
    await flush();
    await interrupt(tools, id);
    await flush();

    expect(pi.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-notification" }),
      expect.anything(),
    );

    await lifecycle.get("session_shutdown")?.();
  });

  it("can be resumed afterwards", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    abortableRun();

    const id = await spawnBackground(tools);
    await flush();
    await interrupt(tools, id);

    vi.mocked(resumeAgent).mockResolvedValue({ text: "carried on" } as any);
    const r = await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "continue", description: "resume", resume: id, run_in_background: false },
      undefined,
      undefined,
      ctx(),
    );
    // Background by default: the acceptance line is the proof the interrupted
    // record was resumable at all ("still running" or "no active session"
    // would have been refused above); the runner call proves it was started.
    expect(textOf(r)).toContain("resumed");
    await flush();
    expect(resumeAgent).toHaveBeenCalledWith(expect.anything(), "continue", expect.anything());

    await lifecycle.get("session_shutdown")?.();
  });

  it("refuses an agent that is not running", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    abortableRun();

    const id = await spawnBackground(tools);
    await flush();
    await interrupt(tools, id);

    const again = await interrupt(tools, id);
    expect(textOf(again)).toContain("is not running");
    expect(textOf(again)).toContain("interrupted");

    await lifecycle.get("session_shutdown")?.();
  });

  it("returns after the settle timeout when the run ignores its abort signal", async () => {
    vi.useFakeTimers();
    try {
      const { pi, tools, lifecycle } = makePi();
      subagentsExtension(pi);
      // Session exists, but the run never settles.
      vi.mocked(runAgent).mockImplementation(
        (_ctx: any, _type: any, _prompt: any, opts: any) =>
          new Promise(() => { opts.onSessionCreated?.(fakeSession()); }) as any,
      );

      const id = await spawnBackground(tools);
      await vi.advanceTimersByTimeAsync(0);

      const pending = interrupt(tools, id);
      await vi.advanceTimersByTimeAsync(10_000);
      const text = textOf(await pending);
      expect(text).toContain("has not settled");

      await lifecycle.get("session_shutdown")?.();
    } finally {
      vi.useRealTimers();
    }
  });
});
