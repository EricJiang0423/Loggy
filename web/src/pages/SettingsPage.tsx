import { useState } from 'react';
import type { Theme } from '../App';
import { api, type AiForm } from '../api';
import { Card, CopyButton, Seg } from '../components/common';
import { duration, int } from '../format';
import { useI18n, type Lang } from '../i18n';
import { refreshServer, refreshSessions, useStore } from '../store';

const STATUSLINE = `{
  "statusLine": {
    "type": "command",
    "command": "loggy statusline"
  }
}`;

const GROUPS = ['smart', 'repo', 'git', 'folder'] as const;

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function SettingsPage({ lang, setLang, theme, setTheme }: { lang: Lang; setLang: (l: Lang) => void; theme: Theme; setTheme: (t: Theme) => void }) {
  const { t } = useI18n();
  const server = useStore((s) => s.server);
  const progress = useStore((s) => s.progress);
  const count = useStore((s) => s.sessions.size);
  const [busy, setBusy] = useState(false);
  const statusline = STATUSLINE;

  const rescan = async (full: boolean) => {
    setBusy(true);
    try {
      await api.rescan(full);
      await refreshServer();
      await refreshSessions();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings">
      <Card title={t('set.language')}>
        <Seg
          value={lang}
          onChange={setLang}
          options={[
            { value: 'zh-CN', label: '简体中文' },
            { value: 'en', label: 'English' },
          ]}
        />
      </Card>
      <Card title={t('set.theme')}>
        <Seg
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'system', label: t('set.theme.system') },
            { value: 'light', label: t('set.theme.light') },
            { value: 'dark', label: t('set.theme.dark') },
          ]}
        />
      </Card>
      <Card title={t('set.groupBy')}>
        <Seg
          value={server?.groupBy ?? 'smart'}
          onChange={async (g) => {
            await api.setGroupBy(g);
            await refreshServer();
            await refreshSessions();
          }}
          options={GROUPS.map((g) => ({ value: g, label: t(`set.groupBy.${g}`) }))}
        />
        <p className="muted" style={{ fontSize: 12 }}>
          {t(`set.groupBy.${server?.groupBy ?? 'smart'}Help`)}
        </p>
      </Card>
      <Card title={t('set.sources')}>
        <table className="grid">
          <thead>
            <tr>
              <th />
              <th>{t('set.dir')}</th>
              <th className="r">{t('set.files')}</th>
              <th className="r">{t('set.size')}</th>
            </tr>
          </thead>
          <tbody>
            {server?.sources.map((s) => (
              <tr key={s.dir}>
                <td>{t(s.agent === 'claude' ? 'agent.claude' : 'agent.codex')}</td>
                <td className="mono">
                  {s.dir} {!s.exists && <span className="err">({t('set.missing')})</span>}
                </td>
                <td className="r">{int(s.files, lang)}</td>
                <td className="r">{size(s.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title={t('set.index')}>
        <p>{t('set.indexInfo', { n: int(count, lang), s: progress?.lastDurationMs !== undefined ? duration(Math.max(1000, progress.lastDurationMs), lang) : '–' })}</p>
        <p className="mono" style={{ fontSize: 11 }}>
          {t('set.cache')}: {server?.cacheFile}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" disabled={busy} onClick={() => rescan(false)}>
            {t('set.rescan')}
          </button>
          <button className="btn" disabled={busy} onClick={() => rescan(true)} title={t('set.rebuildHint')}>
            {t('set.rebuild')}
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          {t('set.rebuildHint')}
        </p>
      </Card>
      <Card title={t('set.claudeUsage')}>
        <p>{t('set.claudeUsageText')}</p>
        <pre className="snippet">{statusline}</pre>
        <CopyButton text={statusline} label={t('set.copy')} />
      </Card>
      <Card title={t('set.ai')}>{server && <AiSettings />}</Card>
      <Card title={t('set.pricing')}>
        <p>{t('set.pricingText')}</p>
      </Card>
      <Card title={t('set.privacy')}>
        <p>{t('set.privacyText')}</p>
        <p className="muted">{t('set.version', { v: server?.version ?? '' })}</p>
      </Card>
    </div>
  );
}

function headersText(h: Record<string, string>): string {
  return Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function AiSettings() {
  const { t } = useI18n();
  const server = useStore((s) => s.server)!;
  const saved = server.ai;
  const [form, setForm] = useState<AiForm>({ ...saved });
  const [headers, setHeaders] = useState(headersText(saved.headers));
  const [key, setKey] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof AiForm>(k: K, v: AiForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const body = (): AiForm => ({ ...form, headers: parseHeaders(headers), apiKey: key });
  const run = async (what: 'save' | 'test') => {
    setBusy(true);
    setResult(what === 'test' ? { ok: true, text: t('set.ai.testing') } : null);
    try {
      if (what === 'save') {
        await api.saveAi(body());
        setKey(undefined);
        setResult({ ok: true, text: t('set.ai.saved') });
        await refreshServer();
      } else {
        const r = await api.testAi(body());
        setResult(r.ok ? { ok: true, text: `${t('set.ai.ok', { model: r.model, ms: r.ms })}${r.reply ? ` · “${r.reply}”` : ''}` } : { ok: false, text: t('set.ai.fail', { msg: r.error ?? '' }) });
      }
    } catch (err) {
      setResult({ ok: false, text: t('set.ai.fail', { msg: (err as Error).message }) });
    } finally {
      setBusy(false);
    }
  };
  const openai = form.provider === 'openai';
  return (
    <>
      <p className="muted">
        {server.aiAvailable ? t('set.ai.inUse', { model: server.aiModel, source: t(saved.source === 'env' ? 'set.ai.src.env' : 'set.ai.src.settings') }) : t('set.ai.notInUse')}
      </p>
      <div className="form">
        <span />
        <label className="chk">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          {t('set.ai.enabled')}
        </label>
        <span className="lbl">{t('set.ai.format')}</span>
        <Seg
          value={form.provider}
          onChange={(v) => set('provider', v)}
          options={[
            { value: 'anthropic', label: t('set.ai.anthropic') },
            { value: 'openai', label: t('set.ai.openai') },
          ]}
        />
        <span className="lbl">{t('set.ai.baseURL')}</span>
        <input className="input" value={form.baseURL} onChange={(e) => set('baseURL', e.target.value)} placeholder={openai ? 'https://llm.example.com/v1' : 'https://api.anthropic.com'} spellCheck={false} />
        <span />
        <span className="hint-text">{t(openai ? 'set.ai.baseURLOpenAI' : 'set.ai.baseURLAnthropic')}</span>
        <span className="lbl">{t('set.ai.model')}</span>
        <input className="input" value={form.model} onChange={(e) => set('model', e.target.value)} placeholder={server.aiModel} spellCheck={false} />
        <span className="lbl">{t('set.ai.key')}</span>
        <div className="row-inline">
          <input
            className="input"
            type="password"
            autoComplete="off"
            value={key ?? ''}
            onChange={(e) => setKey(e.target.value)}
            placeholder={saved.hasKey && key === undefined ? t('set.ai.keySaved') : 'sk-…'}
          />
          {saved.hasKey && key === undefined && (
            <button className="btn ghost" onClick={() => setKey('')}>
              {t('set.ai.keyClear')}
            </button>
          )}
        </div>
        <span className="lbl">{t('set.ai.keyEnv')}</span>
        <input className="input" value={form.apiKeyEnv} onChange={(e) => set('apiKeyEnv', e.target.value)} placeholder={t('set.ai.keyEnvHint')} spellCheck={false} />
        {!openai && (
          <>
            <span className="lbl">{t('set.ai.auth')}</span>
            <Seg
              value={form.auth}
              onChange={(v) => set('auth', v)}
              options={[
                { value: 'x-api-key', label: 'x-api-key' },
                { value: 'bearer', label: 'Authorization: Bearer' },
              ]}
            />
          </>
        )}
        <span className="lbl">{t('set.ai.headers')}</span>
        <textarea className="input mono" rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder={t('set.ai.headersHint')} spellCheck={false} />
        <span />
        <div className="row-inline">
          <button className="btn primary" disabled={busy} onClick={() => void run('save')}>
            {t('set.ai.save')}
          </button>
          <button className="btn" disabled={busy} onClick={() => void run('test')}>
            {t('set.ai.test')}
          </button>
          {result && <span className={result.ok ? 'add' : 'err'}>{result.text}</span>}
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        {t('set.ai.privacy')}
      </p>
    </>
  );
}
