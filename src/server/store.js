import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** JSON 文件持久化：tmp + rename 原子写入。 */
export class Store {
  constructor(file) {
    this.file = file;
  }

  load() {
    if (!existsSync(this.file)) return null;
    return JSON.parse(readFileSync(this.file, 'utf8'));
  }

  save(state) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.file);
  }
}
