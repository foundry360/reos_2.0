import { THEME_COOKIE } from "@/lib/theme";

/** Runs before paint to avoid theme flash. Reads the theme cookie set by the server. */
export function ThemeScript() {
  const script = `
(function () {
  var isLogin = /^\\/login(\\/|$)/.test(window.location.pathname);
  if (isLogin) {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.colorScheme = 'light';
    return;
  }
  var m = document.cookie.match(/${THEME_COOKIE}=([^;]+)/);
  var pref = m ? m[1] : 'system';
  var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  var resolved = pref === 'system' ? (dark ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
})();
`;

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
