import fs from 'node:fs';
import path from 'node:path';

// Fixed local worker only. No shell, remote executable, or user-supplied args.
export class ManagedDebateWorkers {
  constructor({ directory, entry, spawn, baseUrl, onError = () => {} }) {
    this.directory = directory; this.entry = entry; this.spawn = spawn; this.baseUrl = baseUrl; this.onError = onError;
    this.workers = new Map(); this.children = new Set(); this.closed = false;
  }
  async start(credential) {
    if (this.closed) throw Error('争论分析器管理器已关闭');
    const task = credential.task;
    let item = this.workers.get(task.id);
    if (!item) { item = { credential }; this.workers.set(task.id, item); }
    if (item.child) throw Error('分析器已经启动');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, task.id + '.json');
    fs.writeFileSync(file, JSON.stringify({ ...credential, baseUrl: this.baseUrl() }), { mode: 0o600, flag: 'wx' });
    item.file = file;
    let child;
    try {
      child = this.spawn(process.execPath, [this.entry, file], { cwd: path.dirname(path.dirname(this.entry)), windowsHide: true, stdio: 'ignore', shell: false });
      item.child = child;
      this.children.add(child);
      const cleanup = () => { this.children.delete(child); if (item.child !== child) return false; item.child = null; clearTimeout(item.killTimer); try { fs.unlinkSync(file); } catch {} return true; };
      child.once('exit', () => { const expected = item.stopping; if (cleanup() && !expected) this.onError(task.id, 'transport_failed'); });
      child.on('error', () => { if (cleanup()) this.onError(task.id, 'transport_failed'); });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      if (this.closed || item.stopping || this.workers.get(task.id) !== item) throw Error('启动已撤销');
      clearTimeout(item.timer);
      item.timer = setTimeout(() => this.stop(task.id, true), Math.max(1, task.expiresAt - Date.now())); item.timer.unref?.();
    } catch {
      if (item.child === child) item.child = null;
      try { fs.unlinkSync(file); } catch {}
      throw Error('本机争论分析器启动失败，任务已撤销');
    }
  }
  stop(id, forget = false) {
    const item = this.workers.get(id); if (!item) return;
    item.generation = (item.generation || 0) + 1; item.stopping = true;
    // Tokens are revoked by DebateTasks before this callback. Termination cannot
    // grant an old process permission to send, even if the OS delays its exit.
    const child = item.child;
    if (child) { child.kill(); item.killTimer = setTimeout(() => child.kill('SIGKILL'), 3000); item.killTimer.unref?.(); }
    if (forget) { clearTimeout(item.timer); this.workers.delete(id); try { if (item.file) fs.unlinkSync(item.file); } catch {} }
  }
  control(task, action) {
    const item = this.workers.get(task.id); if (!item) return;
    if (action !== 'resume') return this.stop(task.id, action === 'stop');
    // Wait for a paused process to exit before opening the same credential file.
    const generation = item.generation = (item.generation || 0) + 1;
    const resume = () => { if (this.closed || task.status !== 'active' || !this.workers.has(task.id) || generation !== item.generation) return;
      item.stopping = false;
      this.start({ ...item.credential, task: { ...item.credential.task, expiresAt: task.expiresAt } }).catch(() => this.onError(task.id, 'transport_failed'));
    };
    if (item.child) item.child.once('exit', resume); else resume();
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    const exits = [...this.children].map(child => new Promise(resolve => {
      // The bridge allows 1.5s for shutdown: finish child termination within it.
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    }));
    for (const id of this.workers.keys()) this.stop(id, true);
    return this.closing = Promise.allSettled(exits);
  }
}
