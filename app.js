// Explorer UI. Four steps, same flow as The Argument's: pick data, build groups,
// pick questions, run. State is a plain object so import/export config is trivial.

const state = {
  dataset: null,
  includeTotal: true,
  groups: [],
  questions: [],
  meta: null,
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

// ── Combobox ───────────────────────────────────────────────────────────
// A native <select> truncates long question wordings and leaves no room for the
// variable name beside them, which is what makes a list of 300 questions
// navigable. This is the pattern The Argument uses: type to filter, each row
// showing the variable and its wording, with a count of what you are searching.
const COMBO_LIMIT = 50;

function combobox(mount, { items, placeholder, selected, onSelect }) {
  mount.innerHTML = "";
  mount.className = "combo";

  const chosen = selected && items.find((i) => i.value === selected);
  if (chosen) {
    const box = el("div", "combo-chosen");
    box.appendChild(el("span", "name", chosen.name));
    box.appendChild(el("span", "desc", chosen.description || ""));
    const change = el("span", "change", "change");
    change.onclick = () => combobox(mount, { items, placeholder, onSelect });
    box.appendChild(change);
    mount.appendChild(box);
    return;
  }

  const input = el("input", "combo-input");
  input.type = "search";
  input.placeholder = placeholder;
  const panel = el("div", "combo-panel");
  mount.append(input, panel);

  let active = -1;

  function matches() {
    const term = input.value.trim().toLowerCase();
    if (!term) return items;
    return items.filter(
      (i) => i.name.toLowerCase().includes(term) ||
             (i.description || "").toLowerCase().includes(term)
    );
  }

  function render() {
    const found = matches();
    const shown = found.slice(0, COMBO_LIMIT);
    panel.innerHTML = "";
    active = -1;

    if (!found.length) {
      panel.appendChild(el("div", "combo-empty", "No columns match that search."));
    } else {
      const note = found.length > shown.length
        ? `Type to search ${found.length} columns (showing first ${shown.length})`
        : `${found.length} column${found.length === 1 ? "" : "s"}`;
      panel.appendChild(el("div", "combo-count", note));
      shown.forEach((item, index) => {
        const row = el("div", "combo-item");
        row.appendChild(el("span", "name", item.name));
        if (item.description && item.description !== item.name) {
          row.appendChild(el("span", "desc", item.description));
        }
        row.onmousedown = (event) => { event.preventDefault(); choose(item); };
        row.onmouseenter = () => { setActive(index); };
        panel.appendChild(row);
      });
    }
    panel.classList.add("open");
  }

  function rows() { return [...panel.querySelectorAll(".combo-item")]; }
  function setActive(index) {
    rows().forEach((r, i) => r.classList.toggle("active", i === index));
    active = index;
  }
  function choose(item) {
    panel.classList.remove("open");
    onSelect(item);
  }

  input.addEventListener("focus", render);
  input.addEventListener("input", render);
  input.addEventListener("keydown", (event) => {
    const list = rows();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!list.length) return;
      const next = event.key === "ArrowDown"
        ? Math.min(active + 1, list.length - 1)
        : Math.max(active - 1, 0);
      setActive(next);
      list[next].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const found = matches().slice(0, COMBO_LIMIT);
      if (found[active >= 0 ? active : 0]) choose(found[active >= 0 ? active : 0]);
    } else if (event.key === "Escape") {
      panel.classList.remove("open");
    }
  });
  input.addEventListener("blur", () => setTimeout(() => panel.classList.remove("open"), 120));
}

// ── Buckets ────────────────────────────────────────────────────────────
// A bucket is one row of a crosstab, or one column of it: a label and the raw
// values that fall under it. Two things follow from that, and both are things
// The Argument's explorer lets you do and a static report cannot. Buckets can be
// reordered, so "Strongly approve … Strongly disapprove" reads in scale order
// rather than in whatever order the codes happen to arrive. And buckets can be
// merged, so "Strongly approve" and "Somewhat approve" collapse into "Approve"
// and the net is computed on the weights rather than by adding two rounded
// percentages together.
//
// Drag starts from the handle only, so selecting text in the label still works.

function bucketLabelFor(values) {
  return values.join(" / ");
}

function enableDragReorder(container, onReorder) {
  let dragging = null;

  container.addEventListener("dragstart", (event) => {
    const bucket = event.target.closest(".bucket");
    if (!bucket || bucket.parentElement !== container) return;
    dragging = bucket;
    bucket.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    // Firefox ignores a drag that carries no payload.
    try { event.dataTransfer.setData("text/plain", ""); } catch (e) { /* ignore */ }
  });

  container.addEventListener("dragover", (event) => {
    if (!dragging) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const target = event.target.closest(".bucket");
    if (!target || target === dragging || target.parentElement !== container) return;
    const rect = target.getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) container.insertBefore(dragging, target);
    else container.insertBefore(dragging, target.nextSibling);
  });

  container.addEventListener("drop", (event) => event.preventDefault());

  container.addEventListener("dragend", () => {
    if (!dragging) return;
    dragging.classList.remove("dragging");
    dragging.draggable = false;
    dragging = null;
    onReorder();
  });
}

/**
 * Editable buckets over `allValues`, mutating `buckets` in place.
 * buckets: [{ label, values: [...], auto }]  — `auto` means the label still
 * tracks the values, so merging renames the bucket until someone types over it.
 */
function bucketEditor(mount, { allValues, buckets, placeholder, counts, onChange }) {
  mount.innerHTML = "";
  mount.className = "bucket-editor";

  const list = el("div", "bucket-list");
  // Read the order back out of the DOM: the drag moved nodes, not array entries.
  enableDragReorder(list, () => {
    const moved = [...list.children].map((node) => node._bucket);
    buckets.length = 0;
    buckets.push(...moved);
    draw();
    onChange();
  });

  function draw() {
    list.innerHTML = "";
    buckets.forEach((bucket, index) => list.appendChild(drawBucket(bucket, index)));
  }

  function drawBucket(bucket, index) {
    const box = el("div", "bucket");
    box._bucket = bucket;

    const head = el("div", "bucket-head");

    const handle = el("span", "drag-handle", "≡");
    handle.title = "Drag to reorder";
    handle.addEventListener("mousedown", () => {
      box.draggable = true;
      // Released without dragging — and not necessarily over the handle, so the
      // listener goes on the document rather than on the button.
      document.addEventListener("mouseup", () => { box.draggable = false; }, { once: true });
    });
    head.appendChild(handle);

    const label = el("input", "bucket-label-input");
    label.type = "text";
    label.placeholder = placeholder;
    label.value = bucket.label;
    label.addEventListener("input", () => {
      bucket.label = label.value;
      bucket.auto = false;      // hand-written from here on
      onChange();
    });
    head.appendChild(label);

    const merge = el("button", "btn small", "Merge up");
    merge.type = "button";
    merge.title = "Fold this bucket into the one above it";
    merge.disabled = index === 0;
    merge.onclick = () => {
      const above = buckets[index - 1];
      for (const value of bucket.values) {
        if (!above.values.includes(value)) above.values.push(value);
      }
      if (above.auto) above.label = bucketLabelFor(above.values);
      buckets.splice(index, 1);
      draw();
      onChange();
    };
    head.appendChild(merge);

    const remove = el("button", "btn small danger icon-btn", "×");
    remove.type = "button";
    remove.title = "Remove bucket";
    remove.onclick = () => { buckets.splice(index, 1); draw(); onChange(); };
    head.appendChild(remove);

    box.appendChild(head);

    const checks = el("div", "bucket-values");
    for (const { value, n } of allValues) {
      const item = el("label", "bucket-value");
      const box_ = el("input");
      box_.type = "checkbox";
      box_.checked = bucket.values.includes(value);
      box_.addEventListener("change", () => {
        if (box_.checked) {
          if (!bucket.values.includes(value)) bucket.values.push(value);
        } else {
          bucket.values = bucket.values.filter((v) => v !== value);
        }
        if (bucket.auto) {
          bucket.label = bucketLabelFor(bucket.values);
          label.value = bucket.label;
        }
        onChange();
      });
      item.appendChild(box_);
      item.appendChild(document.createTextNode(
        counts === false ? ` ${value}` : ` ${value} (${n.toLocaleString()})`
      ));
      checks.appendChild(item);
    }
    box.appendChild(checks);
    return box;
  }

  draw();
  mount.appendChild(list);

  const actions = el("div", "bucket-actions");

  const add = el("button", "btn small", "+ Add bucket");
  add.type = "button";
  add.onclick = () => {
    buckets.push({ label: "", values: [], auto: true });
    draw();
    onChange();
  };
  actions.appendChild(add);

  const reset = el("button", "btn small", "Reset to one per value");
  reset.type = "button";
  reset.onclick = () => {
    buckets.length = 0;
    buckets.push(...seedBuckets(allValues));
    draw();
    onChange();
  };
  actions.appendChild(reset);

  const clear = el("button", "btn small", "Clear");
  clear.type = "button";
  clear.onclick = () => { buckets.length = 0; draw(); onChange(); };
  actions.appendChild(clear);

  actions.appendChild(el("span", "hint bucket-hint",
    "Drag ≡ to reorder · “Merge up” folds a bucket into the one above · "
    + "tick values to move them between buckets"));
  mount.appendChild(actions);
}

/** One bucket per value — the default, and what the report itself shows. */
function seedBuckets(allValues) {
  return allValues.map(({ value }) => ({ label: value, values: [value], auto: true }));
}

/** Labels have to be unique and non-empty: the crosstab keys its rows on them. */
function usableBuckets(buckets) {
  const seen = new Set();
  const out = [];
  for (const bucket of buckets) {
    if (!bucket.values.length) continue;
    let label = (bucket.label || "").trim() || bucketLabelFor(bucket.values);
    if (seen.has(label)) {
      let n = 2;
      while (seen.has(`${label} (${n})`)) n += 1;
      label = `${label} (${n})`;
    }
    seen.add(label);
    out.push({ label, values: bucket.values.slice() });
  }
  return out;
}

function setStepEnabled(id, enabled) {
  $(id).classList.toggle("disabled", !enabled);
}

function refreshSteps() {
  setStepEnabled("step-2", !!state.dataset);
  setStepEnabled("step-3", !!state.dataset);
  setStepEnabled("step-4", !!state.dataset && state.questions.length > 0);
}

// ── Footnote: the same sample description the reports carry ────────────
function renderFootnote() {
  const m = state.meta;
  if (!m) return;
  const moe = m.moe_national ? `±${m.moe_national}` : null;
  const youthMoe = m.moe_youth ? `±${m.moe_youth}` : null;
  $("footnote").textContent =
    `${m.label}. Registered voters (n=${m.n.toLocaleString()}), of whom ` +
    `${m.n_youth.toLocaleString()} are aged 18–34. ` +
    (moe ? `Design-effect-adjusted 95% margin of error ${moe} points nationally` +
           (youthMoe ? `, ${youthMoe} on the youth sample. ` : ". ") : "") +
    `Weighted to the Catalist voter file by age interacted with gender, race, and ` +
    `education; columns confined to 18–34 use the youth weight. ` +
    `Subgroups below 100 respondents are suppressed.`;
}

// ── Step 1 ─────────────────────────────────────────────────────────────
async function initDatasets() {
  const datasets = await getDatasets();
  const select = $("dataset-select");
  for (const d of datasets) {
    const option = el("option", null, `${d.label} (n=${d.n.toLocaleString()})`);
    option.value = d.id;
    select.appendChild(option);
  }
  select.addEventListener("change", async () => {
    state.dataset = select.value || null;
    state.meta = datasets.find((d) => d.id === state.dataset) || null;
    state.groups = [];
    state.questions = [];
    if (state.dataset) {
      $("dataset-status").textContent = "loading…";
      await loadDataset(state.dataset);
      $("dataset-status").textContent = "ready";
      await refreshQuestionPicker();
    }
    renderGroups();
    renderQuestions();
    renderFootnote();
    refreshSteps();
  });

  $("include-total").addEventListener("change", (e) => {
    state.includeTotal = e.target.checked;
  });
}

// ── Step 2: groups ─────────────────────────────────────────────────────
function renderGroups() {
  const box = $("groups-container");
  box.innerHTML = "";
  state.groups.forEach((group, gi) => {
    const card = el("div", "group-card");
    const header = el("div", "group-header");
    const name = el("input");
    name.type = "text";
    name.value = group.label;
    name.placeholder = "Group name";
    name.addEventListener("input", () => { group.label = name.value; });
    header.appendChild(name);
    const remove = el("button", "btn small danger", "Remove");
    remove.onclick = () => { state.groups.splice(gi, 1); renderGroups(); };
    header.appendChild(remove);
    card.appendChild(header);

    group.subgroups.forEach((sub, si) => {
      const wrap = el("div", "subgroup");
      wrap.appendChild(el("p", "hint", "Subgroup dimension"));

      const picker = el("div");
      combobox(picker, {
        items: (state.groupColumns || []).map((c) => ({
          value: c.column, name: c.name, description: c.description,
        })),
        placeholder: "Search group columns\u2026",
        selected: sub.column || null,
        onSelect: async (item) => {
          sub.column = item.value;
          sub.values = await getValues(state.dataset, sub.column);
          // Seeded with every value, which is the banner the report would print.
          sub.answers = seedBuckets(sub.values);
          renderGroups();
        },
      });
      wrap.appendChild(picker);

      if (sub.values && sub.values.length) {
        const buckets = el("div");
        bucketEditor(buckets, {
          allValues: sub.values,
          buckets: sub.answers,
          placeholder: "Column name",
          onChange: () => {},
        });
        wrap.appendChild(buckets);
      }

      const drop = el("button", "btn small danger", "Remove variable");
      drop.onclick = () => { group.subgroups.splice(si, 1); renderGroups(); };
      wrap.appendChild(drop);
      card.appendChild(wrap);
    });

    const add = el("button", "btn small", "+ Add variable to this group");
    add.onclick = () => {
      group.subgroups.push({ column: "", answers: [], values: [] });
      renderGroups();
    };
    card.appendChild(add);
    box.appendChild(card);
  });
}

// ── Step 3: questions ──────────────────────────────────────────────────
async function refreshQuestionPicker() {
  state.availableQuestions = await getQuestions(state.dataset);
  state.groupColumns = await getGroupColumns(state.dataset);
  populateQuestionSelect();
  renderGroups();
}

function populateQuestionSelect() {
  combobox($("question-picker"), {
    items: (state.availableQuestions || []).map((q) => ({
      value: q.name, name: q.name, description: q.description,
    })),
    placeholder: "Search questions\u2026",
    onSelect: async (item) => {
      if (!state.questions.some((q) => q.name === item.value)) {
        const question = (state.availableQuestions || []).find((q) => q.name === item.value);
        if (question) {
          const values = await getValues(state.dataset, question.column);
          state.questions.push({ ...question, values, responses: seedBuckets(values) });
        }
        renderQuestions();
        refreshSteps();
      }
      populateQuestionSelect();   // reset the field for the next pick
    },
  });
}

function renderQuestions() {
  const box = $("questions-container");
  box.innerHTML = "";
  state.questions.forEach((question, index) => {
    const card = el("div", "question-card");
    const header = el("div", "question-header");
    header.appendChild(el("span", "question-title", question.name));
    const remove = el("button", "btn small danger", "Remove");
    remove.onclick = () => { state.questions.splice(index, 1); renderQuestions(); refreshSteps(); };
    header.appendChild(remove);
    card.appendChild(header);
    card.appendChild(el("p", "question-wording", question.description));

    if (question.values && question.values.length) {
      const buckets = el("div");
      bucketEditor(buckets, {
        allValues: question.values,
        buckets: question.responses,
        placeholder: "Row name",
        onChange: () => {},
      });
      card.appendChild(buckets);
    }
    box.appendChild(card);
  });
}

// ── Step 4: results ────────────────────────────────────────────────────
function renderResults(results) {
  const box = $("results-container");
  box.innerHTML = "";
  for (const [name, result] of Object.entries(results)) {
    const block = el("div", "result-block");
    block.appendChild(el("h3", null, result.description));
    // Which weight a column took is a fact about the estimate, so it is stated
    // rather than left to the reader to infer from the column name.
    const youth = result.columns.filter((c) => result.weights[c] === "weight_youth");
    block.appendChild(el("p", "result-note", youth.length
      ? `${name} · ${YOUTH_MARK} columns are weighted to the 18–34 universe; `
        + `the rest to the national one, so they need not sum to Total`
      : `${name} · weighted to the national universe`));

    const table = el("table");
    const thead = el("thead");
    const headRow = el("tr");
    headRow.appendChild(el("th", null, "Response"));
    for (const column of result.columns) {
      headRow.appendChild(el("th", null,
        result.weights[column] === "weight_youth" ? `${column} ${YOUTH_MARK}` : column));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el("tbody");
    for (const response of result.responses) {
      const tr = el("tr");
      tr.appendChild(el("td", null, response));
      for (const column of result.columns) {
        const value = result.cells[response][column];
        const td = el("td", value === null ? "suppressed" : null,
                      value === null ? "—" : `${value.toFixed(1)}%`);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    const nRow = el("tr", "n-row");
    nRow.appendChild(el("td", null, "Unweighted N"));
    for (const column of result.columns) {
      nRow.appendChild(el("td", null, `(${result.counts[column].toLocaleString()})`));
    }
    tbody.appendChild(nRow);
    table.appendChild(tbody);
    const scroller = el("div", "table-scroll");
    scroller.appendChild(table);
    block.appendChild(scroller);
    box.appendChild(block);
  }
}

function toCSV(results) {
  const lines = [];
  for (const [name, result] of Object.entries(results)) {
    lines.push([name, ...result.columns].map(csvCell).join(","));
    lines.push(["Weight", ...result.columns.map((c) => result.weights[c])]
      .map(csvCell).join(","));
    for (const response of result.responses) {
      const cells = result.columns.map((c) => {
        const v = result.cells[response][c];
        return v === null ? "" : v.toFixed(2);
      });
      lines.push([response, ...cells].map(csvCell).join(","));
    }
    lines.push(["Unweighted N", ...result.columns.map((c) => result.counts[c])]
      .map(csvCell).join(","));
    lines.push("");
  }
  return lines.join("\n");
}
const csvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;
// Marks a column estimated on the youth universe rather than the national one.
const YOUTH_MARK = "\u2020";

// ── Wiring ─────────────────────────────────────────────────────────────
function init() {
  initDatasets();

  $("add-group-btn").onclick = () => {
    state.groups.push({ label: `Group ${state.groups.length + 1}`, subgroups: [] });
    renderGroups();
  };
  $("run-btn").onclick = async () => {
    $("run-btn").disabled = true;
    $("run-btn").textContent = "Running…";
    try {
      // Buckets are normalised at the edge: empty ones dropped, labels made
      // unique, so the engine never has to think about a half-edited bucket.
      const groups = state.groups
        .map((g) => ({
          ...g,
          subgroups: g.subgroups
            .map((s) => ({ ...s, answers: usableBuckets(s.answers || []) }))
            .filter((s) => s.column && s.answers.length),
        }))
        .filter((g) => g.subgroups.length);
      const questions = state.questions.map((q) => ({
        ...q, responses: usableBuckets(q.responses || []),
      }));
      const results = await runAnalysis(
        state.dataset, questions, groups, state.includeTotal
      );
      renderResults(results);
      state.lastResults = results;
      $("export-csv-btn").style.display = "";
    } finally {
      $("run-btn").disabled = false;
      $("run-btn").textContent = "Run analysis";
    }
  };

  $("export-csv-btn").onclick = () => {
    const blob = new Blob([toCSV(state.lastResults)], { type: "text/csv" });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = `yyp_crosstab_${state.dataset}.csv`;
    a.click();
  };

  $("export-config-btn").onclick = () => {
    // Bucket labels and order are most of the work, so the config carries them.
    const config = {
      dataset: state.dataset,
      includeTotal: state.includeTotal,
      groups: state.groups,
      questions: state.questions.map((q) => ({ name: q.name, responses: q.responses })),
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = "yyp_explorer_config.json";
    a.click();
  };

  $("import-config-btn").onclick = () => $("import-config-file").click();
  $("import-config-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const config = JSON.parse(await file.text());
    $("dataset-select").value = config.dataset;
    $("dataset-select").dispatchEvent(new Event("change"));
    setTimeout(async () => {
      state.includeTotal = config.includeTotal !== false;
      state.groups = config.groups || [];
      // Rebuild each subgroup's value list from the data rather than trusting the
      // file, and accept the pre-bucket `choices` spelling from older configs.
      for (const group of state.groups) {
        for (const sub of group.subgroups || []) {
          if (!sub.column) continue;
          sub.values = await getValues(state.dataset, sub.column);
          sub.answers = (sub.answers || []).map((a) => ({
            label: a.label || "", values: a.values || a.choices || [], auto: !!a.auto,
          }));
          if (!sub.answers.length) sub.answers = seedBuckets(sub.values);
        }
      }
      // Older configs list question names; newer ones carry their buckets too.
      const wanted = (config.questions || [])
        .map((q) => (typeof q === "string" ? { name: q, responses: null } : q));
      state.questions = [];
      for (const entry of wanted) {
        const question = (state.availableQuestions || []).find((q) => q.name === entry.name);
        if (!question) continue;
        const values = await getValues(state.dataset, question.column);
        state.questions.push({
          ...question, values,
          responses: entry.responses && entry.responses.length
            ? entry.responses : seedBuckets(values),
        });
      }
      renderGroups();
      renderQuestions();
      renderFootnote();
      refreshSteps();
    }, 600);
  });

  refreshSteps();
}

init();
