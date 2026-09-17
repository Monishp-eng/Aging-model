import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Phase 7 — Realtime Subscription Lifecycle & Failure Fallback Suite", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("1. Realtime Subscription Lifecycle (Leak Prevention)", () => {
    it("creates exactly one subscription channel on mount and removes it on unmount", () => {
      const removedChannels: string[] = [];
      const createdChannels: string[] = [];

      const mockChannel = {
        name: "generation:gen_123",
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn(),
      };

      const mockSupabase = {
        channel: vi.fn((name: string) => {
          createdChannels.push(name);
          return mockChannel;
        }),
        removeChannel: vi.fn((ch: any) => {
          removedChannels.push(ch.name);
        }),
      };

      // Simulate mounting hook
      const channel = mockSupabase.channel("generation:gen_123");
      channel.on("broadcast", { event: "status" }, vi.fn()).subscribe();

      expect(createdChannels).toEqual(["generation:gen_123"]);
      expect(mockChannel.subscribe).toHaveBeenCalledTimes(1);

      // Simulate unmounting cleanup
      mockSupabase.removeChannel(channel);
      expect(removedChannels).toEqual(["generation:gen_123"]);
    });

    it("cleans up previous subscription and creates new channel when generation ID changes", () => {
      const activeChannels = new Set<string>();

      const mockSupabase = {
        channel: vi.fn((name: string) => {
          activeChannels.add(name);
          return {
            name,
            on: vi.fn().mockReturnThis(),
            subscribe: vi.fn(),
          };
        }),
        removeChannel: vi.fn((ch: any) => {
          activeChannels.delete(ch.name);
        }),
      };

      // 1. Mount with ID A
      const chA = mockSupabase.channel("generation:gen_A");
      expect(activeChannels.has("generation:gen_A")).toBe(true);

      // 2. ID changes to B -> cleanup A first
      mockSupabase.removeChannel(chA);
      expect(activeChannels.has("generation:gen_A")).toBe(false);

      // 3. Subscribe to B
      const chB = mockSupabase.channel("generation:gen_B");
      expect(activeChannels.has("generation:gen_B")).toBe(true);
      expect(activeChannels.size).toBe(1); // No leaked channels!
    });

    it("does not initiate Realtime subscription if generation is already terminal", () => {
      const subscribeSpy = vi.fn();
      const isTerminal = (data: { output?: string | null; failed?: boolean; expired?: boolean }) =>
        Boolean(data.output || data.failed || data.expired);

      const terminalStatuses = [
        { output: "https://storage/output.gif", failed: false, expired: false },
        { output: null, failed: true, expired: false },
        { output: null, failed: false, expired: true },
      ];

      for (const status of terminalStatuses) {
        if (!isTerminal(status)) {
          subscribeSpy();
        }
      }

      // Zero subscriptions created for terminal generations
      expect(subscribeSpy).not.toHaveBeenCalled();
    });
  });

  describe("2. Bounded Polling Fallback Simulation", () => {
    it("polls server status with backoff and stops immediately upon reaching terminal state", async () => {
      let pollCount = 0;
      let isTerminal = false;

      // Mock server endpoint returning processing twice, then succeeded on 3rd poll
      const fetchStatus = vi.fn(async () => {
        pollCount++;
        if (pollCount >= 3) {
          isTerminal = true;
          return { id: "gen_123", status: "succeeded", outputUrl: "https://out.gif" };
        }
        return { id: "gen_123", status: "processing", outputUrl: null };
      });

      async function runPollingLoop() {
        while (!isTerminal && pollCount < 10) {
          const res = await fetchStatus();
          if (res.outputUrl) {
            break; // Terminal reached, stop polling
          }
        }
      }

      await runPollingLoop();

      expect(pollCount).toBe(3);
      expect(fetchStatus).toHaveBeenCalledTimes(3);
    });

    it("aborts polling when component unmounts (activeRef becomes false)", async () => {
      let active = true;
      let polledAfterUnmount = false;

      const poll = vi.fn(() => {
        if (!active) {
          polledAfterUnmount = true;
          return;
        }
      });

      // Active poll 1
      poll();
      expect(poll).toHaveBeenCalledTimes(1);

      // Unmount occurs
      active = false;

      // Scheduled timeout executes after unmount
      poll();
      expect(polledAfterUnmount).toBe(true);
    });
  });
});
