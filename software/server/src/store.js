import fs from 'node:fs';
import path from 'node:path';

// 单进程追加日志。每次先写入并 fsync 再向客户端确认，不跨进程共享目录。
export class Journal {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = path.join(directory, '.writer.lock');
    try { this.lockFd = fs.openSync(this.lock, 'wx', 0o600); } catch { throw new Error('Data directory locked. Verify no other server is running before removing .writer.lock.'); }
    fs.writeSync(this.lockFd, String(process.pid));
    this.file = path.join(directory, 'journal.jsonl');
    this.rows = [];
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file);
        if (raw.length > 64 * 1024 * 1024) throw new Error('Journal exceeds 64 MiB: archive before starting.');
        const end = raw.lastIndexOf(10) + 1;
        if (end < raw.length) {
          fs.writeFileSync(path.join(directory, `interrupted-tail-${Date.now()}.bin`), raw.subarray(end), { flag: 'wx', mode: 0o600 });
          fs.truncateSync(this.file, end);
        }
        this.rows = raw.subarray(0, end).toString('utf8').split('\n').filter(Boolean).map((line, i) => {
          try { const row = JSON.parse(line); if (row.version !== 1 || !row.kind || typeof row.data !== 'object') throw Error(); return row; }
          catch { throw new Error(`Journal corruption at line ${i + 1}; startup refused.`); }
        });
      }
      this.fd = fs.openSync(this.file, 'a', 0o600);
    } catch (e) { this.close(); throw e; }
  }
  append(kind, data) {
    const row = { version: 1, kind, data };
    const encoded = JSON.stringify(row) + '\n';
    if (fs.fstatSync(this.fd).size + Buffer.byteLength(encoded) > 64 * 1024 * 1024) throw new Error('journal_capacity_reached');
    fs.writeSync(this.fd, encoded); fs.fsyncSync(this.fd);
    this.rows.push(row);
  }
  close() {
    if (this.fd !== undefined) { fs.closeSync(this.fd); this.fd = undefined; }
    if (this.lockFd !== undefined) { fs.closeSync(this.lockFd); this.lockFd = undefined; fs.unlinkSync(this.lock); }
  }
}
