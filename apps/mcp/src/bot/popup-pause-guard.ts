import { WebSocket } from "ws";

/** Broker guard, not a diagnosis: recover debugger stops on newly created popups. */
export async function startPopupPauseGuard(endpoint: string): Promise<() => void> {
  const url = /^wss?:/.test(endpoint)
    ? endpoint
    : (
        (await (
          await fetch(`${endpoint.replace(/\/$/, "")}/json/version`, {
            signal: AbortSignal.timeout(5000),
          })
        ).json()) as { webSocketDebuggerUrl: string }
      ).webSocketDebuggerUrl;
  const socket = new WebSocket(url);
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: () => void; timer: NodeJS.Timeout }
  >();
  const targets = new Map<string, string>();
  let sequence = 0;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject();
    }
    pending.clear();
    socket.close();
  };
  function send(method: string, params: object = {}, sessionId?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (disposed || socket.readyState !== WebSocket.OPEN)
        return reject(new Error("guard disconnected"));
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("guard command timeout"));
      }, 5000);
      timer.unref();
      pending.set(id, { resolve, reject: () => reject(new Error("guard disconnected")), timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  const known = new Set<string>();
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString());
    if (message.id) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject();
      else item.resolve(message.result);
      return;
    }
    const handle = async (): Promise<void> => {
      if (message.method === "Target.targetCreated") {
        const info = message.params.targetInfo;
        if (known.has(info.targetId)) return;
        known.add(info.targetId);
        if (info.type === "page" && info.openerId)
          await send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
      } else if (message.method === "Target.attachedToTarget") {
        const { sessionId, targetInfo, waitingForDebugger } = message.params;
        targets.set(sessionId, targetInfo.targetId);
        if (waitingForDebugger) {
          console.warn(
            "[popup-pause-guard]",
            JSON.stringify({ target: targetInfo.targetId, reason: "waitingForDebugger" }),
          );
          await send("Runtime.runIfWaitingForDebugger", {}, sessionId);
        }
        if (targetInfo.type === "page" || targetInfo.type === "iframe") {
          // Enabling the domain makes pauses observable. The listener above is
          // already installed and resumes immediately, including debugger traps.
          await send("Debugger.enable", {}, sessionId);
          await send(
            "Target.setAutoAttach",
            { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
            sessionId,
          );
        }
      } else if (message.method === "Debugger.paused" && targets.has(message.sessionId)) {
        console.warn(
          "[popup-pause-guard]",
          JSON.stringify({ target: targets.get(message.sessionId), reason: message.params.reason }),
        );
        await send("Debugger.resume", {}, message.sessionId);
      } else if (message.method === "Target.detachedFromTarget") {
        targets.delete(message.params.sessionId);
      } else if (message.method === "Target.targetDestroyed") {
        known.delete(message.params.targetId);
      }
    };
    void handle().catch(() => {
      if (!disposed) console.warn("[popup-pause-guard] target detached or command failed");
    });
  });
  socket.on("error", dispose);
  socket.on("close", dispose);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("guard connection timeout")), 5000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error("guard connection failed"));
      });
    });
    const existing = (await send("Target.getTargets")) as {
      targetInfos: Array<{ targetId: string }>;
    };
    for (const info of existing.targetInfos) known.add(info.targetId);
    await send("Target.setDiscoverTargets", { discover: true });
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
