import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Badge, Button, Field, Input, PasswordInput, Spinner } from "../components/ui";
import { BrandMark, PRODUCT_NAME } from "../components/brand";
import { ThemeToggle } from "../components/theme-toggle";
import { api, roleLabel } from "../lib/api";
import { useAuth } from "../lib/auth";

type Invite = {
  invite: {
    email: string;
    role: string;
    workspaceName: string;
    expiresAt: string;
    existingAccount: boolean;
  };
};

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [invite, setInvite] = useState<Invite["invite"] | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    if (!token) {
      setError("The invitation link is incomplete.");
      return;
    }
    api<Invite>(`/auth/invite/${encodeURIComponent(token)}`)
      .then((response) => setInvite(response.invite))
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : "Unable to load invitation."),
      );
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api("/auth/invite/accept", {
        method: "POST",
        body: JSON.stringify({
          token,
          ...(invite?.existingAccount ? { password: password || undefined } : { name, password }),
        }),
      });
      window.location.assign("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to accept invitation.");
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
          <h2>Join {PRODUCT_NAME}</h2>
          <p>
            {invite ? (
              <>
                You’ve been invited to <strong>{invite.workspaceName}</strong> as{" "}
                <Badge tone={invite.role === "manager" ? "purple" : "blue"}>
                  {roleLabel(invite.role)}
                </Badge>
                .
              </>
            ) : (
              "Checking your invitation…"
            )}
          </p>
          {error ? (
            <div className="form-error" role="alert">
              {error}
            </div>
          ) : null}
          {!invite && !error ? <Spinner /> : null}
          {invite ? (
            <>
              <Field label="Email">
                <Input value={invite.email} readOnly />
              </Field>
              {invite.existingAccount ? (
                user?.email.toLowerCase() === invite.email.toLowerCase() ? (
                  <p className="invite-auth-note">
                    Signed in as <strong>{user.email}</strong>. Accepting adds this team to your
                    existing account.
                  </p>
                ) : (
                  <Field label="Current password" hint="Use the password for the invited email.">
                    <PasswordInput
                      required
                      autoFocus
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </Field>
                )
              ) : (
                <>
                  <Field label="Your name">
                    <Input
                      required
                      autoFocus
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Full name"
                    />
                  </Field>
                  <Field label="Create password" hint="Use at least 12 characters.">
                    <PasswordInput
                      required
                      minLength={12}
                      autoComplete="new-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </Field>
                </>
              )}
              <Button variant="primary" type="submit" disabled={submitting}>
                {submitting ? (
                  <>
                    <Spinner /> Joining
                  </>
                ) : invite.existingAccount ? (
                  "Join team"
                ) : (
                  "Create account"
                )}
              </Button>
            </>
          ) : null}
          <div className="auth-back-link">
            <Link to="/login">Back to sign in</Link>
          </div>
        </form>
      </section>
    </div>
  );
}
