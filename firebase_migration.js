let allFlags = [];          // normalized { key, name, description, tags, source, enabled, status, rules, groups, allocation, raw }
let selectedKeys = new Set();
let flagSdks = {};          // flagKey → sdk id
let flagEvalModes = {};     // flagKey → evalMode id
let encodedAuth = '';

const SDKS = [
  { id: 'javascript', label: 'JavaScript (Web)',   serving: 'client' },
  { id: 'nodejs',     label: 'Node.js',            serving: 'server' },
  { id: 'python',     label: 'Python',             serving: 'server' },
  { id: 'swift',      label: 'iOS (Swift)',        serving: 'client' },
  { id: 'android',    label: 'Android',            serving: 'client' },
  { id: 'reactnative',label: 'React Native',       serving: 'client' },
  { id: 'flutter',    label: 'Flutter',            serving: 'client' },
  { id: 'go',         label: 'Go',                 serving: 'server' },
  { id: 'ruby',       label: 'Ruby',               serving: 'server' },
  { id: 'java',       label: 'Java',               serving: 'server' },
];

const FIREBASE_RC_API = 'https://firebaseremoteconfig.googleapis.com/v1';

// Firebase condition rule prefixes that have no Mixpanel equivalent. Anything a
// condition expression references beyond `percent` is dropped on migration, so we
// detect these to warn per-flag in the report.
const UNSUPPORTED_RULE_PATTERNS = [
  { re: /device\.os/i,              label: 'Operating system' },
  { re: /device\.country/i,         label: 'Country / region' },
  { re: /device\.language/i,        label: 'Language' },
  { re: /device\.browser/i,         label: 'Browser' },
  { re: /device\.dateTime|dateTime/i, label: 'Date / time' },
  { re: /app\.version/i,            label: 'App version' },
  { re: /app\.build/i,              label: 'Build number' },
  { re: /app\.id/i,                 label: 'App ID' },
  { re: /app\.userProperty/i,       label: 'User property' },
  { re: /app\.audiences/i,          label: 'Analytics audience' },
  { re: /app\.firebaseInstallationId/i, label: 'Installation ID' },
  { re: /customSignal/i,            label: 'Custom signal' },
];

// ── Auth preview ──────────────────────────────────────────────────────────────
document.getElementById('mp-user').addEventListener('input', updateAuth);
document.getElementById('mp-secret').addEventListener('input', updateAuth);
function updateAuth() {
  const u = v('mp-user'), s = v('mp-secret');
  if (u && s) {
    encodedAuth = btoa(`${u}:${s}`);
    el('auth-preview').textContent = `Authorization: Basic ${encodedAuth.slice(0,14)}…${encodedAuth.slice(-6)}  (base64("${u.split('.')[0]}…:secret"))`;
  } else {
    encodedAuth = '';
    el('auth-preview').textContent = 'Authorization header preview will appear once both fields are filled.';
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────
function goTo(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  el(`view-${id}`).classList.add('active');
  document.querySelector(`[data-view="${id}"]`).classList.add('active');
  if (id === 'export') renderReport();
  if (id === 'code') renderCodeBlocks();
  if (id === 'import') el('s-total').textContent = selectedKeys.size;
  lastView = id;
  persist();
}

// ── Fetch from Firebase ─────────────────────────────────────────────────────────
async function fetchFlags() {
  const cfg = getCfg();
  const eb = el('config-error'); eb.style.display = 'none';
  if (!cfg.fbProject) return showErr(eb, 'Firebase project ID is required.');
  if (!cfg.fbToken) return showErr(eb, 'Firebase OAuth access token is required. Run <code>gcloud auth print-access-token</code> and paste the result.');
  if (!cfg.importGates && !cfg.importConfigs) return showErr(eb, 'Select at least one of boolean parameters or value parameters to import.');
  if (!v('mp-user') || !v('mp-secret')) return showErr(eb, 'Mixpanel service account username and secret are required.');
  const btn = el('btn-fetch'); btn.disabled = true; btn.textContent = 'Fetching…';
  try {
    allFlags = await doFetchFlags(cfg);
    if (!allFlags.length) throw new Error('No Remote Config parameters matched your selection. Check the project ID, and that the template actually has parameters.');
    allFlags.forEach(f => { if (!flagSdks[f.key]) flagSdks[f.key] = 'javascript'; });
    selectedKeys = new Set(allFlags.map(f => f.key));
    renderTable();
    updateNavDone('config');
    goTo('select');
  } catch(e) { showErr(eb, e.message); }
  finally { btn.disabled = false; btn.textContent = 'Fetch from Firebase'; }
}

async function doFetchFlags(cfg) {
  const template = await fetchRemoteConfigTemplate(cfg);

  // Conditions are declared once at template level and referenced by name from
  // each parameter's conditionalValues, so index them up front.
  const conditionsByName = {};
  (template.conditions || []).forEach(c => { conditionsByName[c.name] = c; });

  const flags = [];

  // Top-level parameters, then parameters nested inside parameter groups. Groups
  // are purely organisational in Firebase — keys stay globally unique — so we
  // flatten them and keep the group name as a tag.
  Object.entries(template.parameters || {}).forEach(([key, p]) => {
    flags.push(normalizeParameter(key, p, null, conditionsByName));
  });
  Object.entries(template.parameterGroups || {}).forEach(([groupName, group]) => {
    Object.entries(group.parameters || {}).forEach(([key, p]) => {
      flags.push(normalizeParameter(key, p, groupName, conditionsByName));
    });
  });

  // Classification happens during normalize, so filter afterwards.
  return flags.filter(f =>
    (f.source === 'gate'   && cfg.importGates) ||
    (f.source === 'config' && cfg.importConfigs)
  );
}

async function fetchRemoteConfigTemplate(cfg) {
  const res = await fetch(`${FIREBASE_RC_API}/projects/${encodeURIComponent(cfg.fbProject)}/remoteConfig`, {
    headers: { Authorization: `Bearer ${cfg.fbToken}`, Accept: 'application/json' }
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Firebase rejected the token (HTTP ' + res.status + '). Access tokens expire after about an hour — run <code>gcloud auth print-access-token</code> again and paste a fresh one. Also confirm the token carries the <code>firebase.remoteconfig</code> scope and can read this project.');
  }
  if (res.status === 404) {
    throw new Error(`Firebase returned 404 for project "${cfg.fbProject}". Check the project ID (it's the Firebase project ID, not the project number).`);
  }
  if (!res.ok) throw new Error(`Firebase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Firebase stores every parameter value as a string, so the declared valueType
// decides how to read it. Older templates may omit valueType — infer in that case.
function coerceValue(paramValue, valueType) {
  if (!paramValue || paramValue.useInAppDefault) return null;
  const raw = paramValue.value;
  if (raw == null) return null;
  const t = valueType || inferValueType(raw);
  switch (t) {
    case 'BOOLEAN': return String(raw).toLowerCase() === 'true';
    case 'NUMBER': { const n = parseFloat(raw); return Number.isNaN(n) ? raw : n; }
    case 'JSON':
      try { return JSON.parse(raw); } catch { return raw; }
    default: return raw;
  }
}

function inferValueType(raw) {
  const s = String(raw).trim();
  if (/^(true|false)$/i.test(s)) return 'BOOLEAN';
  if (s !== '' && !Number.isNaN(Number(s))) return 'NUMBER';
  if (/^[\[{]/.test(s)) { try { JSON.parse(s); return 'JSON'; } catch { /* not JSON */ } }
  return 'STRING';
}

// Percentage rollout is the only Firebase condition rule with a Mixpanel
// equivalent. Firebase writes it as `percent <= 10`, `percent('seed') <= 10`,
// or `percent between 5 and 10`. Returns 0-100, or null when absent.
function parsePercent(expression) {
  if (!expression) return null;
  const between = expression.match(/percent(?:\([^)]*\))?\s*between\s+(\d+(?:\.\d+)?)\s+and\s+(\d+(?:\.\d+)?)/i);
  if (between) return Math.max(0, parseFloat(between[2]) - parseFloat(between[1]));
  const cmp = expression.match(/percent(?:\([^)]*\))?\s*(<=|<|>=|>|==)\s*(\d+(?:\.\d+)?)/i);
  if (!cmp) return null;
  const [, op, numStr] = cmp;
  const num = parseFloat(numStr);
  // `percent > 90` selects the top slice, i.e. 10% of users.
  return (op === '>' || op === '>=') ? Math.max(0, 100 - num) : num;
}

function unsupportedRules(expression) {
  if (!expression) return [];
  return UNSUPPORTED_RULE_PATTERNS.filter(p => p.re.test(expression)).map(p => p.label);
}

function normalizeParameter(key, p, groupName, conditionsByName) {
  const valueType = p.valueType || inferValueType(p.defaultValue?.value ?? '');
  // Boolean parameters act as feature gates; everything else carries a value.
  const source = valueType === 'BOOLEAN' ? 'gate' : 'config';

  // Expand each referenced condition into a rule we can inspect and display.
  const rules = Object.entries(p.conditionalValues || {}).map(([condName, cv]) => {
    const cond = conditionsByName[condName] || {};
    const expression = cond.expression || '';
    return {
      name: condName,
      expression,
      value: coerceValue(cv, valueType),
      percent: parsePercent(expression),
      unsupported: unsupportedRules(expression),
    };
  });

  const firstPercentRule = rules.find(r => r.percent != null);

  return {
    key,
    name: key,                                   // Firebase has no display name
    description: p.description || '',
    tags: groupName ? [groupName] : [],          // parameter group flattens to a tag
    source,
    enabled: !p.defaultValue?.useInAppDefault,
    status: undefined,
    rules,
    groups: [],                                  // no experiments in this tool
    allocation: firstPercentRule ? firstPercentRule.percent : null,
    idType: null,                                // Firebase has no Statsig-style ID type
    valueType,
    defaultValue: coerceValue(p.defaultValue, valueType),
    conditionalValue: rules.length ? rules[0].value : undefined,
    groupName: groupName || null,
    unsupported: [...new Set(rules.flatMap(r => r.unsupported))],
    raw: p,
  };
}

// ── Table render ──────────────────────────────────────────────────────────────
function visibleFlags() {
  const q = v('search').toLowerCase(), src = v('f-source'), sf = v('f-status'), tf = v('f-type');
  return allFlags.filter(f => {
    const mq = !q || f.key.toLowerCase().includes(q) || (f.name||'').toLowerCase().includes(q);
    return mq && (!src || f.source === src) && (!sf || flagStatus(f) === sf) && (!tf || flagRuleType(f) === tf);
  });
}

function renderTable() {
  const vis = visibleFlags();
  const tbody = el('flag-tbody');
  tbody.innerHTML = vis.map(f => {
    const rt = flagRuleType(f);
    const rgc = f.rules.length;
    const sel = selectedKeys.has(f.key);
    const currentSdk = flagSdks[f.key] || 'javascript';
    const sdkOpts = SDKS.map(s => `<option value="${s.id}" ${currentSdk===s.id?'selected':''}>${s.label}</option>`).join('');
    const modes = getEvalModes(currentSdk);
    const currentMode = getEvalMode(f.key, currentSdk);
    const modeOpts = modes.map(m => `<option value="${m.id}" ${m.id===currentMode?'selected':''}>${m.label}</option>`).join('');
    return `<tr class="${sel?'selected':''}" data-key="${f.key}">
      <td><input type="checkbox" ${sel?'checked':''} data-key="${f.key}" onchange="toggleFlag('${esc(f.key)}',this.checked)"/></td>
      <td class="mono">${f.key}</td>
      <td>${f.name||'—'}</td>
      <td>${sourcePill(f)}</td>
      <td>${statusPill(f)}</td>
      <td>${ruleTypePill(rt)}</td>
      <td style="color:var(--text-secondary)">${rgc}</td>
      <td><select class="sdk-select" data-key="${f.key}" onchange="setSdk('${esc(f.key)}',this.value)">${sdkOpts}</select></td>
      <td><select class="sdk-select" id="mode-sel-${f.key}" data-key="${f.key}" onchange="setEvalModeFromTable('${esc(f.key)}',this.value)">${modeOpts}</select></td>
    </tr>`;
  }).join('');
  el('empty-msg').style.display = vis.length === 0 ? '' : 'none';
  el('count-badge').textContent = `${vis.length} flags`;
  el('sel-summary').textContent = `${selectedKeys.size} of ${allFlags.length} flags selected`;
}

function toggleFlag(key, checked) {
  if (checked) selectedKeys.add(key); else selectedKeys.delete(key);
  renderTable();
  persist();
}

function setSdk(key, sdk) {
  flagSdks[key] = sdk;
  const modes = getEvalModes(sdk);
  flagEvalModes[key] = modes[0].id;
  const modeSel = el(`mode-sel-${key}`);
  if (modeSel) {
    modeSel.innerHTML = modes.map(m =>
      `<option value="${m.id}" ${m.id === modes[0].id ? 'selected' : ''}>${m.label}</option>`
    ).join('');
  }
  persist();
}

function setEvalModeFromTable(key, mode) {
  flagEvalModes[key] = mode;
  persist();
}

function toggleAll() {
  const vis = visibleFlags();
  const checked = el('chk-all').checked;
  vis.forEach(f => checked ? selectedKeys.add(f.key) : selectedKeys.delete(f.key));
  renderTable();
  persist();
}

// ── Report render ─────────────────────────────────────────────────────────────
function renderReport() {
  const gateC   = allFlags.filter(f => f.source === 'gate').length;
  const groupC  = new Set(allFlags.map(f => f.groupName).filter(Boolean)).size;
  const selC    = selectedKeys.size;

  el('report-stats').innerHTML = `
    <div class="stat-card"><div class="stat-n">${allFlags.length}</div><div class="stat-l">total parameters</div></div>
    <div class="stat-card"><div class="stat-n" style="color:#1D4B6D">${gateC}</div><div class="stat-l">boolean (gates)</div></div>
    <div class="stat-card"><div class="stat-n" style="color:var(--purple-06)">${groupC}</div><div class="stat-l">parameter groups</div></div>
    <div class="stat-card"><div class="stat-n" style="color:var(--grass-06)">${selC}</div><div class="stat-l">selected to import</div></div>
  `;

  renderUnsupportedWarnings();

  const tbody = el('report-tbody');
  tbody.innerHTML = allFlags.map(f => {
    const rt = flagRuleType(f);
    const rgc = f.rules.length;
    const sdk = SDKS.find(s => s.id === (flagSdks[f.key]||'javascript'))?.label || 'JavaScript (Web)';
    const evalModeId = getEvalMode(f.key, flagSdks[f.key]||'javascript');
    const evalModeLabel = getEvalModes(flagSdks[f.key]||'javascript').find(m => m.id === evalModeId)?.label || evalModeId;
    const sel = selectedKeys.has(f.key);
    return `<tr>
      <td class="mono">${f.key}</td>
      <td>${f.name||'—'}</td>
      <td>${sourcePill(f)}</td>
      <td>${statusPill(f)}</td>
      <td>${ruleTypePill(rt)}</td>
      <td style="color:var(--text-secondary)">${rgc}</td>
      <td style="font-size:12px">${sdk}</td>
      <td style="font-size:12px;color:var(--text-secondary)">${evalModeLabel}</td>
      <td>${sel ? '<span class="pill pill-green">✓ Selected</span>' : '<span class="pill pill-neutral">Skipped</span>'}</td>
    </tr>`;
  }).join('');
}

// Firebase targeting is far richer than what Mixpanel's ruleset can express.
// Only percentage rollout survives migration, so spell out exactly what is lost.
function renderUnsupportedWarnings() {
  const box = el('report-warnings');
  if (!box) return;

  const affected = allFlags.filter(f => f.unsupported && f.unsupported.length);
  const multiCond = allFlags.filter(f => f.rules.length > 1);

  if (!affected.length && !multiCond.length) {
    box.innerHTML = `<div class="alert alert-ok">Every selected parameter maps cleanly — no targeting rules were dropped.</div>`;
    return;
  }

  let html = `<div class="alert alert-warn"><strong>Some Firebase targeting could not be migrated.</strong>
    Mixpanel rulesets express percentage rollout only, so the rules below are dropped. The parameter and its
    values still migrate — only the targeting is lost.`;

  if (affected.length) {
    html += `<ul style="margin:8px 0 0 18px;padding:0">` + affected.map(f =>
      `<li><span class="mono">${f.key}</span> — ${f.unsupported.join(', ')}</li>`
    ).join('') + `</ul>`;
  }

  if (multiCond.length) {
    html += `<div style="margin-top:8px">Only the first conditional value is migrated for:
      ${multiCond.map(f => `<span class="mono">${f.key}</span>`).join(', ')}.</div>`;
  }

  html += `<div style="margin-top:8px">Also not migrated: Firebase A/B Testing experiments (no public API),
    template versioning / rollback, and parameter groups (flattened to tags).</div></div>`;

  box.innerHTML = html;
}

// ── Evaluation mode definitions ───────────────────────────────────────────────
const EVAL_MODES = {
  javascript: [
    { id: 'networkOnly',                   label: 'Network only (default)',            desc: 'Async — fetches fresh assignments every page load. No persistence.' },
    { id: 'networkFirst',                   label: 'Network first + persistence',       desc: 'Async — waits for network; falls back to IndexedDB if network fails.' },
    { id: 'persistenceUntilNetworkSuccess', label: 'Persistence until network success', desc: 'Sync — serves IndexedDB immediately; background fetch refreshes session.' },
  ],
  nodejs: [
    { id: 'local',  label: 'Local evaluation (recommended)', desc: 'Sync — polls Mixpanel in background; zero-latency assignment from memory.' },
    { id: 'remote', label: 'Remote evaluation',              desc: 'Async — network call to Mixpanel servers at assignment time. For serverless/ephemeral envs.' },
  ],
  python: [
    { id: 'local',  label: 'Local evaluation (recommended)', desc: 'Sync — polls Mixpanel in background; zero-latency assignment from memory.' },
    { id: 'remote', label: 'Remote evaluation',              desc: 'Async — network call per evaluation. For short-lived or serverless environments.' },
  ],
  swift: [
    { id: 'networkOnly',                   label: 'Network only (default)',            desc: 'Async — fetches on every launch, no persistence.' },
    { id: 'networkFirst',                   label: 'Network first + persistence',       desc: 'Async — waits for network; falls back to UserDefaults if network fails.' },
    { id: 'persistenceUntilNetworkSuccess', label: 'Persistence until network success', desc: 'Sync — returns UserDefaults immediately; background fetch refreshes.' },
  ],
  android: [
    { id: 'networkOnly',                   label: 'Network only (default)',            desc: 'Async — fetches on every launch, no persistence.' },
    { id: 'networkFirst',                   label: 'Network first + persistence',       desc: 'Async — waits for network; falls back to device storage if network fails.' },
    { id: 'persistenceUntilNetworkSuccess', label: 'Persistence until network success', desc: 'Sync — returns from device storage immediately; background fetch refreshes.' },
  ],
  reactnative: [
    { id: 'async', label: 'Async (getVariantValue)', desc: 'Awaits network response. Works in both JS and native mode.' },
    { id: 'sync',  label: 'Sync (getVariantValueSync)', desc: 'Returns immediately — requires areFlagsReady() check first.' },
  ],
  flutter: [
    { id: 'networkOnly',                   label: 'Network only (default)',            desc: 'Async — fetches on every launch, no persistence.' },
    { id: 'networkFirst',                   label: 'Network first + persistence',       desc: 'Async — waits for network; falls back to on-device storage.' },
    { id: 'persistenceUntilNetworkSuccess', label: 'Persistence until network success', desc: 'Sync — returns persisted value immediately; background fetch refreshes.' },
  ],
  go:   [{ id: 'local', label: 'Local evaluation', desc: 'Sync — polls Mixpanel in background; zero-latency assignment from memory.' }],
  ruby: [{ id: 'local', label: 'Local evaluation', desc: 'Sync — polls Mixpanel in background; zero-latency assignment from memory.' }],
  java: [{ id: 'local', label: 'Local evaluation', desc: 'Sync — polls Mixpanel in background; zero-latency assignment from memory.' }],
};

function getEvalModes(sdk) {
  return EVAL_MODES[sdk] ?? [{ id: 'default', label: 'Default', desc: '' }];
}

function getEvalMode(flagKey, sdk) {
  const modes = getEvalModes(sdk);
  return flagEvalModes[flagKey] || modes[0].id;
}

// ── Variant naming ──────────────────────────────────────────────────────────────
// Maps a Firebase parameter to Mixpanel treatment variants (control excluded).
function buildVariantNames(flag) {
  // A Firebase parameter has exactly one default plus (optionally) conditional
  // values, so it always maps to a single Mixpanel treatment. The source name is
  // the condition that produced the treatment value, when there is one.
  const firstRule = (flag.rules || [])[0];
  if (flag.source === 'config') {
    return [{
      sourceKey: firstRule ? firstRule.name : 'default',
      mpKey: 'treatment',
      name: firstRule ? `Conditional: ${firstRule.name}` : 'Value',
    }];
  }
  // Boolean parameter → gate. "On" maps to a single treatment.
  return [{ sourceKey: firstRule ? firstRule.name : 'on', mpKey: 'treatment', name: 'On (parameter true)' }];
}

// ── Code samples ──────────────────────────────────────────────────────────────
function renderCodeBlocks() {
  const selected = allFlags.filter(f => selectedKeys.has(f.key));
  el('code-count').textContent = selected.length;
  if (!selected.length) { el('code-blocks').innerHTML = ''; el('code-empty').style.display = ''; return; }
  el('code-empty').style.display = 'none';
  const token = v('mp-token') || 'YOUR_PROJECT_TOKEN';

  el('code-blocks').innerHTML = selected.map(f => {
    const sdk = flagSdks[f.key] || 'javascript';
    const sdkLabel = SDKS.find(s => s.id === sdk)?.label || sdk;
    const rt = flagRuleType(f);
    const variants = buildVariantNames(f);
    const modes = getEvalModes(sdk);
    const currentMode = getEvalMode(f.key, sdk);
    const modeObj = modes.find(m => m.id === currentMode) || modes[0];

    const modeOpts = modes.map(m =>
      `<option value="${m.id}" ${m.id === currentMode ? 'selected' : ''}>${m.label}</option>`
    ).join('');

    const snippets = generateSnippets(sdk, currentMode, f.key, variants, token);

    return `<div class="code-flag-block" id="block-${f.key}">
      <div class="code-flag-header">
        <span class="flag-key">${f.key}</span>
        ${sourcePill(f)}
        ${ruleTypePill(rt)}
        <span class="flag-sdk">${sdkLabel}</span>
        <div style="display:flex;align-items:center;gap:6px;margin-left:auto">
          <label style="font-size:11px;color:var(--text-muted);white-space:nowrap">Eval mode:</label>
          <select class="sdk-select" style="max-width:220px" onchange="setEvalMode('${esc(f.key)}','${sdk}',this.value)">${modeOpts}</select>
          <button class="btn btn-sm btn-icon" onclick="copyAllSnippets('${esc(f.key)}')" title="Copy all">⎘ All</button>
        </div>
      </div>
      <div style="padding:8px 14px;background:var(--gray-02);border-bottom:1px solid var(--border);font-size:12px;color:var(--text-secondary)">
        ℹ ${modeObj.desc}
      </div>
      ${renderSnippetPanels(f.key, snippets)}
    </div>`;
  }).join('');
}

function renderSnippetPanels(flagKey, snippets) {
  const panels = [
    { id: 'init',     label: '1 · SDK init',          icon: '⚙' },
    { id: 'eval',     label: '2 · Flag retrieval',    icon: '⚑' },
    { id: 'exposure', label: '3 · Exposure tracking', icon: '◎' },
  ];
  return panels.map(p => `
    <div style="border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 14px;background:var(--surface)">
        <span style="font-size:12px;font-weight:600;color:var(--text-secondary)">${p.icon} ${p.label}</span>
        <button class="btn btn-sm btn-icon" onclick="copyCode('${flagKey}-${p.id}')" title="Copy">⎘</button>
      </div>
      <pre class="code-pre" id="${flagKey}-${p.id}" style="border-radius:0">${snippets[p.id]}</pre>
    </div>`
  ).join('');
}

function setEvalMode(flagKey, sdk, mode) {
  flagEvalModes[flagKey] = mode;
  const token = v('mp-token') || 'YOUR_PROJECT_TOKEN';
  const f = allFlags.find(f => f.key === flagKey);
  if (!f) return;
  const variants = buildVariantNames(f);
  const modes = getEvalModes(sdk);
  const modeObj = modes.find(m => m.id === mode) || modes[0];
  const snippets = generateSnippets(sdk, mode, flagKey, variants, token);
  const descDiv = document.querySelector(`#block-${flagKey} [style*="ℹ"]`);
  if (descDiv) descDiv.textContent = `ℹ ${modeObj.desc}`;
  ['init','eval','exposure'].forEach(panel => {
    const pre = el(`${flagKey}-${panel}`);
    if (pre) pre.innerHTML = snippets[panel];
  });
  persist();
}

function copyAllSnippets(flagKey) {
  const text = ['init','eval','exposure'].map(p => {
    const pre = el(`${flagKey}-${p}`);
    return pre ? pre.innerText : '';
  }).join('\n\n// ─────────────────────────────────\n\n');
  navigator.clipboard.writeText(text);
}

// ── generateSnippets: returns { init, eval, exposure } HTML strings ────────────
function generateSnippets(sdk, mode, flagKey, variants, token) {
  const fallback = 'control';
  const variantList = ['control', ...variants.map(v => v.mpKey)];

  const currentRegion = v('mp-region') || 'us';
  const serverApiHost = { us: 'https://api.mixpanel.com', eu: 'https://api-eu.mixpanel.com', in: 'https://api-in.mixpanel.com' }[currentRegion] || 'https://api.mixpanel.com';
  const jsApiHost = { us: 'api.mixpanel.com', eu: 'api-eu.mixpanel.com', in: 'api-in.mixpanel.com' }[currentRegion] || 'api.mixpanel.com';

  const switchCases = variantList.map(k =>
    `  <span class="kw">case</span> <span class="str">'${k}'</span>:\n    <span class="cm">// ${k} experience</span>\n    <span class="kw">break</span>;`
  ).join('\n');
  const switchCasesDQ = variantList.map(k =>
    `  <span class="kw">case</span> <span class="str">"${k}"</span>:\n      <span class="cm">// ${k} experience</span>\n      <span class="kw">break</span>;`
  ).join('\n');

  const treatments = variantList.filter(k => k !== 'control');

  const rubyWhenChain = treatments.map(k =>
    `<span class="kw">when</span> <span class="str">'${k}'</span>\n  <span class="cm"># ${k} experience</span>`
  ).join('\n') + `\n<span class="kw">else</span>\n  <span class="cm"># control / fallback experience</span>`;

  const pythonIfChain = treatments.map((k, i) =>
    `<span class="kw">${i === 0 ? 'if' : 'elif'}</span> variant == <span class="str">"${k}"</span>:\n    <span class="cm"># ${k} experience</span>`
  ).join('\n') + `\n<span class="kw">else</span>:\n    <span class="cm"># control / fallback experience</span>`;

  // ── JavaScript (Web) ────────────────────────────────────────────────────────
  if (sdk === 'javascript') {
    const persistenceBlock = mode === 'networkOnly' ? '' :
      mode === 'networkFirst'
        ? `      persistence: { variantLookupPolicy: <span class="str">'networkFirst'</span>, persistenceTtlMs: <span class="num">86400000</span> }`
        : `      persistence: { variantLookupPolicy: <span class="str">'persistenceUntilNetworkSuccess'</span>, persistenceTtlMs: <span class="num">86400000</span> }`;

    const apiHostLine = currentRegion !== 'us' ? `\n  api_host: <span class="str">'${jsApiHost}'</span>,` : '';

    const initCode = `<span class="cm">// npm install mixpanel-browser (min v2.79.0)</span>
<span class="kw">import</span> mixpanel <span class="kw">from</span> <span class="str">'mixpanel-browser'</span>;

mixpanel.<span class="fn">init</span>(<span class="str">'${token}'</span>, {${apiHostLine}
  flags: {
    enabled: <span class="kw">true</span>${persistenceBlock ? ',\n    ' + persistenceBlock : ''}
  }
});`;

    const isSync = mode === 'persistenceUntilNetworkSuccess';
    const evalCode = isSync
      ? `<span class="cm">// Sync — returns persisted value immediately (IndexedDB)</span>
<span class="kw">const</span> variant = mixpanel.flags.<span class="fn">get_variant_value_sync</span>(<span class="str">'${flagKey}'</span>, <span class="str">'${fallback}'</span>);

<span class="kw">switch</span> (variant) {
${switchCases}
  <span class="kw">default</span>:
    <span class="cm">// fallback — serve control</span>
}`
      : `<span class="cm">// Async — awaits network response${mode === 'networkFirst' ? ' (IndexedDB fallback if network fails)' : ''}</span>
<span class="kw">const</span> variant = <span class="kw">await</span> mixpanel.flags.<span class="fn">get_variant_value</span>(<span class="str">'${flagKey}'</span>, <span class="str">'${fallback}'</span>);

<span class="kw">switch</span> (variant) {
${switchCases}
  <span class="kw">default</span>:
    <span class="cm">// fallback — serve control</span>
}`;

    const exposureCode = `<span class="cm">// Exposure is tracked automatically when get_variant_value is called.</span>
<span class="cm">// To track manually (e.g. only when the feature is actually rendered):</span>
<span class="cm">// 1. Suppress auto-tracking by passing false as the 3rd argument:</span>
<span class="kw">const</span> variant = ${isSync ? '' : '<span class="kw">await</span> '}mixpanel.flags.<span class="fn">${isSync ? 'get_variant_value_sync' : 'get_variant_value'}</span>(<span class="str">'${flagKey}'</span>, <span class="str">'${fallback}'</span>, <span class="kw">false</span>);

<span class="cm">// 2. Then call trackExposureEvent when the user actually sees the feature:</span>
mixpanel.flags.<span class="fn">trackExposureEvent</span>(<span class="str">'${flagKey}'</span>, variant);`;

    return { init: initCode, eval: evalCode, exposure: exposureCode };
  }

  // ── Node.js ─────────────────────────────────────────────────────────────────
  if (sdk === 'nodejs') {
    const isLocal = mode === 'local';
    const initCode = isLocal
      ? `<span class="cm">// npm install mixpanel (min v0.20.0)</span>
<span class="kw">const</span> Mixpanel = <span class="fn">require</span>(<span class="str">'mixpanel'</span>);
<span class="kw">const</span> mp = Mixpanel.<span class="fn">init</span>(<span class="str">'${token}'</span>, {
  local_flags_config: {
    api_host: <span class="str">'${serverApiHost.replace('https://', '')}'</span>,
    enable_polling: <span class="kw">true</span>,
    polling_interval_in_seconds: <span class="num">60</span>
  }
});

<span class="cm">// Call once at app startup — begins background polling.</span>
<span class="kw">await</span> mp.local_flags.<span class="fn">startPollingForDefinitions</span>();`
      : `<span class="cm">// npm install mixpanel (min v0.20.0)</span>
<span class="kw">const</span> Mixpanel = <span class="fn">require</span>(<span class="str">'mixpanel'</span>);
<span class="kw">const</span> mp = Mixpanel.<span class="fn">init</span>(<span class="str">'${token}'</span>, {
  remote_flags_config: {
    api_host: <span class="str">'${serverApiHost.replace('https://', '')}'</span>,
    request_timeout_in_seconds: <span class="num">5</span>
  }
});
<span class="cm">// No startup call needed — each evaluation makes a network request</span>`;

    const evalCode = isLocal
      ? `<span class="cm">// Synchronous — reads from in-memory cache populated by polling</span>
<span class="kw">const</span> variant = mp.local_flags.<span class="fn">getVariantValue</span>(<span class="str">'${flagKey}'</span>, <span class="str">'${fallback}'</span>, {
  distinct_id: userId
});

<span class="kw">switch</span> (variant) {
${switchCases}
  <span class="kw">default</span>:
    <span class="cm">// control / fallback</span>
}`
      : `<span class="cm">// Async — makes a network call to Mixpanel servers per evaluation</span>
<span class="kw">const</span> variant = <span class="kw">await</span> mp.remote_flags.<span class="fn">getVariantValue</span>(<span class="str">'${flagKey}'</span>, <span class="str">'${fallback}'</span>, {
  distinct_id: userId
});

<span class="kw">switch</span> (variant) {
${switchCases}
  <span class="kw">default</span>:
    <span class="cm">// control / fallback</span>
}`;

    const ns = isLocal ? 'local_flags' : 'remote_flags';
    const awaitKw = isLocal ? '' : '<span class="kw">await</span> ';
    const exposureCode = `<span class="cm">// Exposure is tracked automatically. To track manually:</span>
<span class="cm">// 1. Pass false as 4th argument to suppress auto-tracking:</span>
<span class="kw">const</span> variant = ${awaitKw}mp.${ns}.<span class="fn">getVariantValue</span>(<span class="str">'${flagKey}'</span>, <span class="str">'${fallback}'</span>, { distinct_id: userId }, <span class="kw">false</span>);

<span class="cm">// 2. Track exposure when the feature is actually shown to the user:</span>
mp.${ns}.<span class="fn">trackExposureEvent</span>(<span class="str">'${flagKey}'</span>, variant, { distinct_id: userId });`;

    return { init: initCode, eval: evalCode, exposure: exposureCode };
  }

  // ── Python ──────────────────────────────────────────────────────────────────
  if (sdk === 'python') {
    const isLocal = mode === 'local';
    const initCode = isLocal
      ? `<span class="cm"># pip install mixpanel (min v5.1.0)</span>
<span class="kw">import</span> mixpanel

local_config = mixpanel.<span class="fn">LocalFlagsConfig</span>(
    api_host=<span class="str">"${serverApiHost}"</span>,
    enable_polling=<span class="kw">True</span>,
    poll_interval=<span class="num">60</span>
)
mp = mixpanel.<span class="fn">Mixpanel</span>(<span class="str">"${token}"</span>, local_flags_config=local_config)

<span class="cm"># Call once at startup — begins background polling in a separate thread.</span>
mp.local_flags.<span class="fn">start_polling_for_definitions</span>()`
      : `<span class="cm"># pip install mixpanel (min v5.1.0)</span>
<span class="kw">import</span> mixpanel

remote_config = mixpanel.<span class="fn">RemoteFlagsConfig</span>(
    api_host=<span class="str">"${serverApiHost}"</span>,
    request_timeout=<span class="num">5</span>
)
mp = mixpanel.<span class="fn">Mixpanel</span>(<span class="str">"${token}"</span>, remote_flags_config=remote_config)
<span class="cm"># No startup call needed — each evaluation makes a network request</span>`;

    const ns = isLocal ? 'local_flags' : 'remote_flags';
    const evalCode = `<span class="cm"># ${isLocal ? 'Synchronous — reads from in-memory cache' : 'Async — network call per evaluation'}</span>
variant = mp.${ns}.<span class="fn">get_variant_value</span>(
    flag_key=<span class="str">"${flagKey}"</span>,
    fallback_variant=<span class="str">"${fallback}"</span>,
    user_context={<span class="str">"distinct_id"</span>: user_id}
)

${pythonIfChain}`;

    const exposureCode = `<span class="cm"># Exposure tracked automatically. To track manually:</span>
<span class="cm"># Pass track_exposure=False to suppress auto-tracking:</span>
variant = mp.${ns}.<span class="fn">get_variant_value</span>(
    flag_key=<span class="str">"${flagKey}"</span>,
    fallback_variant=<span class="str">"${fallback}"</span>,
    user_context={<span class="str">"distinct_id"</span>: user_id},
    track_exposure=<span class="kw">False</span>
)

<span class="cm"># Track exposure when the feature is actually rendered:</span>
mp.${ns}.<span class="fn">track_exposure_event</span>(<span class="str">"${flagKey}"</span>, variant, {<span class="str">"distinct_id"</span>: user_id})`;

    return { init: initCode, eval: evalCode, exposure: exposureCode };
  }

  // ── Swift ───────────────────────────────────────────────────────────────────
  if (sdk === 'swift') {
    const policyMap = {
      networkOnly: '',
      networkFirst: `        variantLookupPolicy: .networkFirst()`,
      persistenceUntilNetworkSuccess: `        variantLookupPolicy: .persistenceUntilNetworkSuccess()`,
    };
    const policyStr = policyMap[mode] || '';
    const initCode = `<span class="cm">// Swift Package Manager: mixpanel/mixpanel-swift (min v5.1.3)</span>
<span class="kw">import</span> Mixpanel

Mixpanel.<span class="fn">initialize</span>(
    token: <span class="str">"${token}"</span>,
    options: MixpanelOptions(
        serverURL: <span class="str">"${serverApiHost}"</span>,
        featureFlagOptions: FeatureFlagOptions(
            enabled: <span class="kw">true</span>${policyStr ? ',\n            ' + policyStr : ''}
        )
    )
)`;

    const isSync = mode === 'persistenceUntilNetworkSuccess';
    const evalCode = isSync
      ? `<span class="cm">// Sync — returns persisted value from UserDefaults immediately</span>
<span class="kw">let</span> variant = Mixpanel.mainInstance().flags.<span class="fn">getVariantValueSync</span>(<span class="str">"${flagKey}"</span>, fallbackValue: <span class="str">"${fallback}"</span>)

<span class="kw">switch</span> variant {
${variantList.map(k=>`<span class="kw">case</span> <span class="str">"${k}"</span>:\n    <span class="cm">// ${k} experience</span>`).join('\n')}
<span class="kw">default</span>:
    <span class="cm">// fallback</span>
}`
      : `<span class="cm">// Async — awaits network response${mode === 'networkFirst' ? ' (falls back to UserDefaults if network fails)' : ''}</span>
Mixpanel.mainInstance().flags.<span class="fn">getVariantValue</span>(<span class="str">"${flagKey}"</span>, fallbackValue: <span class="str">"${fallback}"</span>) { variant <span class="kw">in</span>
    <span class="kw">switch</span> variant {
    ${variantList.map(k=>`<span class="kw">case</span> <span class="str">"${k}"</span>:\n        <span class="cm">// ${k} experience</span>`).join('\n    ')}
    <span class="kw">default</span>:
        <span class="cm">// fallback</span>
    }
}`;

    const exposureCode = `<span class="cm">// Exposure tracked automatically on getVariantValue call.</span>
<span class="cm">// To track manually, pass trackExposure: false then call:</span>
Mixpanel.mainInstance().flags.<span class="fn">getVariantValue</span>(<span class="str">"${flagKey}"</span>, fallbackValue: <span class="str">"${fallback}"</span>, trackExposure: <span class="kw">false</span>) { variant <span class="kw">in</span>
    <span class="cm">// When ready to expose the user:</span>
    Mixpanel.mainInstance().flags.<span class="fn">trackExposureEvent</span>(flagKey: <span class="str">"${flagKey}"</span>, variant: variant)
}`;

    return { init: initCode, eval: evalCode, exposure: exposureCode };
  }

  // Dynamic if/else chain for Android (Java)
  const androidIfChain = (() => {
    const nonControl = variantList.filter(k => k !== 'control');
    if (!nonControl.length) {
      return `<span class="kw">if</span> (<span class="str">"treatment"</span>.<span class="fn">equals</span>(variant)) {\n    <span class="cm">// treatment experience</span>\n} <span class="kw">else</span> {\n    <span class="cm">// control / fallback experience</span>\n}`;
    }
    const branches = nonControl.map((k, i) =>
      `${i === 0 ? '' : '} <span class="kw">else</span> '}<span class="kw">if</span> (<span class="str">"${k}"</span>.<span class="fn">equals</span>(variant)) {\n    <span class="cm">// ${k} experience</span>`
    ).join('\n');
    return `${branches}\n} <span class="kw">else</span> {\n    <span class="cm">// control / fallback experience</span>\n}`;
  })();
  if (sdk === 'android') {
    const policyMap = {
      networkOnly: '',
      networkFirst: `        .variantLookupPolicy(VariantLookupPolicy.networkFirst())`,
      persistenceUntilNetworkSuccess: `        .variantLookupPolicy(VariantLookupPolicy.persistenceUntilNetworkSuccess())`,
    };
    const policyStr = policyMap[mode] || '';
    const initCode = `<span class="cm">// build.gradle: implementation 'com.mixpanel.android:mixpanel-android:7.x.x'</span>
FeatureFlagOptions ffOptions = <span class="kw">new</span> FeatureFlagOptions.Builder()
    .<span class="fn">enabled</span>(<span class="kw">true</span>)${policyStr ? '\n    ' + policyStr : ''}
    .<span class="fn">build</span>();
MixpanelOptions options = <span class="kw">new</span> MixpanelOptions.Builder()
    .<span class="fn">serverURL</span>(<span class="str">"${serverApiHost}"</span>)
    .<span class="fn">featureFlagOptions</span>(ffOptions).<span class="fn">build</span>();
MixpanelAPI mixpanel = MixpanelAPI.<span class="fn">getInstance</span>(context, <span class="str">"${token}"</span>, <span class="kw">false</span>, options);`;

    const isSync = mode === 'persistenceUntilNetworkSuccess';
    const androidIfChainIndented = androidIfChain.split('\n').map(l => '            ' + l).join('\n');
    const evalCode = isSync
      ? `<span class="cm">// Sync — returns persisted value immediately from device storage</span>
Object flagValue = mixpanel.flags.<span class="fn">getVariantValueSync</span>(<span class="str">"${flagKey}"</span>, <span class="str">"${fallback}"</span>);
String variant = (String) flagValue;
${androidIfChain}`
      : `<span class="cm">// Async — callback fires on the main thread when network response arrives</span>
mixpanel.flags.<span class="fn">getVariantValue</span>(<span class="str">"${flagKey}"</span>, <span class="str">"${fallback}"</span>,
    <span class="kw">new</span> FlagCompletionCallback&lt;Object&gt;() {
        @Override
        <span class="kw">public void</span> <span class="fn">onComplete</span>(Object value) {
            String variant = (String) value;
${androidIfChainIndented}
        }
    }
);`;

    const exposureCode = `<span class="cm">// Exposure tracked automatically. To suppress and track manually:</span>
mixpanel.flags.<span class="fn">getVariantValue</span>(<span class="str">"${flagKey}"</span>, <span class="str">"${fallback}"</span>,
    <span class="kw">new</span> FlagCompletionCallback&lt;Object&gt;() {
        @Override
        <span class="kw">public void</span> <span class="fn">onComplete</span>(Object value) {
            String variant = (String) value;
            <span class="cm">// When feature is actually shown to the user:</span>
            mixpanel.flags.<span class="fn">trackExposureEvent</span>(<span class="str">"${flagKey}"</span>, variant);
        }
    }
);`;

    return { init: initCode, eval: evalCode, exposure: exposureCode };
  }

  // ── React Native ────────────────────────────────────────────────────────────
  if (sdk === 'reactnative') {
    const isSync = mode === 'sync';
    const initCode = `<span class="cm">// npm install mixpanel-react-native@beta (min v3.2.0-beta.3)</span>
<span class="kw">import</span> { Mixpanel } <span class="kw">from</span> <span class="str">'mixpanel-react-native'</span>;

<span class="kw">const</span> mixpanel = <span class="kw">new</span> <span class="fn">Mixpanel</span>(<span class="str">"${token}"</span>);
<span class="cm">// init(optOut, superProps, serverURL, useNative, featureFlagOptions)</span>
<span class="kw">await</span> mixpanel.<span class="fn">init</span>(<span class="kw">false</span>, {}, <span class="str">"${serverApiHost}"</span>, <span class="kw">true</span>, { enabled: <span class="kw">true</span> });`;

    const evalCode = isSync
      ? `<span class="cm">// Sync — requires flags to be loaded first</span>
<span class="kw">if</span> (mixpanel.flags.<span class="fn">areFlagsReady</span>()) {
  <span class="kw">const</span> variant = mixpanel.flags.<span class="fn">getVariantValueSync</span>(<span class="str">'${flagKey}'</span>, <span class="str">'${fallback}'</span>);
  <span class="kw">switch</span> (variant) {
${switchCases}
    <span class="kw">default</span>: <span class="cm">// fallback</span>
  }
} <span class="kw">else</span> {
  <span class="cm">// Flags not yet loaded — show fallback or wait for areFlagsReady()</span>
}`
      : `<span class="cm">// Async — awaits network response</span>
<span class="kw">const</span> [variant, setVariant] = <span class="fn">useState</span>(<span class="str">'${fallback}'</span>);

<span class="fn">useEffect</span>(() => {
  mixpanel.flags.<span class="fn">getVariantValue</span>(<span class="str">'${flagKey}'</span>, <span class="str">'${fallback}'</span>).<span class="fn">then</span>(setVariant);
}, []);

<span class="kw">switch</span> (variant) {
${switchCases}
  <span class="kw">default</span>: <span class="cm">// fallback</span>
}`;

    const exposureCode = `<span class="cm">// Exposure tracked automatically on evaluation.</span>
<span class="cm">// To suppress and track manually:</span>
<span class="kw">const</span> variant = ${isSync ? '' : '<span class="kw">await</span> '}mixpanel.flags.<span class="fn">${isSync ? 'getVariantValueSync' : 'getVariantValue'}</span>(<span class="str">'${flagKey}'</span>, <span class="str">'${fallback}'</span>, <span class="kw">false</span>);

<span class="cm">// When the feature is actually rendered:</span>
mixpanel.flags.<span class="fn">trackExposureEvent</span>(<span class="str">'${flagKey}'</span>, variant);`;

    return { init: initCode, eval: evalCode, exposure: exposureCode };
  }

  // ── Flutter ─────────────────────────────────────────────────────────────────
  if (sdk === 'flutter') {
    const policyMap = {
      networkOnly: '',
      networkFirst: `    variantLookupPolicy: VariantLookupPolicy.networkFirst(),`,
      persistenceUntilNetworkSuccess: `    variantLookupPolicy: VariantLookupPolicy.persistenceUntilNetworkSuccess(),`,
    };
    const policyStr = policyMap[mode] || '';
    const initCode = `<span class="cm">// pubspec.yaml: mixpanel_flutter: ^2.7.0</span>
<span class="kw">import</span> <span class="str">'package:mixpanel_flutter/mixpanel_flutter.dart'</span>;

Mixpanel mixpanel = <span class="kw">await</span> Mixpanel.<span class="fn">init</span>(
  <span class="str">"${token}"</span>,
  trackAutomaticEvents: <span class="kw">false</span>,
  featureFlags: FeatureFlagsConfig(
    enabled: <span class="kw">true</span>${policyStr ? ',\n    ' + policyStr : ''}
  ),
);`;

    const flutterIfChain = (() => {
      const nonControl = variantList.filter(k => k !== 'control');
      if (!nonControl.length) {
        return `<span class="kw">if</span> (variant == <span class="str">"treatment"</span>) {\n  <span class="cm">// treatment experience</span>\n} <span class="kw">else</span> {\n  <span class="cm">// control / fallback experience</span>\n}`;
      }
      const branches = nonControl.map((k, i) =>
        `${i === 0 ? '' : '} <span class="kw">else</span> '}<span class="kw">if</span> (variant == <span class="str">"${k}"</span>) {\n  <span class="cm">// ${k} experience</span>`
      ).join('\n');
      return `${branches}\n} <span class="kw">else</span> {\n  <span class="cm">// control / fallback experience</span>\n}`;
    })();

    const evalCode = `<span class="cm">// ${mode === 'persistenceUntilNetworkSuccess' ? 'Returns persisted value immediately; background fetch refreshes' : 'Async — awaits network response'}</span>
<span class="kw">final</span> variant = <span class="kw">await</span> mixpanel.getFeatureFlags().<span class="fn">getVariantValue</span>(
  <span class="str">"${flagKey}"</span>, <span class="str">"${fallback}"</span>
);

${flutterIfChain}`;

    const exposureCode = `<span class="cm">// Exposure tracked automatically. To track manually:</span>
<span class="kw">final</span> variant = <span class="kw">await</span> mixpanel.getFeatureFlags().<span class="fn">getVariantValue</span>(
  <span class="str">"${flagKey}"</span>, <span class="str">"${fallback}"</span>, trackExposure: <span class="kw">false</span>
);

<span class="cm">// When feature is actually rendered:</span>
mixpanel.getFeatureFlags().<span class="fn">trackExposureEvent</span>(<span class="str">"${flagKey}"</span>, variant);`;

    return { init: initCode, eval: evalCode, exposure: exposureCode };
  }

  // ── Go ───────────────────────────────────────────────────────────────────────
  if (sdk === 'go') {
    const apiHostLine = currentRegion !== 'us'
      ? `\nmixpanel.<span class="fn">WithServiceURL</span>(<span class="str">"${serverApiHost}"</span>),`
      : '';
    const initCode = `<span class="cm">// go get github.com/mixpanel/mixpanel-go</span>
<span class="kw">package</span> main
<span class="kw">import</span> (
    <span class="str">"context"</span>
    mixpanel <span class="str">"github.com/mixpanel/mixpanel-go"</span>
    <span class="str">"github.com/mixpanel/mixpanel-go/v2/flags"</span>
)

mp := mixpanel.<span class="fn">NewApiClient</span>(<span class="str">"${token}"</span>,${apiHostLine}
    mixpanel.<span class="fn">WithLocalFlags</span>(flags.LocalFlagsConfig{}),
)
<span class="kw">defer</span> mp.<span class="fn">Close</span>()
<span class="cm">// Call once at startup — polls Mixpanel for flag definitions in background</span>
mp.LocalFlags.<span class="fn">StartPollingForDefinitions</span>(context.Background())`;

    const evalCode = `<span class="cm">// Synchronous — reads from in-memory local cache</span>
userContext := map[string]interface{}{
    <span class="str">"distinct_id"</span>: userId,
}
variant, err := mp.LocalFlags.<span class="fn">GetVariantValue</span>(context.Background(), <span class="str">"${flagKey}"</span>, <span class="str">"${fallback}"</span>, userContext)
<span class="kw">if</span> err != <span class="kw">nil</span> { <span class="cm">/* handle error, serve fallback */</span> }

<span class="kw">switch</span> variant {
${variantList.map(k=>`<span class="kw">case</span> <span class="str">"${k}"</span>:\n    <span class="cm">// ${k} experience</span>`).join('\n')}
<span class="kw">default</span>:
    <span class="cm">// control / fallback</span>
}`;

    const exposureCode = `<span class="cm">// Exposure tracked automatically. To suppress and track manually:</span>
variant, err := mp.LocalFlags.<span class="fn">GetVariantValue</span>(context.Background(), <span class="str">"${flagKey}"</span>, <span class="str">"${fallback}"</span>,
    userContext, flags.<span class="fn">WithTrackExposure</span>(<span class="kw">false</span>))

<span class="cm">// When feature is actually rendered:</span>
mp.LocalFlags.<span class="fn">TrackExposureEvent</span>(context.Background(), <span class="str">"${flagKey}"</span>, variant, userContext)`;

    return { init: initCode, eval: evalCode, exposure: exposureCode };
  }

  // ── Ruby ─────────────────────────────────────────────────────────────────────
  if (sdk === 'ruby') {
    const initCode = `<span class="cm"># gem install mixpanel-ruby</span>
<span class="kw">require</span> <span class="str">'mixpanel-ruby'</span>

<span class="cm"># Initialize — 'tracker' is the conventional variable name in the Ruby SDK</span>
tracker = Mixpanel::Tracker.<span class="fn">new</span>(<span class="str">'${token}'</span>) do |config|
  config.local_flags_config = {
    api_host: <span class="str">'${serverApiHost}'</span>,
    enable_polling: <span class="kw">true</span>,
    poll_interval: <span class="num">60</span>
  }
<span class="kw">end</span>

<span class="cm"># Call once at startup — begins background polling in a separate thread</span>
tracker.local_flags.<span class="fn">start_polling_for_definitions</span>`;

    const evalCode = `<span class="cm"># Synchronous — reads from in-memory cache</span>
user_context = { <span class="str">'distinct_id'</span> => user_id }

variant = tracker.local_flags.<span class="fn">get_variant_value</span>(
  <span class="str">'${flagKey}'</span>, <span class="str">'${fallback}'</span>, user_context
)

<span class="kw">case</span> variant
${rubyWhenChain}
<span class="kw">end</span>`;

    const exposureCode = `<span class="cm"># Exposure tracked automatically. To track manually:</span>
<span class="cm"># Pass report_exposure: false to suppress auto-tracking</span>
variant = tracker.local_flags.<span class="fn">get_variant_value</span>(
  <span class="str">'${flagKey}'</span>, <span class="str">'${fallback}'</span>, user_context,
  report_exposure: <span class="kw">false</span>
)

<span class="cm"># When feature is actually rendered:</span>
tracker.local_flags.<span class="fn">track_exposure_event</span>(<span class="str">'${flagKey}'</span>, variant, user_context)`;

    return { init: initCode, eval: evalCode, exposure: exposureCode };
  }

  // ── Java ─────────────────────────────────────────────────────────────────────
  if (sdk === 'java') {
    const initCode = `<span class="cm">// Maven: com.mixpanel:mixpanel-java</span>
<span class="cm">// import com.mixpanel.mixpanelapi.MixpanelAPI;</span>
<span class="cm">// import com.mixpanel.mixpanelapi.featureflags.config.LocalFlagsConfig;</span>

LocalFlagsConfig config = LocalFlagsConfig.<span class="fn">builder</span>()
    .<span class="fn">projectToken</span>(<span class="str">"${token}"</span>)
    .<span class="fn">apiHost</span>(<span class="str">"${serverApiHost.replace('https://', '')}"</span>)
    .<span class="fn">enablePolling</span>(<span class="kw">true</span>)
    .<span class="fn">pollingIntervalSeconds</span>(<span class="num">60</span>)
    .<span class="fn">build</span>();

MixpanelAPI mixpanel = <span class="kw">new</span> <span class="fn">MixpanelAPI</span>(config);
<span class="cm">// Call once at startup — begins background polling</span>
mixpanel.<span class="fn">getLocalFlags</span>().<span class="fn">startPollingForDefinitions</span>();`;

    const evalCode = `<span class="cm">// Synchronous — reads from in-memory local cache</span>
<span class="cm">// userContext is a Map&lt;String, Object&gt; — must include "distinct_id"</span>
Map&lt;String, Object&gt; userContext = <span class="kw">new</span> HashMap&lt;&gt;();
userContext.<span class="fn">put</span>(<span class="str">"distinct_id"</span>, userId);

String variant = mixpanel.<span class="fn">getLocalFlags</span>().<span class="fn">getVariantValue</span>(
    <span class="str">"${flagKey}"</span>, <span class="str">"${fallback}"</span>, userContext
);

<span class="kw">switch</span> (variant) {
${switchCasesDQ}
  <span class="kw">default</span>:
      <span class="cm">// control / fallback experience</span>
}`;

    const exposureCode = `<span class="cm">// Exposure tracked automatically. To suppress and track manually:</span>
<span class="cm">// Use getVariant() with reportExposure=false, then trackExposureEvent()</span>
<span class="cm">// import com.mixpanel.mixpanelapi.featureflags.model.SelectedVariant;</span>
SelectedVariant variant = mixpanel.<span class="fn">getLocalFlags</span>().<span class="fn">getVariant</span>(
    <span class="str">"${flagKey}"</span>, <span class="kw">new</span> <span class="fn">SelectedVariant</span>(<span class="str">"${fallback}"</span>), userContext,
    <span class="cm">/* reportExposure= */</span> <span class="kw">false</span>
);

<span class="cm">// When feature is actually rendered:</span>
mixpanel.<span class="fn">getLocalFlags</span>().<span class="fn">trackExposureEvent</span>(<span class="str">"${flagKey}"</span>, variant, userContext);`;

    return { init: initCode, eval: evalCode, exposure: exposureCode };
  }

  return { init: '// SDK not recognised', eval: '', exposure: '' };
}

// Legacy shim so exportCodeSamples works
function generateCode(sdk, flagKey, variants, token) {
  const mode = getEvalMode(flagKey, sdk);
  const s = generateSnippets(sdk, mode, flagKey, variants, token);
  return [s.init, s.eval, s.exposure]
    .filter(Boolean)
    .join('\n\n// ─── ─── ─── ─── ─── ───\n\n');
}

// ── Export functions ──────────────────────────────────────────────────────────
function exportCSV() {
  const rows = [['Key','Value type','Source','Status','Rule type','Conditions','Dropped targeting','SDK','Eval mode','Selected for import']];
  allFlags.forEach(f => {
    const rt = flagRuleType(f);
    const rgc = f.rules.length;
    const sdkId = flagSdks[f.key]||'javascript';
    const sdk = SDKS.find(s=>s.id===sdkId)?.label||'JavaScript';
    const evalModeId = getEvalMode(f.key, sdkId);
    const evalMode = getEvalModes(sdkId).find(m=>m.id===evalModeId)?.label || evalModeId;
    rows.push([f.key, f.valueType||'', f.source, flagStatus(f), rt, rgc, (f.unsupported||[]).join('; '), sdk, evalMode, selectedKeys.has(f.key)?'Yes':'No']);
  });
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  download('firebase_remote_config_migration_report.csv', csv, 'text/csv');
}

function exportJSON() {
  const data = allFlags.map(f => ({
    key: f.key, name: f.name, source: f.source, status: flagStatus(f),
    ruleType: flagRuleType(f),
    conditions: f.rules.length,
    assignedSdk: SDKS.find(s=>s.id===(flagSdks[f.key]||'javascript'))?.label||'JavaScript',
    evalMode: getEvalModes(flagSdks[f.key]||'javascript').find(m=>m.id===getEvalMode(f.key,flagSdks[f.key]||'javascript'))?.label||'',
    selectedForImport: selectedKeys.has(f.key),
  }));
  download('firebase_remote_config_migration_report.json', JSON.stringify({ generatedAt: new Date().toISOString(), totalItems: allFlags.length, selectedForImport: selectedKeys.size, flags: data }, null, 2), 'application/json');
}

function exportMarkdown() {
  let md = `# Firebase Remote Config → Mixpanel Migration Report\n\n`;
  md += `**Generated:** ${new Date().toLocaleString()}  \n`;
  md += `**Total items:** ${allFlags.length}  \n`;
  md += `**Selected for import:** ${selectedKeys.size}  \n\n`;
  md += `| Key | Name | Source | Status | Rule type | SDK | Import |\n`;
  md += `|-----|------|--------|--------|-----------|-----|--------|\n`;
  allFlags.forEach(f => {
    const rt = flagRuleType(f);
    const sdk = SDKS.find(s=>s.id===(flagSdks[f.key]||'javascript'))?.label||'JavaScript';
    md += `| \`${f.key}\` | ${f.name||'—'} | ${f.source} | ${flagStatus(f)} | ${rt} | ${sdk} | ${selectedKeys.has(f.key)?'✓':'—'} |\n`;
  });
  download('firebase_remote_config_migration_report.md', md, 'text/markdown');
}

function exportCodeSamples() {
  const token = v('mp-token') || 'YOUR_PROJECT_TOKEN';
  const selected = allFlags.filter(f => selectedKeys.has(f.key));
  let md = `# Mixpanel Feature Flag Code Samples\n\n`;
  md += `**Generated:** ${new Date().toLocaleString()}  \n`;
  md += `**Project token:** \`${token}\`  \n\n---\n\n`;
  selected.forEach(f => {
    const sdk = flagSdks[f.key] || 'javascript';
    const sdkLabel = SDKS.find(s=>s.id===sdk)?.label||sdk;
    const variants = buildVariantNames(f);
    const rawCode = generateCode(sdk, f.key, variants, token).replace(/<[^>]+>/g, '');
    const lang = { javascript:'javascript', nodejs:'javascript', python:'python', swift:'swift', android:'java', reactnative:'javascript', flutter:'dart', go:'go', ruby:'ruby', java:'java' }[sdk]||'';
    md += `## \`${f.key}\`\n\n**Source:** ${f.source}  \n**SDK:** ${sdkLabel}  \n**Rule type:** ${flagRuleType(f)}  \n\n\`\`\`${lang}\n${rawCode}\n\`\`\`\n\n---\n\n`;
  });
  download('mixpanel_flag_code_samples.md', md, 'text/markdown');
}

function copyCode(id) {
  const raw = el(id).innerText;
  navigator.clipboard.writeText(raw);
}

function download(filename, content, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename; a.click();
}

// ── Import ────────────────────────────────────────────────────────────────────
async function runImport() {
  const cfg = getCfg();
  const btn = el('btn-run'); btn.disabled = true;
  const selected = allFlags.filter(f => selectedKeys.has(f.key));
  let skipped=0, flagOk=0, fail=0;

  el('s-total').textContent = selected.length;
  el('import-log').innerHTML = '';
  el('progress-bar').style.width = '0%';

  const mpDomain = cfg.mpRegion === 'us' ? 'mixpanel.com' : `${cfg.mpRegion}.mixpanel.com`;

  for (let i = 0; i < selected.length; i++) {
    const flag = selected[i];
    log(`→ ${flag.key} (${flag.source}, ${flag.valueType})`, 'info');

    // Log the raw Firebase parameter - FULL JSON
    log(`   📥 FIREBASE PARAMETER (full):`, 'info');
    const fbJson = JSON.stringify(flag, null, 2);
    console.log('===== FIREBASE PARAMETER DATA (FULL) =====\n' + fbJson);
    // Split into chunks for the UI log
    fbJson.split('\n').forEach(line => log(`   ${line}`, 'info'));

    if (flag.unsupported && flag.unsupported.length) {
      log(`   ⚠ Dropped targeting (no Mixpanel equivalent): ${flag.unsupported.join(', ')}`, 'warn');
    }

    const flagP = buildFlagPayload(flag, cfg);
    log(`   📤 FLAG PAYLOAD (full):`, 'info');
    const flagJson = JSON.stringify(flagP, null, 2);
    console.log('===== FLAG PAYLOAD (FULL) =====\n' + flagJson);
    flagJson.split('\n').forEach(line => log(`   ${line}`, 'info'));

    if (cfg.dryRun) { log(`   [DRY RUN] flag: ${flag.key}`, 'warn'); flagOk++; }
    else {
      const res = await fetch(`https://${mpDomain}/api/app/projects/${cfg.mpProject}/workspaces/${cfg.mpWorkspace}/feature-flags`, { method:'POST', headers:authHeaders(), body:JSON.stringify(flagP) });
      const body = await res.json().catch(()=>({}));
      if (res.ok) { log(`   ✓ Flag created`, 'ok'); flagOk++; }
      else if (res.status===409) { log(`   ⏭ Skipped (already exists)`, 'warn'); skipped++; }
      else {
        log(`   ✗ Failed: ${body?.error??body?.message??'HTTP '+res.status}`, 'err');
        const errorJson = JSON.stringify(body, null, 2);
        console.error('===== API ERROR RESPONSE =====\n' + errorJson);
        log(`   ERROR DETAILS:`, 'err');
        errorJson.split('\n').forEach(line => log(`   ${line}`, 'err'));
        fail++;
      }
      await sleep(120);
    }

    el('s-exp').textContent=skipped; el('s-flag').textContent=flagOk; el('s-fail').textContent=fail;
    el('progress-bar').style.width = `${Math.round(((i+1)/selected.length)*100)}%`;
  }

  log(`Done — ${flagOk} flags${skipped?`, ${skipped} skipped`:''}${fail?`, ${fail} failed`:''}`, fail?'err':'ok');
  btn.disabled = false;
}

// ── Payload builders ──────────────────────────────────────────────────────────

// Firebase Remote Config has no Statsig-style ID type — assignment is always
// keyed on the Mixpanel distinct_id.
function getContext() {
  return 'distinct_id';
}

function buildRuleset(flag) {
  const treatments = buildVariantNames(flag);  // [{ mpKey, sourceKey, name }]
  const totalV = 1 + treatments.length;
  const even = parseFloat((1/totalV).toFixed(6));

  // Control carries the parameter's default value; the treatment carries the
  // conditional value when the parameter has one. Unlike the Statsig tool — which
  // has no distinct conditional value and so duplicates the default on both sides
  // — Firebase gives us a real second value, so the variants actually differ.
  const isGate = flag.source === 'gate';
  const hasConditional = flag.conditionalValue !== undefined;

  let controlValue, treatmentValue;
  if (isGate) {
    // Boolean parameter → control is "off", treatment is "on".
    controlValue = false;
    treatmentValue = true;
  } else {
    controlValue = flag.defaultValue ?? null;
    treatmentValue = hasConditional ? flag.conditionalValue : (flag.defaultValue ?? null);
  }

  const variants = [
    { key:'control', value:controlValue, is_control:true, is_sticky:false, split:even, description:'Control — Migrated from Firebase Remote Config (default value)' },
    ...treatments.map(t => ({
      key:t.mpKey,
      value: treatmentValue,
      is_control:false,
      is_sticky:false,
      split:even,
      description:`Treatment — Migrated from Firebase Remote Config. Source: ${t.sourceKey}`
    })),
  ];

  // Rollout percentage — only Firebase's `percent` condition rule survives.
  // Everything else (OS, country, user property, audience…) is dropped and
  // reported in the Export step.
  //
  // When there is no usable percent condition we must fall back to "serve the
  // Firebase default to everyone", NOT to a blanket 100% rollout of the
  // treatment. A parameter targeted at, say, Android only would otherwise have
  // its conditional value served to the whole population — the opposite of
  // Firebase, where non-matching users receive the default.
  let rolloutPct;
  if (!flag.enabled) {
    rolloutPct = 0;                                   // useInAppDefault — no backend value
  } else if (flag.allocation != null) {
    rolloutPct = Math.min(Math.max(flag.allocation, 0)/100, 1);
  } else if (isGate) {
    rolloutPct = flag.defaultValue === true ? 1 : 0;  // default true → on for everyone
  } else {
    rolloutPct = 0;                                   // everyone receives the default value
  }

  // Even split across treatment variants
  const vs = {};
  const ks = treatments.map(t => t.mpKey);
  let rem = 1.0;
  ks.forEach((k, i) => {
    const s = parseFloat((1/ks.length).toFixed(6));
    vs[k] = i === ks.length-1 ? parseFloat(rem.toFixed(6)) : s;
    rem -= s;
  });

  return {
    test: null,
    variants,
    rollout: [{
      name: null,
      runtime_evaluation_rule: null,
      runtime_event_rule: null,
      cohort_hash: null,
      variant_override: null,
      rollout_percentage: rolloutPct,
      variant_splits: vs
    }]
  };
}

function buildFlagPayload(flag, cfg) {
  const status = flagStatus(flag);
  const sdk = flagSdks[flag.key] || 'javascript';
  const servingMethod = SDKS.find(s=>s.id===sdk)?.serving || 'server';

  return {
    name: flag.name ?? flag.key,
    key: flag.key,
    description: flag.description || null,
    tags: Array.isArray(flag.tags) ? flag.tags.map(String) : [],
    status,
    data_group_id: null,
    serving_method: servingMethod,
    experiment_id: null,          // Firebase A/B Testing has no public API — no experiments migrated
    workspace_id: null,
    is_experiment_active: null,
    hash_salt: null,
    reset_hash_salt: null,
    context: getContext(),
    ruleset: buildRuleset(flag),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const el=id=>document.getElementById(id);
const v=id=>el(id)?.value?.trim()||'';
const trunc=(s,m)=>s&&s.length>m?s.slice(0,m-1)+'…':(s||'');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const esc=s=>String(s).replace(/'/g,"\\'");

function getCfg() {
  return {
    fbProject: v('fb-project'),
    fbToken: v('fb-token'),
    importGates: el('imp-gates').checked,
    importConfigs: el('imp-configs').checked,
    mpProject: v('mp-project'),
    mpWorkspace: v('mp-workspace'),
    mpRegion: v('mp-region')||'us',
    dryRun: el('dry-run').checked,
  };
}
function authHeaders() {
  return { Authorization:`Basic ${encodedAuth}`, 'Content-Type':'application/json', Accept:'application/json' };
}
function flagStatus(f) {
  // A parameter serving useInAppDefault has no backend value, so it is "off".
  return f.enabled ? 'enabled' : 'disabled';
}
function flagRuleType(f) {
  // Only a percent condition becomes a real Mixpanel rollout; other conditions
  // exist but carry no equivalent, so they show as targeted-but-not-migrated.
  if (f.allocation != null) return 'rollout';
  return (f.rules && f.rules.length) ? 'targeted' : 'plain';
}
function statusPill(f) {
  const s=flagStatus(f);
  const cls={enabled:'pill-green',disabled:'pill-neutral',archived:'pill-red'}[s]||'pill-neutral';
  return `<span class="pill ${cls}">${s}</span>`;
}
function sourcePill(f) {
  if (f.source === 'config') return '<span class="pill pill-amber">config</span>';
  return '<span class="pill pill-teal">gate</span>';
}
function ruleTypePill(t) {
  if(t==='rollout')  return '<span class="pill pill-teal">rollout</span>';
  if(t==='targeted') return '<span class="pill pill-amber">targeted</span>';
  return '<span class="pill pill-neutral">—</span>';
}
function updateNavDone(id) {
  const nav=document.querySelector(`[data-view="${id}"]`);
  if(nav){nav.classList.add('done');const sn=el(`sn-${id}`);if(sn){sn.style.background='#3BA974';sn.style.color='white';}}
}
function log(text, type='') {
  const box=el('import-log');
  const d=document.createElement('div');
  if(type) d.className=type;
  d.textContent=text;
  box.appendChild(d);
  box.scrollTop=box.scrollHeight;
}
function showErr(elem, msg) {
  elem.innerHTML=`<div class="alert alert-error">${msg}</div>`;
  elem.style.display='';
}

// ── State persistence (localStorage) ──────────────────────────────────────────
// Keeps credentials, fetched flags, selections, SDK/eval-mode choices, and the
// current step across reloads so troubleshooting doesn't require re-fetching.
const STORAGE_KEY = 'firebase_mp_migration_state_v1';   // distinct from the Statsig tool's key
const FORM_FIELDS = ['fb-project','fb-token','mp-user','mp-secret','mp-project','mp-workspace','mp-token','mp-region'];
const FORM_CHECKS = ['imp-gates','imp-configs','dry-run'];
let lastView = 'config';

function persist() {
  try {
    const form = {};
    FORM_FIELDS.forEach(id => { const n = el(id); if (n) form[id] = n.value; });
    FORM_CHECKS.forEach(id => { const n = el(id); if (n) form[id] = n.checked; });
    const state = {
      form,
      flags: allFlags.map(({ raw, ...rest }) => rest),  // drop bulky raw payloads
      selected: [...selectedKeys],
      sdks: flagSdks,
      modes: flagEvalModes,
      view: lastView,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) { /* storage full / unavailable — non-fatal */ }
}

function restoreState() {
  let state;
  try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
  catch (e) { return; }
  if (!state) return;

  const f = state.form || {};
  FORM_FIELDS.forEach(id => { const n = el(id); if (n && f[id] != null) n.value = f[id]; });
  FORM_CHECKS.forEach(id => { const n = el(id); if (n && f[id] != null) n.checked = f[id]; });
  updateAuth();

  if (Array.isArray(state.flags) && state.flags.length) {
    allFlags = state.flags;
    selectedKeys = new Set(state.selected || []);
    flagSdks = state.sdks || {};
    flagEvalModes = state.modes || {};
    renderTable();
    updateNavDone('config');
    const banner = el('restore-banner');
    if (banner) banner.style.display = '';
  }
  if (state.view) goTo(state.view);
}

function clearSaved() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  location.reload();
}

// Attach persistence listeners, then restore any prior session.
[...FORM_FIELDS, ...FORM_CHECKS].forEach(id => {
  const node = el(id);
  if (!node) return;
  const ev = (node.tagName === 'SELECT' || node.type === 'checkbox') ? 'change' : 'input';
  node.addEventListener(ev, persist);
});
restoreState();
