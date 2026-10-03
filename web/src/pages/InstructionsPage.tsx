import { useEffect, useMemo, useState } from 'react';
import type { InstructionsInfo } from '../../../src/shared/types';
import { api } from '../api';
import { Seg } from '../components/common';
import { dateTime, shortPath } from '../format';
import { useI18n } from '../i18n';
import { useStore } from '../store';

type Info = InstructionsInfo & { globals: { path: string; exists: boolean }[] };

function DiffView({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <pre className="code">
      {lines.map((l, i) => {
        const cls = l.startsWith('+') && !l.startsWith('+++') ? 'a' : l.startsWith('-') && !l.startsWith('---') ? 'r' : l.startsWith('@@') ? 'h' : '';
        return cls ? (
          <span key={i} className={cls}>
            {l}
          </span>
        ) : (
          <span key={i}>
            {l}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

export function InstructionsPage() {
  const { t, lang } = useI18n();
  const list = useStore((s) => s.list);
  const projects = useMemo(() => {
    const m = new Map<string, { path: string; name: string; last: number }>();
    for (const s of list) {
      if (!s.projectPath) continue;
      const p = m.get(s.projectPath) ?? { path: s.projectPath, name: s.project, last: 0 };
      p.last = Math.max(p.last, s.end);
      m.set(s.projectPath, p);
    }
    return [...m.values()].sort((a, b) => b.last - a.last);
  }, [list]);
  const [project, setProject] = useState('');
  const current = project || projects[0]?.path || '';
  const [info, setInfo] = useState<Info | undefined>();
  const [err, setErr] = useState<string | undefined>();
  const [file, setFile] = useState('');
  const [global, setGlobal] = useState<string | undefined>();
  const [sha, setSha] = useState<string | undefined>();
  const [mode, setMode] = useState<'diff' | 'content'>('diff');
  const [view, setView] = useState<{ content: string; diff: string } | undefined>();

  useEffect(() => {
    if (!current) return;
    setInfo(undefined);
    setErr(undefined);
    setSha(undefined);
    setGlobal(undefined);
    api
      .instructions(current)
      .then((i) => {
        setInfo(i);
        setFile(i.files[0]?.path ?? '');
        setSha(i.files[0]?.versions[0]?.sha);
      })
      .catch((e) => setErr(e.message));
  }, [current]);

  useEffect(() => {
    if (!current || (!file && !global)) {
      setView(undefined);
      return;
    }
    setView(undefined);
    const p = global ? api.instructionVersion(current, global, undefined, true) : api.instructionVersion(current, file, sha);
    p.then(setView).catch((e) => setErr(e.message));
  }, [current, file, sha, global]);

  const f = info?.files.find((x) => x.path === file);
  const sessionsDuring = (i: number) => {
    if (!f) return 0;
    const start = f.versions[i].ts;
    const end = i > 0 ? f.versions[i - 1].ts : Infinity;
    return list.filter((s) => s.projectPath === current && !s.isSubagent && s.start >= start && s.start < end).length;
  };
  const maxChange = Math.max(1, ...(f?.versions.map((v) => v.added + v.removed) ?? [1]));

  if (!projects.length) return <div className="empty-state">{t('ins.noProjects')}</div>;

  return (
    <div className="page">
      <div className="toolbar">
        <b>{t('ins.title')}</b>
        <select className="sel" value={current} onChange={(e) => setProject(e.target.value)} aria-label={t('ins.project')}>
          {projects.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name} — {shortPath(p.path)}
            </option>
          ))}
        </select>
        {info?.files.map((x) => (
          <button key={x.path} className={`pill ${!global && file === x.path ? 'on' : ''}`} onClick={() => (setGlobal(undefined), setFile(x.path), setSha(x.versions[0]?.sha))}>
            {x.path} <span className="count">{x.versions.length}</span>
          </button>
        ))}
        <span className="spacer" />
        {info?.globals.map((g) => (
          <button
            key={g.path}
            className={`pill ${global === g.path ? 'on' : ''}`}
            disabled={!g.exists}
            title={g.exists ? g.path : `${g.path} (${t('ins.missing')})`}
            onClick={() => setGlobal(g.path)}
          >
            {t('ins.global')}: {shortPath(g.path)}
          </button>
        ))}
      </div>
      {err && <div className="err" style={{ padding: 12 }}>{err}</div>}
      {info && !info.files.length && !global ? (
        <div className="empty-state">{t('ins.noFiles')}</div>
      ) : (
        <div className="ins">
          <div className="pane">
            <div className="pane-body">
              {!global && f && (
                <>
                  <div className={`ver ${!sha ? 'sel' : ''}`} onClick={() => setSha(undefined)}>
                    <div className="subj">{t('ins.working')}</div>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {f.exists ? f.path : t('ins.missing')}
                    </div>
                  </div>
                  {!info?.isGit && <div className="muted" style={{ padding: 12 }}>{t('ins.notGit')}</div>}
                  {f.versions.map((v, i) => (
                    <div key={v.sha} className={`ver ${sha === v.sha ? 'sel' : ''}`} onClick={() => setSha(v.sha)}>
                      <div className="subj" title={v.subject}>
                        {v.subject}
                      </div>
                      <div className="muted num" style={{ fontSize: 11, display: 'flex', gap: 8 }}>
                        <span>{dateTime(v.ts, lang)}</span>
                        <span className="chip">{v.sha.slice(0, 7)}</span>
                        <span className="add">+{v.added}</span>
                        <span className="del">−{v.removed}</span>
                      </div>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {t('ins.sessionsDuring', { n: sessionsDuring(i) })}
                      </div>
                      <div className="heat" style={{ width: `${Math.max(3, ((v.added + v.removed) / maxChange) * 100)}%` }} />
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
          <div className="pane">
            <div className="toolbar">
              <b className="mono">{global ? shortPath(global) : `${file}${sha ? ` @ ${sha.slice(0, 7)}` : ''}`}</b>
              <span className="spacer" />
              {!global && (
                <Seg
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'diff', label: t('ins.diff') },
                    { value: 'content', label: t('ins.content') },
                  ]}
                />
              )}
            </div>
            <div className="pane-body">
              {!view ? (
                <div className="empty-state">{t('common.loading')}</div>
              ) : global || mode === 'content' || (!sha && !view.diff) ? (
                <pre className="code">{view.content || t('ins.missing')}</pre>
              ) : view.diff ? (
                <DiffView text={view.diff} />
              ) : (
                <div className="empty-state">{t('ins.pick')}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
