// The one-time move of GitHub subscriptions out of the Subscriptions plugin.
// These tests use real SQLite files: the legacy database is written where that
// plugin keeps it, and the plugin is loaded against a fake BB host whose
// `bb.server.experimental_dataDir` points at the same directory.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { afterEach, expect, it } from 'vitest';
import plugin, { canonicalPullRequestUrl } from '../server';
import { importLegacyGithubSubscriptions } from './subscriptions';

type Host = ReturnType<typeof createFakePluginHost>;
type LegacyRow = {
  thread: string;
  platform: 'github' | 'linear';
  id: string;
  snapshot?: string | null;
  error?: string | null;
  checked?: number | null;
};

const hosts: Host[] = [];
const dataDirs: string[] = [];

/** bb's data directory for one test, with nowhere for the legacy plugin to live yet. */
function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-pr-legacy-'));
  dataDirs.push(dir);
  return dir;
}

function legacyPath(dataDir: string): string {
  return join(dataDir, 'plugins', 'subscriptions', 'data.db');
}

/** The Subscriptions plugin's schema, as it was when GitHub was its job. */
function writeLegacyDatabase(dataDir: string, rows: LegacyRow[]): void {
  mkdirSync(dirname(legacyPath(dataDir)), { recursive: true });
  const db = new Database(legacyPath(dataDir));
  db.exec(
    'CREATE TABLE subscriptions (thread TEXT NOT NULL, platform TEXT NOT NULL, id TEXT NOT NULL, snapshot TEXT, error TEXT, checked INTEGER, due INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, generation TEXT NOT NULL, PRIMARY KEY(thread, platform, id))',
  );
  const insert = db.prepare(
    'INSERT INTO subscriptions (thread, platform, id, snapshot, error, checked, generation) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    insert.run(row.thread, row.platform, row.id, row.snapshot ?? null, row.error ?? null, row.checked ?? null, 'legacy');
  }
  db.close();
}

/** Load the plugin; the factory is where the import runs. */
async function load(dataDir: string): Promise<Host> {
  const host = createFakePluginHost({ pluginId: 'pull-requests', dataDir });
  await plugin(host.bb);
  hosts.push(host);
  return host;
}

type StoredRow = { thread: string; url: string; snapshot: string | null; error: string | null; checked: number | null };

function storedRows(host: Host): StoredRow[] {
  return host.bb.storage
    .database()
    .prepare('SELECT thread, url, snapshot, error, checked FROM subscriptions ORDER BY url')
    .all() as StoredRow[];
}

function importAgain(host: Host, dataDir: string) {
  return importLegacyGithubSubscriptions(host.bb.storage.database(), { dataDir, canonicalUrl: canonicalPullRequestUrl });
}

const snapshot = {
  title: 'Example',
  url: 'https://github.com/o/r/pull/1',
  state: 'open',
  updatedAt: '2026-01-01T00:00:00Z',
  fields: { checks: 'pending' },
};

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("adopts a disabled legacy plugin's GitHub rows without calling it", async () => {
  const dataDir = makeDataDir();
  writeLegacyDatabase(dataDir, [
    { thread: 'thr_1', platform: 'github', id: 'O/R#7', snapshot: JSON.stringify(snapshot), checked: 1234 },
    { thread: 'thr_1', platform: 'linear', id: 'ENG-1', snapshot: null },
    { thread: 'thr_1', platform: 'github', id: 'not-a-pull-request', snapshot: null },
  ]);

  const host = await load(dataDir);

  const rows = storedRows(host);
  expect(rows.map((row) => [row.thread, row.url, row.checked])).toEqual([
    ['thr_1', 'https://github.com/O/R/pull/7', 1234],
  ]);
  expect(JSON.parse(rows[0]!.snapshot ?? 'null')).toEqual(snapshot);
  // The old plugin is not asked to do anything: it may be disabled or gone.
  expect(host.harness.inspection.sdk.callsTo('plugins.callRpc')).toHaveLength(0);
});

it('leaves the legacy database untouched', async () => {
  const dataDir = makeDataDir();
  writeLegacyDatabase(dataDir, [{ thread: 'thr_1', platform: 'github', id: 'o/r#1', snapshot: null }]);
  await load(dataDir);

  const legacy = new Database(legacyPath(dataDir), { readonly: true, fileMustExist: true });
  try {
    expect(legacy.prepare('SELECT thread, platform, id FROM subscriptions').all()).toEqual([
      { thread: 'thr_1', platform: 'github', id: 'o/r#1' },
    ]);
  } finally {
    legacy.close();
  }
});

it('does nothing when the legacy plugin never wrote a database', async () => {
  const host = await load(makeDataDir());
  expect(storedRows(host)).toEqual([]);
});

it('is idempotent across restarts', async () => {
  const dataDir = makeDataDir();
  writeLegacyDatabase(dataDir, [{ thread: 'thr_1', platform: 'github', id: 'o/r#1', checked: 10 }]);
  const host = await load(dataDir);
  expect(storedRows(host)).toHaveLength(1);

  // A restart re-runs the import against the same file.
  expect(importAgain(host, dataDir)).toEqual({ imported: 0, threads: [] });
  expect(storedRows(host)).toHaveLength(1);
});

it('never resurrects a subscription the user removed here', async () => {
  const dataDir = makeDataDir();
  writeLegacyDatabase(dataDir, [{ thread: 'thr_1', platform: 'github', id: 'o/r#1' }]);
  const host = await load(dataDir);
  host.bb.storage.database().prepare('DELETE FROM subscriptions WHERE thread = ?').run('thr_1');

  expect(importAgain(host, dataDir).imported).toBe(0);
  expect(storedRows(host)).toEqual([]);
});

it('does not overwrite a subscription this thread already has', async () => {
  const dataDir = makeDataDir();
  writeLegacyDatabase(dataDir, [
    { thread: 'thr_1', platform: 'github', id: 'o/r#1', snapshot: JSON.stringify({ ...snapshot, title: 'Legacy' }) },
  ]);
  const host = await load(dataDir);
  const own = { ...snapshot, title: 'Mine' };
  host.bb.storage
    .database()
    .prepare('UPDATE subscriptions SET snapshot = ?, checked = 999 WHERE thread = ?')
    .run(JSON.stringify(own), 'thr_1');
  host.bb.storage.database().prepare('DELETE FROM legacy_import').run();

  expect(importAgain(host, dataDir).imported).toBe(0);
  const rows = storedRows(host);
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0]!.snapshot ?? 'null').title).toBe('Mine');
  expect(rows[0]!.checked).toBe(999);
});

it('falls back to a fresh baseline when the legacy snapshot is unreadable', async () => {
  const dataDir = makeDataDir();
  writeLegacyDatabase(dataDir, [
    { thread: 'thr_1', platform: 'github', id: 'o/r#1', snapshot: '{not json' },
    { thread: 'thr_2', platform: 'github', id: 'o/r#2', snapshot: JSON.stringify({ title: 'wrong shape' }) },
  ]);
  const host = await load(dataDir);

  expect(storedRows(host).map((row) => [row.thread, row.snapshot])).toEqual([
    ['thr_1', null],
    ['thr_2', null],
  ]);
});
