/**
 * Benchmark for the agent host session index (XTRM-565).
 *
 *   npx tsx scripts/bench-session-index.ts --real
 *   npx tsx scripts/bench-session-index.ts --synthetic [--count 4200] [--gb 2.6]
 *
 * Measures cold build (no cache), warm list latency over HTTP (p50/p95 of 100 GET /v1/sessions),
 * append-to-visibility latency for one journal, and restart time with the cache.
 *
 * Provider journals are only read. The work directory (cache, synthetic corpus, the one copied
 * journal used for the append probe) lives under <repo>/.xtrm/reports and is deleted afterwards
 * unless --keep is given.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAgentHost, type AgentHost } from '../src/core/agent-host.js';
import type { SessionIndexRoot } from '../src/core/agent-host-session-index.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback: number) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : Number(args[i + 1]);
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = os.homedir();
const realRoots: SessionIndexRoot[] = [
    { provider: 'pi', dir: path.join(home, '.pi', 'agent', 'sessions') },
    { provider: 'claude', dir: path.join(home, '.claude', 'projects') },
];

function journals(root: SessionIndexRoot): string[] {
    const files: string[] = [];
    for (const dir of readdirSync(root.dir)) {
        const full = path.join(root.dir, dir);
        if (!statSync(full).isDirectory()) continue;
        for (const name of readdirSync(full)) if (name.endsWith('.jsonl')) files.push(path.join(full, name));
    }
    return files;
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const ms = (n: number) => Math.round(n * 100) / 100;

/** Rewrite one real journal under `destDir` with a fresh session id; returns the new id. */
function cloneJournal(source: string, provider: 'pi' | 'claude', destDir: string, scale = 1): { id: string; file: string; bytes: number } {
    const text = readFileSync(source, 'utf8');
    const id = randomUUID();
    let out: string;
    let file: string;
    if (provider === 'pi') {
        const nl = text.indexOf('\n');
        const header = JSON.parse(text.slice(0, nl)) as { id: string };
        const oldId = header.id;
        out = JSON.stringify({ ...header, id }) + text.slice(nl);
        const name = path.basename(source);
        file = path.join(destDir, name.includes(oldId) ? name.replace(oldId, id) : `${id}.jsonl`);
    } else {
        const oldId = path.basename(source, '.jsonl');
        out = text.split(oldId).join(id);
        file = path.join(destDir, `${id}.jsonl`);
    }
    if (scale > 1) {
        // Pad with repeated body lines (after the header) up to the scaled size.
        const body = out.slice(out.indexOf('\n') + 1);
        let extra = Math.floor(out.length * (scale - 1));
        const parts = [out];
        while (extra > 0 && body.length > 0) {
            const piece = extra >= body.length ? body : body.slice(0, body.lastIndexOf('\n', extra) + 1);
            if (!piece) break;
            parts.push(piece);
            extra -= piece.length;
        }
        out = parts.join('');
    }
    mkdirSync(destDir, { recursive: true });
    writeFileSync(file, out);
    return { id, file, bytes: Buffer.byteLength(out) };
}

function get(host: AgentHost, route: string): Promise<{ status: number; bytes: number; body: string }> {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: host.info.port, path: route }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                resolve({ status: res.statusCode ?? 0, bytes: body.length, body: body.toString('utf8') });
            });
        }).on('error', reject);
    });
}

async function measure(label: string, roots: SessionIndexRoot[], work: string, probe: { id: string; file: string }) {
    const cachePath = path.join(work, 'cache', 'session-index.json');
    // Unix socket paths are limited to ~107 bytes; keep the sockets in a short temp dir.
    const sockets = mkdtempSync(path.join(os.tmpdir(), 'xt-bench-'));
    const options = (sub: string) => ({
        socketPath: path.join(sockets, `${sub}.sock`),
        infoPath: path.join(work, `${sub}.json`),
        log: (m: string) => process.stderr.write(`  [host] ${m}\n`),
        sessionIndex: { roots, cachePath },
    });

    // Cold build: no cache.
    rmSync(path.dirname(cachePath), { recursive: true, force: true });
    let t0 = performance.now();
    let host = await startAgentHost(options('cold'));
    await host.sessionIndex!.ready;
    const coldMs = performance.now() - t0;
    const index = host.sessionIndex!;
    const sessionCount = index.list().length;
    const journalCount = index.journalCount;
    const rssMb = process.memoryUsage().rss / 2 ** 20;

    // Warm list latency over HTTP.
    await get(host, '/v1/sessions');
    const lat: number[] = [];
    let bytes = 0;
    let listed = 0;
    for (let i = 0; i < 100; i++) {
        t0 = performance.now();
        const res = await get(host, '/v1/sessions');
        lat.push(performance.now() - t0);
        bytes = res.bytes;
        if (i === 0) listed = (JSON.parse(res.body) as { sessions: unknown[] }).sessions.length;
    }
    lat.sort((a, b) => a - b);

    // Append-to-visibility latency for one journal (file-watch path, no rescan).
    const appendLat: number[] = [];
    for (let i = 0; i < 20; i++) {
        const before = index.get(probe.id)?.frameCount ?? 0;
        const entry = { type: 'message', id: `bench${i}`, parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: `bench ${i}` }] } };
        t0 = performance.now();
        appendFileSync(probe.file, `${JSON.stringify(entry)}\n`);
        while ((index.get(probe.id)?.frameCount ?? 0) <= before) {
            if (performance.now() - t0 > 10_000) throw new Error('append not visible within 10 s');
            await new Promise((r) => setImmediate(r));
        }
        appendLat.push(performance.now() - t0);
        await new Promise((r) => setTimeout(r, 20));
    }
    appendLat.sort((a, b) => a - b);
    await host.close();

    // Restart with the cache (journals unchanged).
    t0 = performance.now();
    host = await startAgentHost(options('warm'));
    await host.sessionIndex!.ready;
    const restartMs = performance.now() - t0;
    const restartCount = host.sessionIndex!.list().length;
    await host.close();

    const result = {
        corpus: label,
        journals: journalCount,
        sessionsListed: listed,
        sessionsIndexed: sessionCount,
        coldBuildMs: ms(coldMs),
        restartWithCacheMs: ms(restartMs),
        restartSessions: restartCount,
        listP50Ms: ms(percentile(lat, 50)),
        listP95Ms: ms(percentile(lat, 95)),
        listMaxMs: ms(lat[lat.length - 1]),
        listBodyBytes: bytes,
        appendVisibleP50Ms: ms(percentile(appendLat, 50)),
        appendVisibleP95Ms: ms(percentile(appendLat, 95)),
        rssAfterBuildMb: Math.round(rssMb),
    };
    rmSync(sockets, { recursive: true, force: true });
    console.log(JSON.stringify(result, null, 2));
    return result;
}

async function main() {
    const work = path.join(repoRoot, '.xtrm', 'reports', `bench-session-index-${Date.now()}`);
    mkdirSync(work, { recursive: true });
    try {
        if (flag('real')) {
            // The append probe needs a writable journal: one real Pi journal copied under the work dir.
            const pi = journals(realRoots[0]);
            const source = pi.reduce((a, b) => (statSync(a).size >= statSync(b).size ? b : a));
            const probe = cloneJournal(source, 'pi', path.join(work, 'probe', '--bench--'));
            const roots: SessionIndexRoot[] = [...realRoots, { provider: 'pi', dir: path.join(work, 'probe') }];
            const realBytes = [...pi, ...journals(realRoots[1])].reduce((n, f) => n + statSync(f).size, 0);
            console.error(`real corpus: ${pi.length} Pi + ${journals(realRoots[1]).length} Claude journals, ${(realBytes / 2 ** 20).toFixed(0)} MiB (+1 probe copy)`);
            await measure('real', roots, work, probe);
        }
        if (flag('synthetic')) {
            const count = value('count', 4200);
            const targetBytes = value('gb', 2.6) * 1e9;
            const sources = realRoots.flatMap((root) => journals(root).map((file) => ({ file, provider: root.provider })));
            const sampled = Array.from({ length: count }, (_, i) => sources[i % sources.length]);
            const natural = sampled.reduce((n, s) => n + statSync(s.file).size, 0);
            const scale = Math.max(1, targetBytes / natural);
            console.error(`synthetic corpus: ${count} journals from ${sources.length} real ones, scale ${scale.toFixed(2)}`);
            const corpus = path.join(work, 'corpus');
            const roots: SessionIndexRoot[] = [
                { provider: 'pi', dir: path.join(corpus, 'pi') },
                { provider: 'claude', dir: path.join(corpus, 'claude') },
            ];
            let total = 0;
            let probe: { id: string; file: string } | null = null;
            const t0 = performance.now();
            sampled.forEach((s, i) => {
                const round = Math.floor(i / sources.length);
                const dir = path.join(s.provider === 'pi' ? roots[0].dir : roots[1].dir, `${path.basename(path.dirname(s.file))}-r${round}`);
                const made = cloneJournal(s.file, s.provider, dir, scale);
                total += made.bytes;
                if (!probe && s.provider === 'pi') probe = made;
            });
            console.error(`generated ${(total / 1e9).toFixed(2)} GB in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
            await measure(`synthetic ${count} journals ${(total / 1e9).toFixed(2)} GB`, roots, work, probe!);
        }
    } finally {
        if (!flag('keep')) rmSync(work, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
