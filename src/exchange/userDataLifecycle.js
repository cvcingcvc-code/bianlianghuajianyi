const { ReliableSocket } = require('../market/reliableSocket');
// Account listen-key lease and socket are independent of public market connections.
class UserDataLifecycle {
  constructor({ request, onUpdate, socketFactory, log = () => {}, keepaliveMs = 30 * 60 * 1000 }) {
    Object.assign(this, { request, onUpdate, socketFactory, log, keepaliveMs });
    this.stopped = true; this.generation = 0; this.attempt = 0; this.status = 'NOT_STARTED';
  }
  async start() {
    this.stopped = false; const generation = ++this.generation;
    clearTimeout(this.retryTimer); clearInterval(this.leaseTimer); this.socket?.stop();
    this.status = 'CONNECTING';
    try {
      const result = await this.request('POST');
      if (this.stopped || generation !== this.generation) return;
      if (typeof result.listenKey !== 'string' || !/^[A-Za-z0-9_-]+$/.test(result.listenKey)) throw new Error('Invalid listen key');
      this.hasLease = true; this.attempt = 0; this.status = 'ACTIVE';
      this.socket = new ReliableSocket({ url: `wss://demo-fstream.binance.com/ws/${result.listenKey}`,
        staleMs: 65 * 60 * 1000, requireMessages: false, socketFactory: this.socketFactory,
        log: entry => this.log({ ...entry, component: 'user_data_ws' }),
        onMessage: data => {
          if (data.e === 'listenKeyExpired') { void this.start(); return false; }
          if (data.e === 'ACCOUNT_UPDATE' || data.e === 'ORDER_TRADE_UPDATE') this.onUpdate(data);
          return true;
        } });
      this.socket.start();
      this.leaseTimer = setInterval(() => { void this.keepalive(); }, this.keepaliveMs); this.leaseTimer.unref?.();
    } catch { if (!this.stopped && generation === this.generation) this.retry('lease_start_failed'); }
  }
  async keepalive() {
    if (this.stopped) return;
    try { await this.request('PUT'); }
    catch { if (!this.stopped) this.retry('lease_keepalive_failed'); }
  }
  retry(event) {
    this.status = 'UNAVAILABLE'; this.socket?.stop(); clearInterval(this.leaseTimer); clearTimeout(this.retryTimer);
    const retryInMs = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 10));
    this.log({ level: 'error', component: 'user_data', event, retryInMs });
    this.retryTimer = setTimeout(() => { void this.start(); }, retryInMs); this.retryTimer.unref?.();
  }
  getStatus() { return { status: this.status, connection: this.socket?.getStatus() || { status: 'DISCONNECTED', lastMessageAt: null } }; }
  async stop() {
    this.stopped = true; ++this.generation; clearInterval(this.leaseTimer); clearTimeout(this.retryTimer); this.socket?.stop(); this.status = 'STOPPED';
    if (this.hasLease) {
      this.hasLease = false;
      try { await this.request('DELETE'); } catch { this.log({ level: 'error', component: 'user_data', event: 'lease_close_failed' }); }
    }
  }
}
module.exports = { UserDataLifecycle };
