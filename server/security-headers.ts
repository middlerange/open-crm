type WidgetEnvironment = {
  USERORBIT_ACCOUNT_ID?: string;
  USERORBIT_API_HOST?: string;
};

export function contentSecurityPolicy(environment: WidgetEnvironment): string {
  const widgetEnabled = Boolean(environment.USERORBIT_ACCOUNT_ID);
  const scriptSources = ["'self'"];
  const connectSources = ["'self'"];
  if (widgetEnabled) {
    scriptSources.push(
      "https://cdn.userorbit.com",
      "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js",
    );
    connectSources.push(
      new URL(environment.USERORBIT_API_HOST || "https://api.userorbit.com").origin,
    );
  }
  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    `connect-src ${connectSources.join(" ")}`,
    "font-src 'self' data:",
    "frame-ancestors 'self'",
  ].join("; ");
}
