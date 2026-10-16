import userorbit from "userorbit-js";

import type { CurrentUser } from "./auth";

let identityKey: string | null = null;
let initialized = false;
let pending = Promise.resolve();

export function syncUserorbit(user: CurrentUser | null): void {
  const nextKey = user
    ? JSON.stringify([
        user.id,
        user.email,
        user.name,
        user.role,
        user.workspaceId,
        user.workspaceName,
      ])
    : null;
  if (nextKey === identityKey) return;
  identityKey = nextKey;

  pending = pending
    .then(async () => {
      if (initialized) {
        await userorbit.logout();
        initialized = false;
      }
      if (!user || window.location.pathname === "/accept-invite") return;
      const response = await fetch("/api/public-config");
      if (!response.ok) throw new Error("Unable to load widget configuration.");
      const { userorbit: widget } = (await response.json()) as {
        userorbit: { accountId: string; apiHost: string } | null;
      };
      if (!widget) return;
      const config = {
        accountId: widget.accountId,
        apiHost: widget.apiHost,
        floatingWidget: true,
        userId: user.id,
        email: user.email,
        name: user.name,
        attributes: {
          "user.role": user.role,
          "user.company": user.workspaceName,
          "workspace.id": user.workspaceId,
        },
        openOptions: {
          activeTabs: ["home", "feedback", "roadmap", "updates", "help"],
        },
      };
      await userorbit.init(config);
      if (!window.userorbit) throw new Error("Userorbit runtime did not load.");
      initialized = true;
      // The package loader returns before core init; this waits for the runtime queue.
      await userorbit.registerRouteChange();
    })
    .catch(() => {
      identityKey = null;
      console.warn("Userorbit could not be initialized.");
    });
}
