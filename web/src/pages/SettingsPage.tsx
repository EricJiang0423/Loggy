import { useState } from 'react';
import type { Theme } from '../App';
import { api } from '../api';
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
      <Card title={t('set.ai')}>
        <p>{server?.aiAvailable ? t('set.aiOn', { model: server.aiModel }) : t('set.aiOff')}</p>
      </Card>
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
