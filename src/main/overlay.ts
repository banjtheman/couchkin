import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, basename } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { AppState } from '../shared/types';
import { initialState } from '../shared/defaults';

export function tokenMatches(given: string | null, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  const left = Buffer.from(given),
    right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function overlayState(state: AppState): AppState {
  return {
    ...initialState,
    character: state.character,
    expression: state.expression,
    speaking: state.speaking,
    avatarUrl: state.avatarUrl,
    session: state.session,
    messages: state.messages.filter((m) => m.role === 'companion').slice(-1),
    capabilities: {
      desktop: false,
      localSpeech: false,
      characterGeneration: false,
      liveVoice: false,
    },
  };
}
export class OverlayServer {
  private server: Server;
  private wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private state: AppState = initialState;
  private files = new Map<string, { path: string; type: string }>();
  private owner: WebSocket | null = null;
  private eligible = new Set<WebSocket>();
  private lastBeat = 0;
  private everOwned = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  origin = '';
  constructor(
    private options: {
      token: string;
      port?: number;
      rendererDir: string;
      devUrl?: string;
      onPlayed: (id: string) => void;
      onOwnerLost: () => void;
      onOwnerReady?: () => void;
      onPlaybackFailed?: () => void;
      onPcmActivity?: (active: boolean) => void;
    },
  ) {
    this.server = createServer((req, res) => {
      void this.handleHttp(req.url || '/', req.headers.host || '', res);
    });
    this.server.on('upgrade', (req, socket, head) => {
      try {
        const url = new URL(req.url || '/', this.origin);
        if (
          req.headers.host !== new URL(this.origin).host ||
          url.pathname !== '/events' ||
          !tokenMatches(url.searchParams.get('token'), options.token)
        ) {
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws));
      } catch {
        socket.destroy();
      }
    });
    this.wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'state', state: overlayState(this.state) }));
      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.type === 'ready') this.eligible.add(ws);
          if (
            (data.type === 'ready' || data.type === 'heartbeat') &&
            !this.owner &&
            this.eligible.has(ws)
          ) {
            this.owner = ws;
            this.everOwned = true;
            this.lastBeat = Date.now();
            this.options.onOwnerReady?.();
          }
          if (ws === this.owner) {
            if (data.type === 'heartbeat' || data.type === 'ready') this.lastBeat = Date.now();
            if (data.type === 'played' && typeof data.id === 'string')
              this.options.onPlayed(data.id);
            if (data.type === 'playback-failed') this.options.onPlaybackFailed?.();
            if (data.type === 'pcm-activity' && typeof data.active === 'boolean')
              this.options.onPcmActivity?.(data.active);
          }
        } catch {
          /* Malformed client messages never affect session state. */
        }
      });
      ws.on('close', () => {
        this.eligible.delete(ws);
        if (ws === this.owner) {
          this.owner = null;
          this.options.onOwnerLost();
        }
      });
      ws.on('error', () => {
        this.eligible.delete(ws);
        if (ws === this.owner) {
          this.owner = null;
          this.options.onOwnerLost();
        }
      });
    });
  }
  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port ?? 0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Overlay could not start.');
    this.origin = `http://127.0.0.1:${address.port}`;
    this.timer = setInterval(() => {
      if (this.owner && Date.now() - this.lastBeat > 20000) {
        this.owner.close();
        this.owner = null;
        this.options.onOwnerLost();
      }
    }, 5000);
    return `${this.origin}/?overlay=1&token=${this.options.token}`;
  }
  registerFile(path: string, type: string): string {
    const name = basename(path);
    this.files.set(name, { path, type });
    return `${this.origin}/media/${encodeURIComponent(name)}?token=${this.options.token}`;
  }
  forgetFile(path: string) {
    this.files.delete(basename(path));
  }
  publish(state: AppState) {
    this.state = state;
    this.broadcast({ type: 'state', state: overlayState(state) });
  }
  quiet(clearCaption = true) {
    this.broadcast({ type: 'quiet', clearCaption });
  }
  play(
    event:
      | { type: 'speech'; url: string; id: string }
      | { type: 'pcm'; delta: string; sampleRate: 24000 },
  ): 'overlay' | 'desktop' | 'unavailable' {
    if (this.owner?.readyState === WebSocket.OPEN) {
      this.owner.send(JSON.stringify(event));
      return 'overlay';
    }
    return this.everOwned ? 'unavailable' : 'desktop';
  }
  resetAudioRouting() {
    if (!this.owner) this.everOwned = false;
  }
  private broadcast(event: unknown) {
    const data = JSON.stringify(event);
    for (const ws of this.wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
  private async handleHttp(raw: string, host: string, res: import('node:http').ServerResponse) {
    try {
      if (host !== new URL(this.origin).host) {
        res.writeHead(403).end();
        return;
      }
      const url = new URL(raw, this.origin);
      if (url.pathname.startsWith('/media/')) {
        if (!tokenMatches(url.searchParams.get('token'), this.options.token)) {
          res.writeHead(403).end();
          return;
        }
        const file = this.files.get(decodeURIComponent(url.pathname.slice(7)));
        if (!file) {
          res.writeHead(404).end();
          return;
        }
        res
          .writeHead(200, {
            'Content-Type': file.type,
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          })
          .end(await readFile(file.path));
        return;
      }
      if (url.pathname === '/' && this.options.devUrl) {
        const dest = new URL(this.options.devUrl);
        dest.searchParams.set('overlay', '1');
        if (url.searchParams.get('preview') === '1') dest.searchParams.set('preview', '1');
        dest.searchParams.set('token', this.options.token);
        dest.searchParams.set('eventsUrl', this.origin.replace('http:', 'ws:') + '/events');
        if (!tokenMatches(url.searchParams.get('token'), this.options.token)) {
          res.writeHead(403).end();
          return;
        }
        res.writeHead(302, { Location: dest.toString() }).end();
        return;
      }
      const root = resolve(this.options.rendererDir);
      const path = resolve(
        root,
        '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname),
      );
      if (!path.startsWith(root + '/') || !(await stat(path)).isFile()) {
        res.writeHead(404).end();
        return;
      }
      const mime: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.woff2': 'font/woff2',
      };
      res
        .writeHead(200, {
          'Content-Type': mime[extname(path)] || 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
        })
        .end(await readFile(path));
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
