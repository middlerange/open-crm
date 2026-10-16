export type Role = "founder" | "manager" | "ic";

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
};

export type AppVariables = {
  user: SessionUser;
  extensionTokenId: string;
  agent: {
    workspaceId: string;
    label: string;
    scopes: string[];
    userId: string;
    role: Role;
    userName: string;
    userEmail: string;
  };
};

export type AppBindings = {
  MAILER?: import("./mail-provider.js").MailBinding;
  ASSETS?: {
    fetch(request: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
};

export type AppEnv = {
  Bindings: AppBindings;
  Variables: AppVariables;
};
