import { MoonIcon, SunIcon } from "./icons";

import { useTheme } from "../lib/theme";
import { Button, cx } from "./ui";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  const nextTheme = isDark ? "light" : "dark";

  return (
    <Button
      className={cx("theme-toggle", className)}
      variant="plain"
      size="icon"
      type="button"
      aria-label={`Switch to ${nextTheme} mode`}
      aria-pressed={isDark}
      title={`Switch to ${nextTheme} mode`}
      onClick={toggleTheme}
    >
      <span className={cx("theme-toggle-icon", !isDark && "is-active")} aria-hidden="true">
        <SunIcon size={17} />
      </span>
      <span className={cx("theme-toggle-icon", isDark && "is-active")} aria-hidden="true">
        <MoonIcon size={17} />
      </span>
    </Button>
  );
}
