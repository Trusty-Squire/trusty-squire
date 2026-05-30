"use client";

import { OAuthButtons } from "../components/OAuthButtons";
import { useQueryParam } from "../lib/use-query-param";

const ERRORS: Record<string, string> = {
  denied: "Sign-in was cancelled.",
  oauth_failed: "Sign-in didn't complete. Please try again.",
  state_mismatch: "Your sign-in session expired. Please try again.",
};

export default function LoginPage() {
  const errorCode = useQueryParam("error");
  const next = useQueryParam("next") ?? undefined;
  const error =
    errorCode !== null
      ? (ERRORS[errorCode] ?? "Sign-in failed. Please try again.")
      : null;

  return (
    <main className="login">
      {/* left — anchored auth column with a border-right hairline */}
      <section className="auth">
        <div className="glow" />
        {/* refined { } mark — hairline square, mono accent (replaces the
            old shield+text SVG) */}
        <div className="mark">
          <span className="mono">{"{ }"}</span>
        </div>
        <h1>Sign in</h1>
        <p className="subt">Your vault and connected agents, in one place.</p>
        <OAuthButtons next={next} />
        {error !== null && <p className="auth-err">{error}</p>}
        <div className="foot">secured · oauth only · no passwords stored</div>
      </section>

      {/* right — quiet statement over a faint masked grid + glow */}
      <section className="stage" aria-hidden="true">
        <div className="grid" />
        <div className="glow" />
        <div className="statement">
          <div className="lead">
            Your keys, <em>collected by your squire,</em> handled like a tool.
          </div>
          <div className="tag">
            encrypted · used only via the proxy · never shown to an agent
          </div>
        </div>
      </section>
    </main>
  );
}
