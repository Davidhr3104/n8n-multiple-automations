// Fundación compartida por todas las automatizaciones: constructor de workflows + piezas reutilizables
// (log por paso en Postgres, idempotencia, HTTP con backoff exponencial, nodos de decisión).
// Cada workflow generado es autocontenido y visible en el canvas de n8n.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lib = name => fs.readFileSync(path.join(ROOT, 'lib', `${name}.js`), 'utf8');

// Embebe lib/<name>.js dentro de un nodo Code: n8n no permite require() de archivos locales.
// Si una librería hace require('./otra'), esa otra debe ir ANTES en la lista: se registra en __libs y un require local la resuelve.
function embed(libs, glue) {
  const needsRegistry = libs.some(({ file }) => /\brequire\(/.test(lib(file)));
  const blocks = libs.map(({ file, exports }) => {
    const src = lib(file);
    const shim = /\brequire\(/.test(src) ? "  const require = n => __libs[String(n).replace(/^\\.\\//, '')];\n" : '';
    const reg = needsRegistry ? `  __libs['${file}'] = module.exports;\n` : '';
    return `const { ${exports.join(', ')} } = (() => {\n  const module = { exports: {} };\n${shim}${src}\n${reg}  return module.exports;\n})();`;
  });
  return `${needsRegistry ? 'const __libs = {};\n' : ''}${blocks.join('\n')}\n\n${glue}`.trim();
}

// Credenciales referenciadas por los nodos. Las de infraestructura local no llevan secretos reales.
const CRED = {
  smtp: { smtp: { id: 'smtpMailpit01', name: 'Mailpit (local SMTP)' } },
  pg: { postgres: { id: 'postgresLocal01', name: 'Postgres local (automations)' } },
  pgKb: { postgres: { id: 'postgresKb01', name: 'pgvector local (knowledge base)' } },
  anthropic: { httpHeaderAuth: { id: 'anthropicKey01', name: 'Anthropic API (PLACEHOLDER)' } },
  ghl: { httpHeaderAuth: { id: 'ghlKey01', name: 'GoHighLevel (PLACEHOLDER)' } },
  gmail: { httpHeaderAuth: { id: 'gmailKey01', name: 'Gmail API (PLACEHOLDER)' } },
  embeddings: { httpHeaderAuth: { id: 'embeddingsKey01', name: 'Embeddings API (PLACEHOLDER)' } },
};

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

// Las expresiones de n8n se cierran con '}}': un '}}' en medio de una expresión la corta (bug real que ya tuvimos).
function assertExpr(expr, where) {
  const inner = expr.replace(/^=\{\{/, '').replace(/\}\}$/, '');
  if (inner.includes('}}')) throw new Error(`expression in ${where} contains "}}" and would be cut by n8n: ${expr.slice(0, 120)}`);
  return expr;
}

function Workflow(id, name) {
  const nodes = [];
  const connections = {};
  const positions = {};
  const api = {
    add(nodeName, type, typeVersion, position, parameters, extra = {}) {
      if (positions[nodeName]) throw new Error(`duplicate node name: ${nodeName}`);
      positions[nodeName] = position;
      const walk = v => {
        if (typeof v === 'string' && v.startsWith('={{') && v.trimEnd().endsWith('}}')) assertExpr(v, nodeName);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(parameters);
      nodes.push({ parameters, id: uid(), name: nodeName, type, typeVersion, position, ...extra });
      return api;
    },
    link(from, to, outputIndex = 0) {
      if (!positions[from]) throw new Error(`link from unknown node: ${from}`);
      if (!positions[to]) throw new Error(`link to unknown node: ${to}`);
      connections[from] ??= { main: [] };
      const main = connections[from].main;
      while (main.length <= outputIndex) main.push([]);
      main[outputIndex].push({ node: to, type: 'main', index: 0 });
      return api;
    },
    pos: nodeName => positions[nodeName],
    note(content, position, width, height) {
      return api.add(`Note ${nodes.length + 1}`, 'n8n-nodes-base.stickyNote', 1, position, { content, width, height, color: 7 });
    },
    // Garantiza el orden de ejecución de las ramas laterales (log, cierre de idempotencia): cada una se coloca por
    // ENCIMA de todos los hermanos de su misma salida (n8n v1 ejecuta de arriba a abajo), esquivando solapes.
    tidy() {
      const isSide = n => n.name.startsWith('Log · ') || n.name.startsWith('Side · ') || n.name === 'Mark Idempotency';
      const byName = Object.fromEntries(nodes.map(n => [n.name, n]));
      for (const s of nodes.filter(isSide)) {
        const sibs = [];
        for (const c of Object.values(connections)) for (const out of c.main) {
          if (out.some(t => t.node === s.name)) sibs.push(...out.map(t => byName[t.node]).filter(n => n && !isSide(n)));
        }
        if (sibs.length) s.position = [s.position[0], Math.min(...sibs.map(n => n.position[1])) - 130];
        const others = nodes.filter(n => n !== s && n.type !== 'n8n-nodes-base.stickyNote');
        while (others.some(n => Math.abs(n.position[0] - s.position[0]) < 220 && Math.abs(n.position[1] - s.position[1]) < 90)) s.position = [s.position[0], s.position[1] - 100];
        positions[s.name] = s.position;
      }
      return api;
    },
    build(settings) {
      api.tidy();
      return { id, name, nodes, connections, settings, active: false, pinData: {}, meta: { templateCredsSetupCompleted: false } };
    },
  };
  return api;
}

const code = jsCode => ({ mode: 'runOnceForEachItem', jsCode });
const ifBool = expr => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id: uid(), leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and',
  },
  options: {},
});
const ifEquals = (expr, value) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id: uid(), leftValue: expr, rightValue: value, operator: { type: 'string', operation: 'equals' } }],
    combinator: 'and',
  },
  options: {},
});

// Switch por igualdad de texto: una salida por clave (renombrada con la clave).
const switchBy = (expr, keys) => ({
  rules: { values: keys.map(k => ({
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: uid(), leftValue: expr, rightValue: k, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' },
    renameOutput: true, outputKey: k,
  })) },
  options: {},
});

// ───────────── Log por paso (rama lateral: no altera el estado del flujo principal) ─────────────
// ORDEN: con executionOrder v1 n8n ejecuta las ramas de una misma salida por posición, de ARRIBA a ABAJO.
// Por eso el log va ENCIMA de su nodo (dy negativo): corre primero, en orden cronológico y antes de cualquier espera humana.
// Todas las opciones son EXPRESIONES JS (strings). Si Postgres falla, el nodo falla y salta el Error Handler: nunca en silencio.
function logBranch(w, from, o) {
  const {
    workflow, step, status = "'ok'", entity = '$json.lead_id', error = "''", detail = '({})',
    runId = '$execution.id', outputIndex = 0, name = `Log · ${step}`, dy = -190,
  } = o;
  const [x, y] = w.pos(from);
  const params = `[${runId}, ${JSON.stringify(workflow)}, String((${entity}) ?? ''), ${JSON.stringify(step)}, ${status}, (${error}) ?? '', JSON.stringify(${detail})]`;
  w.add(name, 'n8n-nodes-base.postgres', 2.6, [x, y + dy], {
    operation: 'executeQuery',
    query: "INSERT INTO execution_log (run_id, workflow, entity_id, step, status, error, detail) VALUES ($1, $2, NULLIF($3, ''), $4, $5, NULLIF($6, ''), $7::jsonb)",
    options: { queryReplacement: `={{ ${params} }}` },
  }, { credentials: CRED.pg, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, notes: 'Log de ejecución (Postgres). Rama lateral.' });
  w.link(from, name, outputIndex);
  return name;
}

// ───────────── HTTP con reintentos y backoff exponencial ─────────────
// Crea: <name> → <name> · check → <name> · retry? ─sí→ <name> · backoff (Wait) → <name>
// Devuelve el nodo cuya salida 1 (no reintentar) debes conectar al siguiente paso.
// El estado viaja en $json: la salida del check es { ...estado del nodo fuente, http_response, http }.
function httpWithBackoff(w, o) {
  const { name, position: [x, y], params, credentials, notes, source, workflow, maxAttempts = 4, entity = '$json.lead_id' } = o;
  const check = `${name} · check`;
  const decide = `${name} · retry?`;
  const wait = `${name} · backoff`;

  w.add(name, 'n8n-nodes-base.httpRequest', 4.2, [x, y], params,
    { credentials, onError: 'continueRegularOutput', notes: `${notes || ''}\nSin retryOnFail propio: los reintentos con backoff exponencial los hace el bucle "${check}".`.trim() });
  w.add(check, 'n8n-nodes-base.code', 2, [x + 240, y], code(embed(
    [{ file: 'retry', exports: ['retryDecision'] }],
    `const state = $('${source}').item.json;
const http = retryDecision($input.item.json, $runIndex + 1, { maxAttempts: ${maxAttempts} });
return { json: { ...state, http_response: $input.item.json, http } };`)));
  w.add(decide, 'n8n-nodes-base.if', 2.2, [x + 480, y], ifBool('={{ $json.http.retry }}'));
  w.add(wait, 'n8n-nodes-base.wait', 1.1, [x + 240, y - 170],
    { resume: 'timeInterval', amount: '={{ $json.http.delay_s }}', unit: 'seconds' }, { webhookId: uid() });

  w.link(name, check).link(check, decide).link(decide, wait, 0).link(wait, name);
  logBranch(w, decide, { workflow, step: `${name.toLowerCase().replace(/\W+/g, '_')}_retry`, status: "'retrying'", entity, error: '$json.http.reason', detail: '({ attempt: $json.http.attempt, delay_s: $json.http.delay_s, status: $json.http.status })', outputIndex: 0, name: `Log · ${name} retry` });
  return decide;
}

// ───────────── Helpers para los workflows de revival ─────────────
const codeAll = jsCode => ({ mode: 'runOnceForAllItems', jsCode });

// Consulta Postgres. `params` es una expresión JS que devuelve el array de parámetros ($1, $2, ...).
function pg(w, name, position, query, params, extra = {}) {
  return w.add(name, 'n8n-nodes-base.postgres', 2.6, position,
    { operation: 'executeQuery', query, options: params ? { queryReplacement: `={{ ${params} }}` } : {} },
    { credentials: CRED.pg, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000, ...extra });
}

// Consulta a la base de conocimiento (contenedor pgvector).
function pgKb(w, name, position, query, params, extra = {}) {
  return pg(w, name, position, query, params, { ...extra, credentials: CRED.pgKb });
}

function respond(w, name, position, statusCode, bodyExpr) {
  return w.add(name, 'n8n-nodes-base.respondToWebhook', 1.4, position,
    { respondWith: 'json', responseBody: `={{ JSON.stringify(${bodyExpr}) }}`, options: { responseCode: statusCode } });
}

// Reclamo atómico de idempotencia: Claim → Result (restaura el estado) → IF is_new.
// keySql usa $1..$paramCount; el id de ejecución se añade como último parámetro.
function idempotency(w, o) {
  const { workflow, position: [x, y], keySql, params, paramCount, stateFrom, claim = 'Claim Idempotency', result = 'Idempotency Result', check } = o;
  const sql = `WITH k AS (SELECT ${keySql} AS key),
ins AS (
  INSERT INTO idempotency_keys (key, workflow, execution_id, status)
  SELECT key, '${workflow}', $${paramCount + 1}, 'processing' FROM k
  ON CONFLICT (key) DO UPDATE
    SET execution_id = EXCLUDED.execution_id, status = 'processing', claimed_at = now(), finished_at = NULL,
        attempts = idempotency_keys.attempts + 1
    WHERE idempotency_keys.status = 'failed'
       OR (idempotency_keys.status = 'processing' AND idempotency_keys.claimed_at < now() - interval '1 hour')
  RETURNING key
)
SELECT (SELECT key FROM k) AS key, EXISTS (SELECT 1 FROM ins) AS is_new`;
  pg(w, claim, [x, y], sql, `[${params}, $execution.id]`,
    { notes: 'Reclamo atómico (PRIMARY KEY). Se puede reprocesar si el intento anterior quedó "failed" o "processing" hace más de 1 h.' });
  w.add(result, 'n8n-nodes-base.code', 2, [x + 240, y], code(
    `const s = $('${stateFrom}').item.json;
const r = $input.item.json;
return { json: { ...s, idem: { key: r.key, is_new: r.is_new === true } } };`));
  w.add(check, 'n8n-nodes-base.if', 2.2, [x + 480, y], ifBool('={{ $json.idem.is_new }}'));
  w.link(claim, result).link(result, check);
  return { claim, result, check };
}

// Cierre de la clave (rama lateral): solo la ejecución dueña de la clave la cierra.
function markIdempotency(w, o) {
  const { position, keyExpr, statusExpr, resultExpr } = o;
  return pg(w, 'Mark Idempotency', position,
    'UPDATE idempotency_keys SET status = $2, finished_at = now(), result = $3::jsonb WHERE key = $1 AND execution_id = $4',
    `[${keyExpr}, ${statusExpr}, JSON.stringify(${resultExpr}), $execution.id]`,
    { notes: 'Cierra la clave: done, o failed si algo falló (así un reintento sí puede reprocesar).' });
}

module.exports = { ROOT, embed, CRED, uid, Workflow, code, codeAll, ifBool, ifEquals, switchBy, logBranch, httpWithBackoff, pg, pgKb, respond, idempotency, markIdempotency };
