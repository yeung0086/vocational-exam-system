'use strict';
/** v3.0 名单层：加载权威花名册并做完整性校验（重名、空名、非字符串）。 */
const { readJSON, shortHash } = require('./runtime');

class Roster {
  constructor() {
    const names = readJSON('students.json');
    if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string' || !n.trim())) {
      throw new Error('students.json 学员名单加载失败');
    }
    if (new Set(names).size !== names.length) throw new Error('students.json 存在重名学员');
    this.names = names;
    this.set = new Set(names);
    this.fingerprint = shortHash(JSON.stringify(names), 16);
  }
  has(n) { return this.set.has(n); }
}

module.exports = { Roster };
