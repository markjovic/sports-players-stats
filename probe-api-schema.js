// probe-api-schema.js
/**
 * Introspects the PlayHQ GraphQL API and outputs all available query fields,
 * their arguments, and return types.
 *
 * Usage:
 *   node probe-api-schema.js [--tenant=bv]
 *
 * Output: probe-api-schema.html (committed to repo)
 */

const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const _ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

const TENANT      = _ARGS.tenant || 'bv';
const API_URL     = 'https://api.playhq.com/graphql';
const OUTPUT_FILE = path.join(__dirname, 'probe-api-schema.html');

// ─── Queries ──────────────────────────────────────────────────────────────────

const Q_SCHEMA = `
query IntrospectionQuery {
  __schema {
    queryType { name }
    types {
      kind
      name
      description
      fields(includeDeprecated: true) {
        name
        description
        isDeprecated
        deprecationReason
        args {
          name
          description
          type { ...TypeRef }
          defaultValue
        }
        type { ...TypeRef }
      }
      inputFields {
        name
        description
        type { ...TypeRef }
        defaultValue
      }
      enumValues(includeDeprecated: true) {
        name
        description
        isDeprecated
      }
    }
  }
}

fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
      }
    }
  }
}`;

// ─── API helper ───────────────────────────────────────────────────────────────

async function gql(operationName, query, variables = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'tenant':       TENANT,
      'origin':       'https://www.playhq.com',
    },
    body: JSON.stringify({ operationName, query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// ─── Type rendering ───────────────────────────────────────────────────────────

function renderType(t) {
  if (!t) return 'unknown';
  if (t.kind === 'NON_NULL') return `${renderType(t.ofType)}!`;
  if (t.kind === 'LIST')     return `[${renderType(t.ofType)}]`;
  return t.name || '?';
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── HTML generation ──────────────────────────────────────────────────────────

function generateHtml({ tenant, queryType, types, generatedAt }) {
  // Find the root Query type
  const queryTypeDef = types.find(t => t.name === queryType.name);
  const queryFields  = (queryTypeDef?.fields || []).sort((a, b) => a.name.localeCompare(b.name));

  // All non-builtin types (exclude __xxx introspection types and scalars)
  const objectTypes = types
    .filter(t => !t.name.startsWith('__') && t.kind === 'OBJECT' && t.name !== queryType.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  const inputTypes = types
    .filter(t => !t.name.startsWith('__') && t.kind === 'INPUT_OBJECT')
    .sort((a, b) => a.name.localeCompare(b.name));

  const enumTypes = types
    .filter(t => !t.name.startsWith('__') && t.kind === 'ENUM')
    .sort((a, b) => a.name.localeCompare(b.name));

  function renderQueryField(f) {
    const args = (f.args || []).map(a =>
      `<span class="arg-name">${escapeHtml(a.name)}</span>: <span class="type">${escapeHtml(renderType(a.type))}</span>${a.defaultValue ? ` = ${escapeHtml(a.defaultValue)}` : ''}`
    ).join(', ');

    const deprecated = f.isDeprecated
      ? `<span class="deprecated">deprecated${f.deprecationReason ? ': ' + escapeHtml(f.deprecationReason) : ''}</span>`
      : '';

    return `
      <div class="query-field${f.isDeprecated ? ' is-deprecated' : ''}">
        <div class="field-sig">
          <span class="field-name">${escapeHtml(f.name)}</span>${args ? `(${args})` : ''}: <span class="type">${escapeHtml(renderType(f.type))}</span>
          ${deprecated}
        </div>
        ${f.description ? `<div class="field-desc">${escapeHtml(f.description)}</div>` : ''}
      </div>`;
  }

  function renderObjectType(t) {
    const fields = (t.fields || []).map(f => {
      const args = (f.args || []).map(a =>
        `<span class="arg-name">${escapeHtml(a.name)}</span>: <span class="type">${escapeHtml(renderType(a.type))}</span>`
      ).join(', ');
      return `<tr${f.isDeprecated ? ' class="is-deprecated"' : ''}>
        <td class="field-name">${escapeHtml(f.name)}${args ? `(${args})` : ''}</td>
        <td class="type">${escapeHtml(renderType(f.type))}</td>
        <td>${f.description ? escapeHtml(f.description) : ''}</td>
      </tr>`;
    }).join('');
    return `
      <details class="type-block">
        <summary><span class="type-name">${escapeHtml(t.name)}</span>${t.description ? ` — <span class="type-desc">${escapeHtml(t.description)}</span>` : ''}</summary>
        <table><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead><tbody>${fields}</tbody></table>
      </details>`;
  }

  function renderInputType(t) {
    const fields = (t.inputFields || []).map(f => `<tr>
      <td class="field-name">${escapeHtml(f.name)}</td>
      <td class="type">${escapeHtml(renderType(f.type))}</td>
      <td>${f.defaultValue ? escapeHtml(f.defaultValue) : ''}</td>
      <td>${f.description ? escapeHtml(f.description) : ''}</td>
    </tr>`).join('');
    return `
      <details class="type-block">
        <summary><span class="type-name">${escapeHtml(t.name)}</span></summary>
        <table><thead><tr><th>Field</th><th>Type</th><th>Default</th><th>Description</th></tr></thead><tbody>${fields}</tbody></table>
      </details>`;
  }

  function renderEnumType(t) {
    const values = (t.enumValues || []).map(v =>
      `<li${v.isDeprecated ? ' class="is-deprecated"' : ''}><code>${escapeHtml(v.name)}</code>${v.description ? ` — ${escapeHtml(v.description)}` : ''}</li>`
    ).join('');
    return `
      <details class="type-block">
        <summary><span class="type-name">${escapeHtml(t.name)}</span>${t.description ? ` — <span class="type-desc">${escapeHtml(t.description)}</span>` : ''}</summary>
        <ul>${values}</ul>
      </details>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PlayHQ API Schema — ${escapeHtml(tenant)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; background: #f4f6f8; color: #1a1a2e; padding: 24px 16px 48px; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  .meta { color: #888; font-size: 0.8rem; margin-bottom: 24px; }
  h2 { font-size: 1rem; font-weight: 700; margin: 28px 0 10px; padding-bottom: 4px; border-bottom: 2px solid #2563eb; }
  h3 { font-size: 0.85rem; font-weight: 600; margin: 20px 0 8px; color: #444; text-transform: uppercase; letter-spacing: 0.05em; }

  /* Query fields */
  .query-field { background: #fff; border-radius: 6px; padding: 10px 14px; margin-bottom: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.07); }
  .query-field.is-deprecated { opacity: 0.5; }
  .field-sig { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 0.85rem; }
  .field-name { font-weight: 700; color: #2563eb; }
  .arg-name { color: #7c3aed; }
  .type { color: #059669; }
  .field-desc { color: #666; font-size: 0.8rem; margin-top: 4px; }
  .deprecated { color: #dc2626; font-size: 0.75rem; margin-left: 8px; font-style: italic; }

  /* Type blocks */
  .type-block { background: #fff; border-radius: 6px; margin-bottom: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); overflow: hidden; }
  .type-block summary { padding: 9px 14px; cursor: pointer; font-family: monospace; font-size: 0.85rem; user-select: none; }
  .type-block summary:hover { background: #f8fafc; }
  .type-name { font-weight: 700; color: #1e293b; }
  .type-desc { color: #888; font-size: 0.8rem; font-family: sans-serif; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  th { background: #f1f5f9; color: #475569; font-weight: 600; text-align: left; padding: 6px 14px; font-size: 0.75rem; text-transform: uppercase; }
  td { padding: 5px 14px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  td.field-name { font-family: monospace; color: #2563eb; white-space: nowrap; }
  td.type { font-family: monospace; color: #059669; white-space: nowrap; }
  tr.is-deprecated td { opacity: 0.45; }
  ul { padding: 8px 14px 10px 28px; }
  li { padding: 2px 0; font-size: 0.8rem; }
  li.is-deprecated { opacity: 0.45; }
  code { font-family: monospace; background: #f1f5f9; padding: 1px 5px; border-radius: 3px; }

  /* Search */
  .search-bar { margin-bottom: 16px; }
  .search-bar input { width: 100%; max-width: 420px; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.9rem; outline: none; }
  .search-bar input:focus { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,0.15); }
  .hidden { display: none; }
</style>
</head>
<body>
<h1>PlayHQ GraphQL API Schema</h1>
<div class="meta">Tenant: <strong>${escapeHtml(tenant)}</strong> &nbsp;·&nbsp; Generated: ${escapeHtml(generatedAt)} &nbsp;·&nbsp; ${queryFields.length} root queries &nbsp;·&nbsp; ${objectTypes.length} object types &nbsp;·&nbsp; ${enumTypes.length} enums</div>

<div class="search-bar">
  <input type="text" id="search" placeholder="Filter queries and types…" oninput="filterAll(this.value)">
</div>

<h2>Root Queries</h2>
<div id="queries">
  ${queryFields.map(renderQueryField).join('')}
</div>

<h2>Object Types</h2>
<div id="objects">
  ${objectTypes.map(renderObjectType).join('')}
</div>

<h2>Input Types</h2>
<div id="inputs">
  ${inputTypes.map(renderInputType).join('')}
</div>

<h2>Enums</h2>
<div id="enums">
  ${enumTypes.map(renderEnumType).join('')}
</div>

<script>
function filterAll(q) {
  q = q.toLowerCase().trim();
  document.querySelectorAll('.query-field').forEach(el => {
    el.classList.toggle('hidden', q && !el.textContent.toLowerCase().includes(q));
  });
  document.querySelectorAll('.type-block').forEach(el => {
    el.classList.toggle('hidden', q && !el.textContent.toLowerCase().includes(q));
  });
}
</script>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔬 PlayHQ API Schema Probe');
  console.log(`   Tenant: ${TENANT}`);
  console.log(`   Output: ${OUTPUT_FILE}`);

  console.log('\n📡 Fetching schema via introspection...');
  const data = await gql('IntrospectionQuery', Q_SCHEMA);
  const schema = data.__schema;

  console.log(`   Query type:   ${schema.queryType.name}`);
  console.log(`   Total types:  ${schema.types.length}`);

  const queryTypeDef = schema.types.find(t => t.name === schema.queryType.name);
  const queryFields  = queryTypeDef?.fields || [];
  console.log(`   Root queries: ${queryFields.length}`);
  console.log('\n   Queries found:');
  queryFields.sort((a, b) => a.name.localeCompare(b.name))
    .forEach(f => console.log(`     ${f.name}(${(f.args||[]).map(a => a.name).join(', ')}): ${renderType(f.type)}`));

  console.log('\n📄 Generating HTML...');
  const html = generateHtml({
    tenant: TENANT,
    queryType: schema.queryType,
    types: schema.types,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
  });

  fs.writeFileSync(OUTPUT_FILE, html);
  console.log(`   Written to: ${OUTPUT_FILE}`);
  console.log('\n✅ Done.');
}

main().catch(e => {
  console.error(`\n❌ Fatal: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
