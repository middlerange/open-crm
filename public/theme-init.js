(() => {
  const storageKey = "orbit-theme";
  let storedTheme = null;
  try {
    storedTheme = window.localStorage.getItem(storageKey);
  } catch {
    storedTheme = null;
  }
  const theme =
    storedTheme === "dark" || storedTheme === "light"
      ? storedTheme
      : window.matchMedia?.("(prefers-color-scheme: dark)")?.matches
        ? "dark"
        : "light";
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0d0d0d" : "#fcfcfc");
})();
