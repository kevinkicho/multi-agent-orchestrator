import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

type CycleOutcome = "success" | "partial" | "failure";

interface SupervisorOpts {
  projectName: string;
  directive: string;
  ollamaUrl: string;
  model: string;
  maxRounds: number;
  maxConsecutiveLlmFailures: number;
  onCycleComplete: (name: string) => void;
  onSupervisorStop: (name: string, isFailure: boolean, reason: string) => void;
  saveCheckpoint: (messages: any[]) => void;
  addMemory: (entry: { type: string; summary: string; cycleHadProgress: boolean }) => void;
  assessProgress: (ctx: any) => any;
  llmCall: () => Promise<{ content: string; usage?: any }>;
}

function createSupervisor(opts: SupervisorOpts) {
  let consecutiveLlmFailures = 0;
  let consecutive429s = 0;
  let consecutiveIdleCycles = 0;
  let cycleHadProgress = false;
  let messages: Array<{ role: string; content: string }> = [];
  let roundsUsed = 0;
  let running = false;

  const failurePattern = /non-responsive|stuck|fail|cannot|unable|broken|crash|unresponsive|dead/i;

  async function startCycle(): Promise<{ started: boolean; messageCount: number }> {
    messages = [{ role: "system", content: opts.directive }];
    consecutiveIdleCycles = 0;
    cycleHadProgress = false;
    roundsUsed = 0;
    running = true;
    return { started: true, messageCount: messages.length };
  }

  async function runLlmRound(userContent: string): Promise<
    | { ok: true; content: string }
    | { ok: false; reason: "rate-limit" | "circuit-breaker" | "llm-failure" }
  > {
    if (!running) {
      // Once the circuit breaker trips, further calls must surface that
      // reason — the test locks this in so a tripped breaker doesn't silently
      // masquerade as a generic llm-failure on subsequent calls.
      if (consecutiveLlmFailures >= opts.maxConsecutiveLlmFailures) {
        return { ok: false, reason: "circuit-breaker" };
      }
      return { ok: false, reason: "llm-failure" };
    }

    messages.push({ role: "user", content: userContent });
    roundsUsed++;

    try {
      const result = await opts.llmCall();
      consecutiveLlmFailures = 0;
      consecutive429s = 0;
      messages.push({ role: "assistant", content: result.content });
      cycleHadProgress = true;
      return { ok: true, content: result.content };
    } catch (err: any) {
      if (err?.status === 429) {
        consecutive429s++;
        return { ok: false, reason: "rate-limit" };
      }
      consecutiveLlmFailures++;
      if (consecutiveLlmFailures >= opts.maxConsecutiveLlmFailures) {
        running = false;
        return { ok: false, reason: "circuit-breaker" };
      }
      return { ok: false, reason: "llm-failure" };
    }
  }

  function completeCycle(): {
    outcome: CycleOutcome;
    content: string;
    roundsUsed: number;
  } {
    const lastMsg = messages[messages.length - 1];
    const text = lastMsg?.content ?? "";

    if (text.startsWith("@done:")) {
      opts.saveCheckpoint(messages);
      opts.addMemory({ type: "completion", summary: text, cycleHadProgress });
      opts.assessProgress({ messages, gitDelta: null, validationPassed: true });
      opts.onCycleComplete(opts.projectName);
      running = false;
      return { outcome: "success", content: text, roundsUsed };
    }

    if (text.startsWith("@stop:")) {
      const isFailure = failurePattern.test(text);
      opts.saveCheckpoint(messages);
      if (isFailure) {
        opts.onSupervisorStop(opts.projectName, true, "worker-failure");
        running = false;
        return { outcome: "failure", content: text, roundsUsed };
      }
      opts.onSupervisorStop(opts.projectName, false, "clean-stop");
      running = false;
      return { outcome: "partial", content: text, roundsUsed };
    }

    if (roundsUsed >= opts.maxRounds) {
      opts.saveCheckpoint(messages);
      opts.onSupervisorStop(opts.projectName, false, "rounds-exhausted");
      running = false;
      return { outcome: "partial", content: "rounds-exhausted", roundsUsed };
    }

    return { outcome: "partial", content: "in-progress", roundsUsed };
  }

  function getState() {
    return {
      running,
      consecutiveLlmFailures,
      consecutive429s,
      consecutiveIdleCycles,
      messageCount: messages.length,
      roundsUsed,
    };
  }

  return { startCycle, runLlmRound, completeCycle, getState };
}

function defaultOpts(overrides?: Partial<SupervisorOpts>): SupervisorOpts {
  return {
    projectName: "test-agent",
    directive: "implement feature X",
    ollamaUrl: "http://localhost:11434",
    model: "test-model",
    maxRounds: 10,
    maxConsecutiveLlmFailures: 5,
    onCycleComplete: mock(() => {}),
    onSupervisorStop: mock(() => {}),
    saveCheckpoint: mock(() => {}),
    addMemory: mock(() => {}),
    assessProgress: mock(() => ({})),
    llmCall: mock(() =>
      Promise.resolve({
        content: "@done: feature implemented",
        usage: { promptTokens: 100, completionTokens: 50 },
      })
    ),
    ...overrides,
  };
}

describe("supervisor lifecycle", () => {
  let opts: SupervisorOpts;

  beforeEach(() => {
    opts = defaultOpts();
  });

  describe("cycle start", () => {
    test("initializes system message from directive", async () => {
      const supervisor = createSupervisor(opts);
      const result = await supervisor.startCycle();

      expect(result.started).toBe(true);
      expect(result.messageCount).toBe(1);
    });

    test("resets rounds counter and idle counter on new cycle", async () => {
      const supervisor = createSupervisor(opts);
      await supervisor.startCycle();

      const state = supervisor.getState();
      expect(state.roundsUsed).toBe(0);
      expect(state.consecutiveIdleCycles).toBe(0);
      expect(state.running).toBe(true);
    });

    test("re-initializing clears previous cycle state", async () => {
      const supervisor = createSupervisor(opts);
      await supervisor.startCycle();
      await supervisor.runLlmRound("do work");

      await supervisor.startCycle();
      expect(supervisor.getState().roundsUsed).toBe(0);
      expect(supervisor.getState().messageCount).toBe(1);
    });
  });

  describe("cycle completion", () => {
    test("@done triggers checkpoint save, memory entry, progress assessment, and onCycleComplete callback", async () => {
      const supervisor = createSupervisor(opts);
      await supervisor.startCycle();
      const llmResult = await supervisor.runLlmRound("implement it");

      expect(llmResult.ok).toBe(true);

      const completion = supervisor.completeCycle();

      expect(completion.outcome).toBe("success");
      expect(opts.saveCheckpoint).toHaveBeenCalled();
      expect(opts.addMemory).toHaveBeenCalledWith(
        expect.objectContaining({ type: "completion", cycleHadProgress: true })
      );
      expect(opts.assessProgress).toHaveBeenCalled();
      expect(opts.onCycleComplete).toHaveBeenCalledWith("test-agent");
    });

    test("@done content is captured in memory summary", async () => {
      opts.llmCall = mock(() =>
        Promise.resolve({ content: "@done: refactored auth module" })
      );
      const supervisor = createSupervisor(opts);
      await supervisor.startCycle();
      await supervisor.runLlmRound("refactor auth");

      const completion = supervisor.completeCycle();

      expect(completion.outcome).toBe("success");
      expect(completion.content).toBe("@done: refactored auth module");
      expect(opts.addMemory).toHaveBeenCalledWith(
        expect.objectContaining({ summary: "@done: refactored auth module" })
      );
    });

    test("clean @stop (no failure language) yields partial outcome with isFailure=false", async () => {
      opts.llmCall = mock(() =>
        Promise.resolve({ content: "@stop: pausing for user review" })
      );
      const supervisor = createSupervisor(opts);
      await supervisor.startCycle();
      await supervisor.runLlmRound("check status");

      const completion = supervisor.completeCycle();

      expect(completion.outcome).toBe("partial");
      expect(opts.onSupervisorStop).toHaveBeenCalledWith(
        "test-agent",
        false,
        "clean-stop"
      );
    });

    test("exhausting max rounds yields partial outcome", async () => {
      opts.maxRounds = 1;
      opts.llmCall = mock(() =>
        Promise.resolve({ content: "still working on it..." })
      );
      const supervisor = createSupervisor(opts);
      await supervisor.startCycle();
      await supervisor.runLlmRound("do work");

      const completion = supervisor.completeCycle();

      expect(completion.outcome).toBe("partial");
      expect(opts.onSupervisorStop).toHaveBeenCalledWith(
        "test-agent",
        false,
        "rounds-exhausted"
      );
    });
  });

  describe("stuck/error escalation", () => {
    test("@stop with failure language triggers onSupervisorStop with isFailure=true", async () => {
      opts.llmCall = mock(() =>
        Promise.resolve({
          content: "@stop: agent is stuck and cannot proceed further",
        })
      );
      const supervisor = createSupervisor(opts);
      await supervisor.startCycle();
      await supervisor.runLlmRound("continue");

      const completion = supervisor.completeCycle();

      expect(completion.outcome).toBe("failure");
      expect(opts.onSupervisorStop).toHaveBeenCalledWith(
        "test-agent",
        true,
        "worker-failure"
      );
    });

    test("circuit breaker trips after maxConsecutiveLlmFailures consecutive LLM failures", async () => {
      const error: any = new Error("connection refused");
      opts.llmCall = mock(() => { throw error; });
      const supervisor = createSupervisor(opts);
      await supervisor.startCycle();

      for (let i = 0; i < 5; i++) {
        const result = await supervisor.runLlmRound("try");
        if (i < 4) {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.reason).toBe("llm-failure");
        }
      }

      const lastResult = await supervisor.runLlmRound("try again");
      expect(lastResult.ok).toBe(false);
      if (!lastResult.ok) expect(lastResult.reason).toBe("circuit-breaker");
      expect(supervisor.getState().consecutiveLlmFailures).toBe(5);
      expect(supervisor.getState().running).toBe(false);
    });

    test("429 errors increment rate-limit counter separately from LLM failure counter", async () => {
      const rateLimitError: any = new Error("rate limited");
      rateLimitError.status = 429;
      opts.llmCall = mock(() => { throw rateLimitError; });
      const supervisor = createSupervisor(opts);
      await supervisor.startCycle();

      const result = await supervisor.runLlmRound("try");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("rate-limit");
      expect(supervisor.getState().consecutive429s).toBe(1);
      expect(supervisor.getState().consecutiveLlmFailures).toBe(0);
    });

    test("single successful LLM call resets both failure and 429 counters", async () => {
      let callCount = 0;
      const rateLimitError: any = new Error("rate limited");
      rateLimitError.status = 429;
      opts.llmCall = mock(() => {
        callCount++;
        if (callCount <= 2) throw rateLimitError;
        return Promise.resolve({ content: "@done: recovered" });
      });
      const supervisor = createSupervisor(opts);
      await supervisor.startCycle();

      await supervisor.runLlmRound("try");
      await supervisor.runLlmRound("try");
      expect(supervisor.getState().consecutive429s).toBe(2);

      await supervisor.runLlmRound("try");
      expect(supervisor.getState().consecutive429s).toBe(0);
      expect(supervisor.getState().consecutiveLlmFailures).toBe(0);
    });

    test("multiple failure-language keywords in @stop all trigger failure outcome", async () => {
      const failureMessages = [
        "@stop: worker is unresponsive",
        "@stop: cannot complete the broken module",
        "@stop: build crash prevented progress",
      ];

      for (const msg of failureMessages) {
        const localOpts = defaultOpts({
          llmCall: mock(() => Promise.resolve({ content: msg })),
        });
        const supervisor = createSupervisor(localOpts);
        await supervisor.startCycle();
        await supervisor.runLlmRound("continue");

        const completion = supervisor.completeCycle();
        expect(completion.outcome).toBe("failure");
        expect(localOpts.onSupervisorStop).toHaveBeenCalledWith(
          "test-agent",
          true,
          "worker-failure"
        );
      }
    });
  });
});
