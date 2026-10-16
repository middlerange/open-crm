import { AppsIcon as Chrome, ShieldTickIcon as ShieldCheck } from "../components/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button, Spinner } from "../components/ui";
import { ThemeToggle } from "../components/theme-toggle";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

function queryValue(params: URLSearchParams, key: string) {
  return params.get(key)?.trim() ?? "";
}

export function ExtensionAuthorizePage() {
  const { user } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoStarted = useRef(false);
  const request = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      redirectUri: queryValue(params, "redirect_uri"),
      codeChallenge: queryValue(params, "code_challenge"),
      state: queryValue(params, "state"),
      tokenLabel: queryValue(params, "token_label") || "Chrome extension",
      auto: queryValue(params, "auto") === "1",
    };
  }, []);
  const valid = Boolean(request.redirectUri && request.codeChallenge && request.state);

  const authorize = useCallback(async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await api<{ redirectUrl: string }>("/linkedin/authorize", {
        method: "POST",
        body: JSON.stringify({
          redirectUri: request.redirectUri,
          codeChallenge: request.codeChallenge,
          tokenLabel: request.tokenLabel,
        }),
      });
      const redirect = new URL(response.redirectUrl);
      redirect.searchParams.set("state", request.state);
      window.location.assign(redirect);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to connect the extension.");
      setSubmitting(false);
    }
  }, [request, valid]);

  useEffect(() => {
    if (!user || !valid || !request.auto || autoStarted.current) return;
    autoStarted.current = true;
    void authorize();
  }, [authorize, request.auto, user, valid]);

  if (!user) return null;
  if (request.auto && valid && !error)
    return (
      <div className="loading-page extension-auth-loading" role="status">
        <ThemeToggle className="auth-theme-toggle" />
        <Spinner /> Connecting Orbit Lead Collector…
      </div>
    );
  return (
    <div className="extension-auth-page">
      <ThemeToggle className="auth-theme-toggle" />
      <section className="extension-auth-card">
        <div className="extension-auth-icon">
          <Chrome size={24} />
        </div>
        <h1>
          {request.auto ? "Orbit couldn’t finish connecting" : "Connect Orbit Lead Collector?"}
        </h1>
        <p>
          The extension will save the LinkedIn engagement signals you explicitly review to{" "}
          <strong>{user.workspaceName}</strong> as {user.name}.
        </p>
        <div className="extension-auth-permissions">
          <div>
            <ShieldCheck size={16} />
            <span>Save visible reactions, comments, and their source post</span>
          </div>
          <div>
            <ShieldCheck size={16} />
            <span>Read and update only the lead signals owned by your workspace role</span>
          </div>
        </div>
        {error || !valid ? (
          <div className="form-error">
            {error ?? "This extension authorization request is incomplete."}
          </div>
        ) : null}
        {request.auto ? (
          <div className="extension-auth-actions">
            <Button onClick={() => window.location.assign("/")}>Back to Orbit</Button>
            <Button
              variant="primary"
              disabled={!valid || submitting}
              onClick={() => void authorize()}
            >
              {submitting ? "Retrying…" : "Retry connection"}
            </Button>
          </div>
        ) : (
          <div className="extension-auth-actions">
            <Button
              onClick={() => {
                window.close();
                window.setTimeout(() => window.location.assign("/"), 150);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!valid || submitting}
              onClick={() => void authorize()}
            >
              {submitting ? (
                <>
                  <Spinner /> Connecting
                </>
              ) : (
                "Connect extension"
              )}
            </Button>
          </div>
        )}
        <small>
          The extension never receives your password or Orbit session cookie. You can revoke it from
          Social leads at any time.
        </small>
      </section>
    </div>
  );
}
