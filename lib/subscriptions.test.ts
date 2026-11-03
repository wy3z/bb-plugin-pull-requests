import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { afterEach, expect, it } from 'vitest';
import plugin from '../server';

type Host = ReturnType<typeof createFakePluginHost>;

const hosts: Host[] = [];
const dataDirs: string[] = [];

async function load(): Promise<Host> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bb-pr-subscriptions-'));
  dataDirs.push(dataDir);
  const host = createFakePluginHost({ pluginId: 'pull-requests', dataDir });
  await plugin(host.bb);
  hosts.push(host);
  return host;
}

function storedUrls(host: Host, threadId = 'thr_1'): string[] {
  const rows = host.bb.storage
    .database()
    .prepare('SELECT url FROM subscriptions WHERE thread = ? ORDER BY url')
    .all(threadId) as { url: string }[];
  return rows.map((row) => row.url);
}

async function subscribe(host: Host, urls: string[]): Promise<string[]> {
  const result = (await host.harness.callRpc('subscribe', { threadId: 'thr_1', urls })) as { urls: string[] };
  return result.urls;
}

async function unsubscribe(host: Host, urls: string[]): Promise<string[]> {
  const result = (await host.harness.callRpc('unsubscribe', { threadId: 'thr_1', urls })) as { urls: string[] };
  return result.urls;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('follows a pull request once however its owner and repo are cased', async () => {
  const host = await load();
  await subscribe(host, ['https://github.com/Owner/Repo/pull/1']);
  await subscribe(host, ['https://github.com/owner/repo/pull/1']);

  expect(storedUrls(host)).toEqual(['https://github.com/Owner/Repo/pull/1']);
});

it('unsubscribes a pull request whose casing differs from the stored URL', async () => {
  const host = await load();
  await subscribe(host, ['https://github.com/Owner/Repo/pull/1']);
  await unsubscribe(host, ['https://github.com/owner/repo/pull/1']);

  expect(storedUrls(host)).toEqual([]);
});

it('de-duplicates both casings of one pull request within a single call', async () => {
  const host = await load();
  await subscribe(host, ['https://github.com/Owner/Repo/pull/1', 'https://github.com/owner/repo/pull/1']);

  expect(storedUrls(host)).toEqual(['https://github.com/Owner/Repo/pull/1']);
});
