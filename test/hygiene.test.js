const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Un "\b" mal escapado al parchear archivos deja un carácter backspace (U+0008) dentro de una regex: falla en silencio.
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('ningún .js de lib/, build/ o scripts/ contiene caracteres de control', () => {
  const root = path.join(__dirname, '..');
  const offenders = [];
  for (const dir of ['lib', 'build', 'scripts']) {
    for (const f of files(path.join(root, dir))) {
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(fs.readFileSync(f, 'utf8'))) offenders.push(path.relative(root, f));
    }
  }
  assert.deepEqual(offenders, []);
});
