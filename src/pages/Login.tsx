import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { Button, Field, Input, PasswordInput, Spinner } from "../components/ui";
import { BrandMark, PRODUCT_NAME } from "../components/brand";
import { ThemeToggle } from "../components/theme-toggle";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

export function LoginPage() {
  const { user, loading, refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const requestedDestination =
    (location.state as { from?: string } | null)?.from ??
    new URLSearchParams(location.search).get("return_to") ??
    undefined;
  const destination =
    requestedDestination?.startsWith("/") && !requestedDestination.startsWith("//")
      ? requestedDestination
      : "/";
  const isBrowserAuthorization = destination.startsWith("/api/linkedin/authorize-browser?");

  useEffect(() => {
    if (user && isBrowserAuthorization) window.location.replace(destination);
  }, [destination, isBrowserAuthorization, user]);

  if (loading)
    return (
      <div className="loading-page">
        <Spinner />
      </div>
    );
  if (user) {
    return isBrowserAuthorization ? (
      <div className="loading-page">
        <Spinner />
      </div>
    ) : (
      <Navigate to={destination} replace />
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      await refresh();
      if (isBrowserAuthorization) window.location.assign(destination);
      else navigate(destination, { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to sign in.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <ThemeToggle className="auth-theme-toggle" />
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <div className="auth-form-brand">
            <BrandMark />
            <span>{PRODUCT_NAME}</span>
          </div>
          <h2>{isBrowserAuthorization ? "Connect the Orbit extension" : "Welcome back"}</h2>
          <p>
            {isBrowserAuthorization
              ? "Sign in to continue the extension connection."
              : "Sign in to your workspace."}
          </p>
          {error ? (
            <div className="form-error" role="alert">
              {error}
            </div>
          ) : null}
          <Field label="Work email">
            <Input
              type="email"
              autoComplete="email"
              autoFocus
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
          </Field>
          <Field label="Password">
            <PasswordInput
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Your password"
            />
          </Field>
          <Button variant="primary" type="submit" disabled={submitting}>
            {submitting ? (
              <>
                <Spinner /> Signing in
              </>
            ) : (
              "Sign in"
            )}
          </Button>
        </form>
      </section>
    </div>
  );
}
