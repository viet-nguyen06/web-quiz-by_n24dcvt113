// app.js

// ===== Helpers =====
const $ = (id) => document.getElementById(id);

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Convert text: handle [img=...] and keep $$...$$ for MathJax
function renderRichText(text, getImageUrl) {
  const lines = String(text).split(/\r?\n/);
  const parts = [];

  for (const rawLine of lines) {
    const line = rawLine ?? "";

    // 1) Handle [img=...]
    const imgMatch = line.match(/\[img\s*=\s*([^\]]+)\]/i);
    if (imgMatch) {
      const path = imgMatch[1].trim();
      const url = getImageUrl(path);

      if (url) parts.push(`<div class="imgbox"><img alt="image" src="${url}"></div>`);
      else parts.push(`<div class="muted">[Thiếu ảnh: ${escapeHtml(path)}]</div>`);

      const rest = line.replace(imgMatch[0], "").trim();
      if (rest) parts.push(renderTextWithMathAsParagraph(rest));
      continue;
    }

    // 2) Normal text line (math-aware)
    parts.push(renderTextWithMathAsParagraph(line));
  }

  return parts.join("");
}

/**
 * - Nếu line chỉ có $$...$$ => render block giữ nguyên $$...$$
 * - Nếu $$...$$ nằm chung dòng với chữ => đổi thành inline \( ... \)
 */
function renderTextWithMathAsParagraph(line) {
  const trimmed = line.trim();
  const mathOnly = trimmed.match(/^\$\$([\s\S]+?)\$\$$/);

  // Case A: display math on its own line
  if (mathOnly) {
    // giữ nguyên $$...$$ để MathJax render dạng block
    return `<div>${escapeHtml(trimmed)}</div>`;
  }

  // Case B: mixed text + $$...$$ => convert $$...$$ to \( ... \)
  const chunks = line.split(/(\$\$[\s\S]+?\$\$)/g).filter(Boolean);

  let html = "";
  for (const ch of chunks) {
    const m = ch.match(/^\$\$([\s\S]+?)\$\$$/);
    if (m) {
      const inner = m[1].trim();
      html += `\\(${inner}\\)`; // inline delimiters for MathJax
    } else {
      html += escapeHtml(ch);
    }
  }

  return `<p>${html}</p>`;
}

// Parse choices block: lines starting with ## or #$
function parseChoices(choicesText) {
  const lines = String(choicesText)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const out = [];
  for (const line of lines) {
    if (line.startsWith("#$")) out.push({ text: line.slice(2).trim(), correct: true });
    else if (line.startsWith("##")) out.push({ text: line.slice(2).trim(), correct: false });
  }
  return out;
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = new Set(a), sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

// ===== State =====
let zip = null;
let blobUrlMap = new Map(); // path -> objectURL
let rawQuestions = [];
let quiz = [];
let current = 0;

// answered item format:
// { selectedIdxs:[], checked:boolean, correct:boolean, skipped?:boolean }
let answered = [];

// ===== UI refs =====
const screenPick = $("screenPick");
const screenQuiz = $("screenQuiz");
const screenResult = $("screenResult");

// Local ZIP
const zipInput = $("zipInput");
const btnLoad = $("btnLoad");
const pickHint = $("pickHint");

// Tabs
const tabLocal = $("tabLocal");
const tabLibrary = $("tabLibrary");
const panelLocal = $("panelLocal");
const panelLibrary = $("panelLibrary");

// Library grid
const packGrid = $("packGrid");
const packSearch = $("packSearch");
const packStatus = $("packStatus");

// Quiz
const quizTitleEl = $("quizTitle");
const qIndex = $("qIndex");
const qTotal = $("qTotal");
const qTypePill = $("qTypePill");
const qContent = $("qContent");
const choicesEl = $("choices");
const feedback = $("feedback");
const btnPrev = $("btnPrev");
const btnNext = $("btnNext");

// Result
const resultSummary = $("resultSummary");
const resultList = $("resultList");
const btnRetry = $("btnRetry");
const btnNew = $("btnNew");
const btnNewCorner = $("btnNewCorner");

// Progress
const progressBar = $("progressBar");
const progressText = $("progressText");
const gradedText = $("gradedText");
const totalText = $("totalText");

// ===== Packs state =====
let packs = [];

// ===== Tabs logic =====
function setPickTab(which) {
  const isLocal = which === "local";

  tabLocal?.classList.toggle("active", isLocal);
  tabLocal?.setAttribute("aria-selected", String(isLocal));

  tabLibrary?.classList.toggle("active", !isLocal);
  tabLibrary?.setAttribute("aria-selected", String(!isLocal));

  if (panelLocal) panelLocal.style.display = isLocal ? "" : "none";
  if (panelLibrary) panelLibrary.style.display = isLocal ? "none" : "";
}

tabLocal?.addEventListener("click", () => setPickTab("local"));
tabLibrary?.addEventListener("click", () => setPickTab("library"));

// ===== Progress =====
function updateProgress() {
  const total = quiz.length || 0;
  const graded = answered.filter((a) => a.checked).length;
  const pct = total ? Math.round((graded / total) * 100) : 0;

  if (totalText) totalText.textContent = String(total);
  if (gradedText) gradedText.textContent = String(graded);
  if (progressText) progressText.textContent = pct + "%";
  if (progressBar) progressBar.style.width = pct + "%";
}

// ===== Library grid render =====
function normalizeText(s) {
  return String(s || "").toLowerCase().trim();
}

function renderPackGrid(list) {
  if (!packGrid) return;

  packGrid.innerHTML = "";

  if (!list.length) {
    packGrid.innerHTML = `<div class="muted">Không có bộ nào.</div>`;
    return;
  }

  for (const p of list) {
    const chapter = p.chapter || "Chưa phân loại";
    const title = p.title || p.id || "Untitled";
    const zipUrl = String(p.zipUrl || "").trim();
    const pdfUrl = String(p.pdfUrl || "").trim();
    const meta = p.id ? String(p.id) : "";

    const card = document.createElement("div");
    card.className = "pack-card";

    card.innerHTML = `
      <div class="top">
        <div style="min-width:0;">
          <div class="title">${escapeHtml(title)}</div>
          ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : `<div class="meta">&nbsp;</div>`}
        </div>
        <div class="chapter">${escapeHtml(chapter)}</div>
      </div>

      <div class="actions">
        <button class="btn" ${zipUrl ? "" : "disabled"} data-action="play">Play</button>
        ${pdfUrl ? `<a class="btn secondary" href="${escapeHtml(pdfUrl)}" target="_blank" style="text-decoration:none;">PDF</a>` : ""}
      </div>
    `;

    const playBtn = card.querySelector('button[data-action="play"]');
    playBtn?.addEventListener("click", async () => {
      try {
        if (!zipUrl) return;
        if (quizTitleEl) quizTitleEl.textContent = title;
        await loadZipFromUrl(zipUrl);
        startNewAttempt();
        showQuiz();
      } catch (e) {
        alert("Không mở được ZIP từ link: " + (e?.message || e));
        console.error(e);
      }
    });

    packGrid.appendChild(card);
  }
}

function applyPackFilter() {
  const q = normalizeText(packSearch?.value || "");
  if (!q) return renderPackGrid(packs);

  const filtered = packs.filter((p) => {
    const hay = [p.id, p.chapter, p.title].map(normalizeText).join(" ");
    return hay.includes(q);
  });
  renderPackGrid(filtered);
}

packSearch?.addEventListener("input", applyPackFilter);

// ===== Load packs/index.json =====
async function loadPackIndex() {
  try {
    if (packStatus) packStatus.textContent = "Đang tải danh sách…";

    const res = await fetch("packs/index.json?ts=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);

    const data = await res.json();
    packs = Array.isArray(data.packs) ? data.packs : [];

    if (packStatus) {
      packStatus.textContent = packs.length ? `Đã tải ${packs.length} bộ` : "packs/index.json rỗng";
    }

    renderPackGrid(packs);
  } catch (e) {
    console.warn("Không load được packs/index.json:", e);
    if (packStatus) packStatus.textContent = "Không tải được packs/index.json (vẫn dùng ZIP thủ công).";
    if (packGrid) packGrid.innerHTML = `<div class="muted">Không tải được thư viện.</div>`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadPackIndex();
});

// ===== Events: Local ZIP =====
zipInput?.addEventListener("change", () => {
  btnLoad.disabled = !zipInput.files?.length;
  if (pickHint) pickHint.textContent = zipInput.files?.length ? zipInput.files[0].name : "";
});

btnLoad?.addEventListener("click", async () => {
  try {
    await loadZip(zipInput.files[0]);
    if (quizTitleEl) quizTitleEl.textContent = "Bộ câu hỏi (ZIP local)";
    startNewAttempt();
    showQuiz();
  } catch (e) {
    alert("Không mở được ZIP: " + (e?.message || e));
    console.error(e);
  }
});

// ===== Quiz navigation =====
btnPrev?.addEventListener("click", () => {
  if (current > 0) {
    current--;
    renderQuestion();
  }
});

btnNext?.addEventListener("click", () => {
  const q = quiz[current];

  if (!answered[current].checked) {
    const selectedIdxs = getSelectedIdxsSingle();
    if (selectedIdxs.length === 0) {
      alert("Bạn chưa chọn đáp án.");
      return;
    }

    const correct = sameSet(selectedIdxs, q.correctIdxs);
    answered[current] = { selectedIdxs, checked: true, correct, skipped: false };

    applyMarking(q, answered[current]);
    updateProgress();

    if (current === quiz.length - 1) showResult();
    return;
  }

  if (current < quiz.length - 1) {
    current++;
    renderQuestion();
  } else {
    showResult();
  }
});

btnRetry?.addEventListener("click", () => {
  startNewAttempt();
  showQuiz();
});

btnNew?.addEventListener("click", () => {
  resetToPick();
});

btnNewCorner?.addEventListener("click", () => {
  if (!confirm("Bạn muốn chọn bộ câu hỏi (ZIP) khác? Tiến độ hiện tại sẽ bị reset.")) return;
  resetToPick();
});

// ===== ZIP core =====
async function loadZipFromArrayBuffer(ab) {
  cleanupUrls();

  zip = await JSZip.loadAsync(ab);

  const qFile = zip.file("questions.yaml") || zip.file("questions.yml");
  if (!qFile) throw new Error("Không tìm thấy questions.yaml (hoặc questions.yml) trong ZIP.");

  const yamlText = await qFile.async("string");
  const data = jsyaml.load(yamlText);

  if (!data || !Array.isArray(data.questions)) {
    throw new Error("YAML không đúng cấu trúc: cần có key 'questions:' là mảng.");
  }

  blobUrlMap = new Map();
  const entries = Object.values(zip.files);
  for (const f of entries) {
    if (f.dir) continue;
    const name = f.name;
    if (name.toLowerCase().endsWith(".yaml") || name.toLowerCase().endsWith(".yml")) continue;
    const blob = await f.async("blob");
    blobUrlMap.set(name, URL.createObjectURL(blob));
  }

  rawQuestions = data.questions.map((q, idx) => {
    if (!q.id) q.id = idx + 1;
    const t = String(q.type || "").toLowerCase();
    if (!t || !["multi", "truefalse"].includes(t)) {
      throw new Error(`Câu id=${q.id}: type phải là 'multi' hoặc 'truefalse'.`);
    }
    if (!q.content || !q.choices) {
      throw new Error(`Câu id=${q.id}: thiếu 'content' hoặc 'choices'.`);
    }
    return {
      id: q.id,
      type: t,
      content: String(q.content),
      choicesText: String(q.choices),
    };
  });
}

async function loadZip(file) {
  const ab = await file.arrayBuffer();
  return loadZipFromArrayBuffer(ab);
}

async function loadZipFromUrl(zipUrl) {
  const res = await fetch(zipUrl, { cache: "no-store" });
  if (!res.ok) throw new Error("Không tải được ZIP: HTTP " + res.status);
  const ab = await res.arrayBuffer();
  return loadZipFromArrayBuffer(ab);
}

// ===== Quiz core =====
function startNewAttempt() {
  quiz = shuffle(rawQuestions).map((q) => {
    let choices = parseChoices(q.choicesText);
    if (!choices.length) throw new Error(`Câu id=${q.id}: choices rỗng hoặc sai format ##/#$.`);

    if (q.type === "truefalse") {
      if (choices.length !== 2) {
        throw new Error(`Câu id=${q.id}: truefalse phải có đúng 2 lựa chọn (Đúng/Sai).`);
      }
    } else {
      choices = shuffle(choices);
    }

    const correctIdxs = choices.map((c, i) => (c.correct ? i : -1)).filter((i) => i >= 0);
    if (correctIdxs.length !== 1) {
      throw new Error(`Câu id=${q.id}: Mỗi câu chỉ được có đúng 1 đáp án đúng (#$).`);
    }

    return { ...q, choices, correctIdxs };
  });

  answered = quiz.map(() => ({ selectedIdxs: [], checked: false, correct: false, skipped: false }));
  current = 0;
  updateProgress();
}

function getImageUrl(path) {
  return blobUrlMap.get(path) || "";
}

function renderQuestion() {
  const q = quiz[current];
  const a = answered[current];

  if (qIndex) qIndex.textContent = String(current + 1);
  if (qTotal) qTotal.textContent = String(quiz.length);

  if (qTypePill) qTypePill.textContent = q.type === "multi" ? "A/B/C/D" : "TRUE/FALSE";
  if (qContent) qContent.innerHTML = renderRichText(q.content, getImageUrl);

  if (choicesEl) choicesEl.innerHTML = "";
  if (feedback) {
    feedback.style.display = "none";
    feedback.innerHTML = "";
  }

  const name = "q_" + current;

  q.choices.forEach((c, idx) => {
    const id = `c_${current}_${idx}`;
    const checked = a.selectedIdxs.includes(idx);

    const label = document.createElement("label");
    label.className = "choice neutral";
    label.htmlFor = id;

    label.innerHTML = `
      <input id="${id}" type="radio" name="${name}" ${checked ? "checked" : ""} />
      <div style="flex:1;min-width:0;">${renderRichText(c.text, getImageUrl)}</div>
    `;

    const input = label.querySelector("input");
    input.disabled = a.checked;

    input.addEventListener("change", () => {
      if (answered[current].checked) return;
      answered[current].selectedIdxs = getSelectedIdxsSingle();
      answered[current].skipped = false;
    });

    choicesEl.appendChild(label);
  });

  if (a.checked) applyMarking(q, a);

  if (btnPrev) btnPrev.disabled = current === 0;
  if (btnNext) {
    btnNext.textContent = !answered[current].checked
      ? "Tiếp → (chấm)"
      : current === quiz.length - 1
      ? "Kết thúc"
      : "Câu tiếp →";
  }

  updateProgress();

  if (window.MathJax?.typesetPromise) window.MathJax.typesetPromise();
}

function getSelectedIdxsSingle() {
  const inputs = choicesEl.querySelectorAll("input");
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i].checked) return [i];
  }
  return [];
}

function applyMarking(q, a) {
  const labels = choicesEl.querySelectorAll("label.choice");
  labels.forEach((lab, idx) => {
    lab.classList.remove("neutral", "correct", "wrong");
    const isCorrectChoice = q.correctIdxs.includes(idx);
    const isSelected = a.selectedIdxs.includes(idx);

    if (isCorrectChoice) lab.classList.add("correct");
    else if (isSelected && !isCorrectChoice) lab.classList.add("wrong");
    else lab.classList.add("neutral");

    const inp = lab.querySelector("input");
    if (inp) inp.disabled = true;
  });

  if (feedback) {
    feedback.style.display = "";
    feedback.innerHTML = a.correct
      ? `<b class="ok">ĐÚNG ✅</b>`
      : `<b class="no">SAI ❌</b> — Đáp án đúng được tô xanh.`;
  }

  if (btnNext) btnNext.textContent = current === quiz.length - 1 ? "Kết thúc" : "Câu tiếp →";
  if (window.MathJax?.typesetPromise) window.MathJax.typesetPromise();
}

function showQuiz() {
  if (screenPick) screenPick.style.display = "none";
  if (screenResult) screenResult.style.display = "none";
  if (screenQuiz) screenQuiz.style.display = "";
  renderQuestion();
}

function showResult() {
  if (screenPick) screenPick.style.display = "none";
  if (screenQuiz) screenQuiz.style.display = "none";
  if (screenResult) screenResult.style.display = "";

  const correctCount = answered.filter((a) => a.correct).length;
  if (resultSummary) {
    resultSummary.textContent = `Bạn đúng ${correctCount}/${answered.length} câu.`;
  }

  if (resultList) resultList.innerHTML = "";

  quiz.forEach((q, i) => {
    const a = answered[i];

    const block = document.createElement("div");
    block.className = "item";
    block.style.flexDirection = "column";
    block.style.alignItems = "stretch";
    block.style.gap = "10px";

    const status = a.skipped
      ? `<span class="no">Bỏ qua ⏭</span>`
      : a.correct
      ? `<span class="ok">Đúng ✅</span>`
      : `<span class="no">Sai ❌</span>`;

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.gap = "10px";
    header.innerHTML = `
      <div>
        <b>Câu ${i + 1}</b> <span class="muted">(id=${escapeHtml(q.id)})</span>
        <span class="pill">${q.type === "multi" ? "A/B/C/D" : "TRUE/FALSE"}</span>
      </div>
      <div>${status}</div>
    `;

    const content = document.createElement("div");
    content.innerHTML = renderRichText(q.content, getImageUrl);

    const choicesWrap = document.createElement("div");
    choicesWrap.className = "choices";

    q.choices.forEach((c, idx) => {
      const isCorrectChoice = q.correctIdxs.includes(idx);
      const isSelected = a.selectedIdxs.includes(idx);

      let cls = "choice neutral";
      if (isCorrectChoice) cls = "choice correct";
      else if (isSelected && !isCorrectChoice) cls = "choice wrong";

      const row = document.createElement("div");
      row.className = cls;
      row.style.cursor = "default";
      row.innerHTML = `<div style="flex:1;min-width:0;">${renderRichText(c.text, getImageUrl)}</div>`;
      choicesWrap.appendChild(row);
    });

    block.appendChild(header);
    block.appendChild(content);
    block.appendChild(choicesWrap);
    resultList.appendChild(block);
  });

  if (window.MathJax?.typesetPromise) window.MathJax.typesetPromise();
}

function resetToPick() {
  cleanupUrls();
  zip = null;
  rawQuestions = [];
  quiz = [];
  answered = [];
  current = 0;

  if (zipInput) zipInput.value = "";
  if (btnLoad) btnLoad.disabled = true;
  if (pickHint) pickHint.textContent = "";

  if (screenPick) screenPick.style.display = "";
  if (screenQuiz) screenQuiz.style.display = "none";
  if (screenResult) screenResult.style.display = "none";

  setPickTab("local");
}

function cleanupUrls() {
  for (const url of blobUrlMap.values()) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  blobUrlMap = new Map();
}
