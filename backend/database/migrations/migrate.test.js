'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildMigrationSource } = require('./migrate');

function loadGeneratedModule(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-scaffold-'));
  const filePath = path.join(dir, '20240101000000_add_users_table.js');
  fs.writeFileSync(filePath, source, 'utf8');
  try {
    return require(filePath);
  } finally {
    delete require.cache[require.resolve(filePath)];
  }
}

describe('scaffolded migrations', () => {
  const fileName = '20240101000000_add_users_table.js';
  const migrationName = 'add_users_table';

  it('throws from up() until the body is implemented', async () => {
    const mod = loadGeneratedModule(buildMigrationSource(fileName, migrationName));
    await expect(mod.up({})).rejects.toThrow(/not implemented/);
    await expect(mod.up({})).rejects.toThrow(fileName);
  });

  it('throws from down() until the body is implemented', async () => {
    const mod = loadGeneratedModule(buildMigrationSource(fileName, migrationName));
    await expect(mod.down({})).rejects.toThrow(/not implemented/);
    await expect(mod.down({})).rejects.toThrow(fileName);
  });
});
