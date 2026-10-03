import { useCallback, useEffect, useMemo, useState } from 'react';
import { UsageMeters } from './components/UsageMeters';
import { I18nContext, detectLang, translate, useI18n, type Key, type Lang } from './i18n';
import { EfficiencyPage } from './pages/EfficiencyPage';
import { InstructionsPage } from './pages/InstructionsPage';
import { SessionsPage } from './pages/SessionsPage';
import { SettingsPage } from './pages/SettingsPage';
import { startSync, useStore } from './store';

export type Page = 'sessions' | 'efficiency' | 'instructions' | 'settings';
export type Theme = 'system' | 'light' | 'dark';

interface Route {
  page: Page;
  id?: string;
}

function parseHash(): Route {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [page, ...rest] = h.split('/');
  const p = (['sessions', 'efficiency', 'instructions', 'settings'] as Page[]).includes(page as Page) ? (page as Page) : 'sessions';
  return { page: p, id: rest.length ? rest.join('/') : undefined };
}

function load<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
}

export function App() {
  const [lang, setLang] = useState<Lang>(detectLang);
  const [theme, setTheme] = useState<Theme>(() => load<Theme>('loggy.theme', 'system'));
  const [route, setRoute] = useState<Route>(parseHash);
  const [query, setQuery] = useState('');

  useEffect(() => startSync(), []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.resolvedTheme = resolved;
      document.documentElement.dataset.theme = theme;
      window.dispatchEvent(new Event('loggy-theme'));
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const i18n = useMemo(() => ({ lang, t: (k: Key, v?: Record<string, string | number>) => translate(lang, k, v) }), [lang]);

  const navigate = useCallback((page: Page, id?: string) => {
    const hash = `#/${page}${id ? `/${encodeURIComponent(id)}` : ''}`;
    if (location.hash !== hash) history.pushState(null, '', hash);
    setRoute({ page, id });
  }, []);

  const changeLang = (l: Lang) => {
    setLang(l);
    save('loggy.lang', l);
  };
  const changeTheme = (t: Theme) => {
    setTheme(t);
    save('loggy.theme', t);
  };

  return (
    <I18nContext.Provider value={i18n}>
      <div className="app">
        <TopBar page={route.page} navigate={navigate} query={query} setQuery={setQuery} lang={lang} setLang={changeLang} />
        <Offline />
        {route.page === 'sessions' && <SessionsPage selectedId={route.id} onSelect={(id) => navigate('sessions', id)} query={query} />}
        {route.page === 'efficiency' && <EfficiencyPage onOpen={(id) => navigate('sessions', id)} />}
        {route.page === 'instructions' && <InstructionsPage />}
        {route.page === 'settings' && <SettingsPage lang={lang} setLang={changeLang} theme={theme} setTheme={changeTheme} />}
      </div>
    </I18nContext.Provider>
  );
}

function Offline() {
  const online = useStore((s) => s.online);
  const { t } = useI18n();
  if (online) return null;
  return <div className="offline">{t('common.offline')}</div>;
}

interface TopBarProps {
  page: Page;
  navigate: (p: Page) => void;
  query: string;
  setQuery: (q: string) => void;
  lang: Lang;
  setLang: (l: Lang) => void;
}

function TopBar({ page, navigate, query, setQuery, lang, setLang }: TopBarProps) {
  const t = (k: Key, v?: Record<string, string | number>) => translate(lang, k, v);
  const progress = useStore((s) => s.progress);
  const count = useStore((s) => s.sessions.size);
  const demo = useStore((s) => s.server?.demo);
  const tab = (p: Page, k: Key) => (
    <button className={`tab ${page === p ? 'active' : ''}`} onClick={() => navigate(p)} aria-current={page === p ? 'page' : undefined}>
      {t(k)}
    </button>
  );
  const parsing = progress && progress.phase !== 'ready' && progress.phase !== 'idle';
  return (
    <header className="topbar">
      <div className="brand">
        <img src="./favicon.svg" alt="" />
        {t('app.name')}
        {demo && <span className="badge">{t('index.demo')}</span>}
      </div>
      <nav className="navgroups" aria-label="main">
        <div className="navgroup">
          <span className="navgroup-label">{t('nav.view')}</span>
          {tab('sessions', 'nav.sessions')}
          {tab('efficiency', 'nav.efficiency')}
        </div>
        <div className="navgroup">
          <span className="navgroup-label">{t('nav.dev')}</span>
          {tab('instructions', 'nav.instructions')}
          {tab('settings', 'nav.settings')}
        </div>
      </nav>
      <div className="spacer" />
      <div className="indexing" title={progress?.lastDurationMs ? `${progress.lastDurationMs} ms` : undefined}>
        {parsing ? (
          <>
            <span className="spinner" />
            {t('index.parsing', { done: progress!.filesDone, total: progress!.filesTotal })}
          </>
        ) : (
          t('index.ready', { n: count })
        )}
      </div>
      <UsageMeters onSetup={() => navigate('settings')} />
      <div className="search">
        <input
          type="search"
          value={query}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          onChange={(e) => {
            setQuery(e.target.value);
            if (page !== 'sessions') navigate('sessions');
          }}
        />
        {query && (
          <button className="clear" onClick={() => setQuery('')} aria-label={t('search.clear')}>
            ×
          </button>
        )}
      </div>
      <div className="seg" role="group" aria-label={t('set.language')}>
        <button className={lang === 'zh-CN' ? 'on' : ''} onClick={() => setLang('zh-CN')}>
          中
        </button>
        <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>
          EN
        </button>
      </div>
    </header>
  );
}
