import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { startPopupPauseGuard } from "../popup-pause-guard.js";

it("resumes waiting popup children and observed pauses without claiming existing tabs", async () => {
  const server = new WebSocketServer({ port: 0 });
  const commands: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> =
    [];
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  let client: WebSocket | undefined;
  server.on("connection", (socket) => {
    client = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      commands.push(message);
      socket.send(
        JSON.stringify({
          id: message.id,
          result:
            message.method === "Target.getTargets"
              ? { targetInfos: [{ targetId: "existing" }] }
              : {},
        }),
      );
    });
  });
  let stop: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    stop = await startPopupPauseGuard(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const emit = (method: string, params: object, sessionId?: string) =>
      client!.send(JSON.stringify({ method, params, sessionId }));
    emit("Target.targetCreated", {
      targetInfo: { targetId: "existing", type: "page", openerId: "old" },
    });
    emit("Target.targetCreated", { targetInfo: { targetId: "ordinary", type: "page" } });
    emit("Target.targetCreated", {
      targetInfo: { targetId: "popup", type: "page", openerId: "ordinary" },
    });
    await vi.waitFor(() =>
      expect(commands.filter((c) => c.method === "Target.attachToTarget")).toEqual([
        expect.objectContaining({ params: { targetId: "popup", flatten: true } }),
      ]),
    );
    emit("Target.attachedToTarget", {
      sessionId: "popup-session",
      targetInfo: { targetId: "popup", type: "page" },
      waitingForDebugger: true,
    });
    await vi.waitFor(() =>
      expect(commands).toContainEqual(
        expect.objectContaining({
          method: "Runtime.runIfWaitingForDebugger",
          sessionId: "popup-session",
        }),
      ),
    );
    emit("Debugger.paused", { reason: "other" }, "popup-session");
    await vi.waitFor(() =>
      expect(commands).toContainEqual(
        expect.objectContaining({ method: "Debugger.resume", sessionId: "popup-session" }),
      ),
    );
    expect(warn).toHaveBeenCalledWith(
      "[popup-pause-guard]",
      expect.stringContaining('"reason":"waitingForDebugger"'),
    );
    expect(warn).toHaveBeenCalledWith(
      "[popup-pause-guard]",
      expect.stringContaining('"reason":"other"'),
    );
    expect(
      commands
        .filter((c) => c.method === "Target.setAutoAttach")
        .every((c) => c.params.waitForDebuggerOnStart === false),
    ).toBe(true);
    emit("Target.detachedFromTarget", { sessionId: "popup-session" });
  } finally {
    stop?.();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    warn.mockRestore();
  }
});
