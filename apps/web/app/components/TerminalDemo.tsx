"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./Reveal";

type Line = { kind: "sq" | "ok"; text: string; chip?: string };
type Scene = { prompt: string; lines: Line[] };

const SCENES: Scene[] = [
  {
    prompt: "set me up with Resend for transactional email",
    lines: [
      { kind: "sq", text: "creating account · resend.com" },
      { kind: "ok", text: "email verified — no inbox detour" },
      { kind: "ok", text: "key minted, scoped send-only", chip: "RESEND_API_KEY" },
      { kind: "sq", text: "wired into your env — keep building." },
    ],
  },
  {
    prompt: "I need a Redis cache — get me on Upstash",
    lines: [
      { kind: "sq", text: "creating account · upstash.com" },
      { kind: "ok", text: "database provisioned · region iad-1" },
      { kind: "ok", text: "credentials sealed away", chip: "UPSTASH_REDIS_URL" },
      { kind: "sq", text: "connected — your cache is live." },
    ],
  },
  {
    prompt: "wire up Stripe so I can take payments",
    lines: [
      { kind: "sq", text: "creating account · stripe.com" },
      { kind: "ok", text: "restricted key minted, test + live" },
      { kind: "ok", text: "sealed in your keychain", chip: "STRIPE_SECRET_KEY" },
      { kind: "sq", text: "ready — checkout in three lines." },
    ],
  },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function TerminalDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const sceneRef = useRef(0);
  const reduce = usePrefersReducedMotion();
  const [shown, setShown] = useState(false);
  const [inView, setInView] = useState(false);
  const [scene, setScene] = useState(0);
  const [typed, setTyped] = useState("");
  const [lines, setLines] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setShown(true);
        setInView(entry.isIntersecting);
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (reduce || !inView) return;
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        const i = sceneRef.current;
        const sc = SCENES[i];
        setScene(i);
        setTyped("");
        setLines(0);
        await sleep(440);
        for (let c = 1; c <= sc.prompt.length && !cancelled; c++) {
          setTyped(sc.prompt.slice(0, c));
          await sleep(30);
        }
        await sleep(340);
        for (let l = 1; l <= sc.lines.length && !cancelled; l++) {
          setLines(l);
          await sleep(520);
        }
        await sleep(2500);
        sceneRef.current = (i + 1) % SCENES.length;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reduce, inView]);

  const sc = SCENES[scene];
  const typedText = reduce ? sc.prompt : typed;
  const ghost = sc.prompt.slice(typedText.length);
  const typing = !reduce && typedText.length < sc.prompt.length;
  const visible = reduce ? sc.lines.length : lines;

  return (
    <div className={`panel demo${shown ? " in" : ""}`} ref={ref}>
      <div className="panel-bar">
        <span className="dot" style={{ background: "#ff5f57" }} />
        <span className="dot" style={{ background: "#febc2e" }} />
        <span className="dot" style={{ background: "#28c840" }} />
        <span className="t">claude code — trusty-squire</span>
      </div>
      <div className="panel-body">
        {/* Prompt: typed text + transparent ghost of the rest, so the line
            occupies its final size from the first frame (no reflow). */}
        <div className="ln">
          <span className="g">›</span>
          <span className="lc usr">
            {typedText}
            {typing && <span className="tcaret" />}
            <span className="ghost">{ghost}</span>
          </span>
        </div>
        {/* All output lines are always in the DOM — height is reserved up
            front; revealing only toggles opacity. */}
        {sc.lines.map((ln, idx) => {
          const show = reduce || idx < visible;
          return (
            <div
              className={`ln tline${show ? " show" : ""}`}
              key={`${scene}-${idx}`}
            >
              <span className="g"> </span>
              <span className="lc">
                {ln.kind === "sq" ? (
                  <>
                    <span className="sq">squire</span>
                    <span className="cmt">&nbsp;&nbsp;{ln.text}</span>
                  </>
                ) : (
                  <>
                    <span className="ok">&nbsp;&nbsp;✓</span>
                    <span className="cmt">
                      &nbsp;{ln.text}
                      {ln.chip ? " · " : ""}
                    </span>
                    {ln.chip && <span className="key">{ln.chip}</span>}
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
