// Crosstab maths, in the browser. Ported from The Argument's data-engine.js with
// one change that matters: this pipeline produces two weights, and which one a
// column needs is a property of the column, not a setting.
//
// The house rule, the same one the PDF applies: a column whose respondents all
// fall inside the youth universe is estimated with `weight_youth`; every other
// column uses `weight_national`. "18-22" and "Female/23-29" get the youth weight,
// "Female" and "Total" do not. That is decided from the rows a column actually
// contains rather than from its label, so it holds for crossed groups and for
// whatever a future wave calls its age bands.
//
// Because `weight_youth` is null for everyone 35 and over, a column's test is
// simply whether every row in it carries one. A mixed table therefore shows youth
// columns estimated on the youth margin beside national columns estimated on the
// national one; they will not sum to Total exactly, which is the point.
//
// Values stay strings, matching how the CSV stores them.

const DATASETS = fetch("datasets.json").then((r) => r.json());
const _cache = {};
const _descriptions = {};
const _order = {};

const MIN_SUBGROUP_N = 100;
const NATIONAL_WEIGHT = "weight_national";
const YOUTH_WEIGHT = "weight_youth";

// Columns that are machinery rather than survey answers.
const HIDDEN = new Set([
  "case_id", "weight_national", "weight_youth", "over_18", "consent_q", "us_voter",
  "age_gender", "binary_race_gender", "binary_race_education", "attention_check",
]);
const HIDDEN_RE = /^ces_race_\d+$|_text$/;

async function getOrder(id) {
  if (_order[id]) return _order[id];
  let out = {};
  try {
    const res = await fetch(`data/${encodeURIComponent(id)}.order.json`);
    if (res.ok) out = await res.json();
  } catch (e) { out = {}; }
  _order[id] = out;
  return out;
}

function isMissing(v) {
  return v === undefined || v === null || v === "" || v === "NA";
}

function weightOf(row, weightColumn) {
  const raw = row[weightColumn];
  if (isMissing(raw)) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** The house rule: youth weight iff every respondent in the slice has one. */
function weightForSlice(rows) {
  if (!rows.length) return NATIONAL_WEIGHT;
  return rows.every((r) => weightOf(r, YOUTH_WEIGHT) !== null)
    ? YOUTH_WEIGHT
    : NATIONAL_WEIGHT;
}

async function getDatasets() {
  return DATASETS;
}

async function loadDataset(id) {
  if (_cache[id]) return _cache[id];
  const res = await fetch(`data/${encodeURIComponent(id)}.csv`);
  if (!res.ok) throw new Error(`Dataset not found: ${id}`);
  const parsed = Papa.parse(await res.text(), {
    header: true, dynamicTyping: false, skipEmptyLines: true,
  });
  _cache[id] = { rows: parsed.data, columns: parsed.meta.fields || [] };
  return _cache[id];
}

async function getDescriptions(id) {
  if (_descriptions[id]) return _descriptions[id];
  let out = {};
  try {
    const res = await fetch(`data/${encodeURIComponent(id)}.descriptions.json`);
    if (res.ok) out = await res.json();
  } catch (e) { out = {}; }
  _descriptions[id] = out;
  return out;
}

// Everyone with a usable national weight — the sample the explorer works from.
// Youth respondents are inside it too; the youth weight is applied per column.
function universe(rows) {
  return rows.filter((r) => weightOf(r, NATIONAL_WEIGHT) !== null);
}

// Questions are the *_label columns — they hold the readable answer text.
async function getQuestions(id) {
  const df = await loadDataset(id);
  const descriptions = await getDescriptions(id);
  const rows = universe(df.rows);

  const out = [];
  for (const col of df.columns) {
    if (!col.endsWith("_label")) continue;
    const base = col.slice(0, -6);
    if (HIDDEN.has(base) || HIDDEN_RE.test(base)) continue;
    const values = rows.map((r) => r[col]).filter((v) => !isMissing(v));
    if (values.length < MIN_SUBGROUP_N) continue;
    out.push({
      column: col,
      name: base,
      description: descriptions[col] || descriptions[base] || base.replace(/_/g, " "),
      answered: values.length,
    });
  }
  return out.sort((a, b) => a.description.localeCompare(b.description));
}

// Any question can also serve as a grouping variable.
async function getGroupColumns(id) {
  const questions = await getQuestions(id);
  const df = await loadDataset(id);
  const rows = universe(df.rows);
  // Recoded demographics are the useful defaults, so surface them first.
  // `region` and `partisanship` exist only for waves matched to the voter file.
  const preferred = ["age_bin", "gender", "race", "education", "binary_race",
                     "region", "partisanship"];
  const extras = preferred
    .filter((c) => df.columns.includes(c))
    .map((c) => ({
      column: c, name: c, answered: rows.filter((r) => !isMissing(r[c])).length,
      description: { age_bin: "Age", gender: "Gender", race: "Race",
                     education: "Education", binary_race: "Race (White / non-white)",
                     region: "Census region",
                     partisanship: "Catalist-modelled 2024 support" }[c],
    }));
  return [...extras, ...questions];
}

/** Distinct values of a column, in questionnaire order where the codebook gives one. */
async function getValues(id, column) {
  const df = await loadDataset(id);
  const order = await getOrder(id);
  const rows = universe(df.rows);
  const seen = new Map();
  for (const r of rows) {
    const v = r[column];
    if (isMissing(v)) continue;
    seen.set(v, (seen.get(v) || 0) + 1);
  }
  const known = order[column] || [];
  // Codebook order first; anything the codebook does not know about is appended
  // in frequency order rather than dropped.
  const rest = [...seen.keys()]
    .filter((v) => !known.includes(v))
    .sort((a, b) => (seen.get(b) - seen.get(a)) || String(a).localeCompare(String(b)));
  return [...known.filter((v) => seen.has(v)), ...rest]
    .map((value) => ({ value, n: seen.get(value) }));
}

function combinations(group) {
  let combos = [{ label: "", filters: [] }];
  for (const sub of group.subgroups) {
    const next = [];
    for (const combo of combos) {
      for (const answer of sub.answers) {
        // `choices` is what configs exported before buckets were editable.
        const values = answer.values || answer.choices || [];
        next.push({
          label: combo.label ? `${combo.label}/${answer.label}` : answer.label,
          filters: [...combo.filters, { column: sub.column, choices: values }],
        });
      }
    }
    combos = next;
  }
  return combos;
}

function applyFilters(rows, filters) {
  let out = rows;
  for (const f of filters) {
    const allowed = new Set(f.choices.map(String));
    out = out.filter((r) => allowed.has(String(r[f.column])));
  }
  return out;
}

/** Returns { question: { columns, responses, cells, counts, weights } } */
async function runAnalysis(id, questions, groups, includeTotal) {
  const df = await loadDataset(id);
  const order = await getOrder(id);
  const rows = universe(df.rows);
  const results = {};

  const columns = [];
  if (includeTotal) columns.push({ label: "Total", filters: [] });
  for (const group of groups) {
    for (const combo of combinations(group)) {
      if (combo.label) columns.push({ label: combo.label, filters: combo.filters });
    }
  }

  // Each column's weight is fixed by its own universe, not by the question, so
  // the same column is estimated the same way throughout the run.
  const weights = {};
  for (const column of columns) {
    weights[column.label] = weightForSlice(applyFilters(rows, column.filters));
  }

  for (const question of questions) {
    const col = question.column;
    const answered = rows.filter((r) => !isMissing(r[col]));
    // Questionnaire order where the codebook gives one; anything unexpected in the
    // data is appended rather than dropped.
    let responses;
    if (question.responses && question.responses.length) {
      responses = question.responses;
    } else {
      const present = [...new Set(answered.map((r) => r[col]))];
      const known = order[col] || [];
      const sorted = [
        ...known.filter((v) => present.includes(v)),
        ...present.filter((v) => !known.includes(v)),
      ];
      responses = sorted.map((v) => ({ label: v, values: [v] }));
    }

    const cells = {};
    const counts = {};
    for (const column of columns) {
      const weightColumn = weights[column.label];
      const slice = applyFilters(answered, column.filters);
      counts[column.label] = slice.length;
      const total = slice.reduce((s, r) => s + weightOf(r, weightColumn), 0);
      for (const response of responses) {
        const allowed = new Set(response.values.map(String));
        // Suppressed rather than shown: below this base the number is noise.
        const value = slice.length < MIN_SUBGROUP_N || total === 0
          ? null
          : slice.filter((r) => allowed.has(String(r[col])))
                 .reduce((s, r) => s + weightOf(r, weightColumn), 0) / total * 100;
        (cells[response.label] = cells[response.label] || {})[column.label] = value;
      }
    }
    results[question.name] = {
      description: question.description,
      columns: columns.map((c) => c.label),
      responses: responses.map((r) => r.label),
      cells,
      counts,
      weights,
    };
  }
  return results;
}
