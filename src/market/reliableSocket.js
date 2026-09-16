class ReliableSocket {
  constructor({ url, onMessage, log = () => {}, socketFactory = url => new WebSocket(url), now = Date.now,
    staleMs = 15000, baseDelayMs = 1000, maxDelayMs = 30000, requireMessages = true }) {
    Object.assign(this, { url, onMessage, log, socketFactory, now, staleMs, baseDelayMs, maxDelayMs, requireMessages });
    this.status = 'DISCONNECTED'; this.lastMessageAt = null; this.attempt = 0; this.stopped = true;
  }
  getStatus() {
    return { status: this.status === 'CONNECTED' && this.requireMessages && (this.lastMessageAt === null || this.now() - this.lastMessageAt > this.staleMs) ? 'STALE' : this.status,
      lastMessageAt: this.lastMessageAt, reconnectAttempt: this.attempt };
  }
  start() {
    this.stopped = false; this.connect();
    this.healthTimer = setInterval(() => {
      if (this.now() - this.connectedAt > this.staleMs && this.getStatus().status === 'STALE') this.failed('stale_data');
    }, Math.min(this.staleMs, 1000));
    this.healthTimer.unref?.();
  }
  connect() {
    if (this.stopped) return;
    this.status = 'DISCONNECTED'; this.lastMessageAt = null; this.connectedAt = this.now();
    try {
      const socket = this.socket = this.socketFactory(this.url);
      this.connectTimer = setTimeout(() => { if (this.socket === socket) this.failed('connect_timeout'); }, this.staleMs);
      this.connectTimer.unref?.();
      socket.addEventListener('open', () => { if (this.socket !== socket) return; clearTimeout(this.connectTimer); this.status = 'CONNECTED'; this.connectedAt = this.now(); });
      socket.addEventListener('message', e => {
        if (this.socket !== socket) return;
        try {
          if (this.onMessage(JSON.parse(e.data)) === false) return;
          this.lastMessageAt = this.now(); this.status = 'CONNECTED'; this.attempt = 0;
        } catch { this.log({ level: 'error', component: 'market_ws', event: 'invalid_message' }); }
      });
      socket.addEventListener('close', () => { if (this.socket === socket) this.failed('disconnect'); });
      socket.addEventListener('error', () => { if (this.socket === socket) this.failed('socket_error'); });
    } catch { this.failed('connect_error'); }
  }
  failed(event) {
    if (this.stopped) return;
    this.status = 'DISCONNECTED'; clearTimeout(this.connectTimer);
    const socket = this.socket; this.socket = null;
    try { socket?.close(); } catch { /* socket may be in CONNECTING */ }
    if (this.retryTimer) return;
    const delayMs = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(this.attempt++, 16));
    this.log({ level: 'error', component: 'market_ws', event, retryInMs: delayMs, lastMessageAt: this.lastMessageAt });
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, delayMs); this.retryTimer.unref?.();
  }
  stop() {
    this.stopped = true; clearInterval(this.healthTimer); clearTimeout(this.retryTimer); clearTimeout(this.connectTimer);
    this.retryTimer = null; const socket = this.socket; this.socket = null; this.status = 'DISCONNECTED';
    try { socket?.close(); } catch { /* already closed */ }
  }
}
module.exports = { ReliableSocket };
