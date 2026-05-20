"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./Reveal";

const KEYS = [
  { name: "STRIPE_SECRET_KEY", val: "sk_live_4eC39HqLyjWDarjtT1zd" },
  { name: "OPENAI_API_KEY", val: "sk-proj-V8s2Lx9Qm4Rt7Wz1Hb6Nd" },
  { name: "RESEND_API_KEY", val: "re_8Hk2Lm9Pq4Rs7Tv1Wx3Yz5Ab" },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const dots = (n: number) => "•".repeat(Math.max(0, n));

export function SecretsDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = usePrefersReducedMotion();
  const [inView, setInView] = useState(false);
  const [sealed, setSealed] = useState(0);
  const [sealing, setSealing] = useState(-1);
  const [maskN, setMaskN] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (reduce || !inView) return;
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        for (let k = 0; k < KEYS.length && !cancelled; k++) {
          setSealing(k);
          setMaskN(0);
          const len = KEYS[k].val.length;
          for (let n = 2; n <= len && !cancelled; n += 2) {
            setMaskN(n);
            await sleep(32);
          }
          if (cancelled) break;
          setMaskN(len);
          setSealing(-1);
          setSealed(k + 1);
          await sleep(440);
        }
        if (cancelled) break;
        await sleep(2300);
        setSealed(0);
        setSealing(-1);
        setMaskN(0);
        await sleep(780);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reduce, inView]);

  return (
    <div className="fvis se" ref={ref}>
      {KEYS.map((k, i) => {
        let state: "exposed" | "sealing" | "sealed";
        let value: string;
        if (reduce || i < sealed) {
          state = "sealed";
          value = dots(k.val.length);
        } else if (i === sealing) {
          state = "sealing";
          value = dots(maskN) + k.val.slice(maskN);
        } else {
          state = "exposed";
          value = k.val;
        }
        return (
          <div className={`se-row ${state}`} key={k.name}>
            <div className="se-top">
              <span className="se-name">{k.name}</span>
              <span className="se-tag">
                {state === "sealed"
                  ? "⚷ sealed · enclave"
                  : state === "sealing"
                    ? "sealing…"
                    : "⚠ exposed"}
              </span>
            </div>
            <div className="se-val">{value}</div>
          </div>
        );
      })}
    </div>
  );
}
