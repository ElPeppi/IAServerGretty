export type Theme = 'light' | 'dark';

export function getTheme(): Theme {
  return (localStorage.getItem('theme') as Theme) || 'light';
}

export function applyTheme(t: Theme): void {
  document.documentElement.classList.toggle('dark', t === 'dark');
  localStorage.setItem('theme', t);
}

/** Llamar una vez al arrancar la app para evitar parpadeo. */
export function initTheme(): void {
  applyTheme(getTheme());
}
