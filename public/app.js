/* ============================================
   FINANCE APP v8.0 — FULL INVESTMENT FIX
   - Recurring investments replicate to ALL months (past & future)
   - Dynamic investment categories (free creation like expenses)
   - Consolidated investment meta section with subcategory progress
   - Single source of truth for all investment data
   ============================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc,
  onSnapshot, deleteDoc, enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBoZt1xRayukFKaHyqw22BZTKnx-gbmEG4",
  authDomain: "finance-5707a.firebaseapp.com",
  projectId: "finance-5707a",
  storageBucket: "finance-5707a.firebasestorage.app",
  messagingSenderId: "1013426544378",
  appId: "1:1013426544378:web:4b86e7f492bcfdae86f343",
  measurementId: "G-9B6GL03V6B"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
try { enableIndexedDbPersistence(db).catch(() => {}); } catch(e) {}

const state = { entries: [], budgets: {}, categories: {}, monthlyHistory: {} };
let currentUser = null;
let selectedFilterMonth = new Date().toISOString().slice(0,7);

window.state = state;
window.selectedFilterMonth = selectedFilterMonth;

// ─── Helpers ─────────────────────────────────────────────────────────────────
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const el  = (id)  => document.getElementById(id);
const qs  = (sel) => document.querySelector(sel);
const qsa = (sel) => Array.from(document.querySelectorAll(sel));

const formatMoney = (v) => {
  v = Number(v || 0);
  return 'R$ ' + v.toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
};

const parseNumber = (s) => {
  if (!s) return 0;
  s = String(s).trim().replace(/[^\d\-,.]/g, '');
  if (s.indexOf(',') > -1 && s.indexOf('.') > -1) {
    s = s.replace(/\./g, '').replace(/,/g, '.');
  } else {
    s = s.replace(/,/g, '.');
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
};

const formatDateISO = (d) => {
  if (!d) return new Date().toISOString().slice(0,10);
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toISOString().slice(0,10);
};

const yyyyMmFromDate = (d) => {
  const dt = new Date(d);
  if (isNaN(dt)) return '';
  return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0');
};

const escapeHtml = (s) => {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
};

const STORAGE_KEY = 'finance_v7';

const saveLocal = () => {
  try {
    const key = STORAGE_KEY + (currentUser ? '_' + currentUser.uid : '');
    localStorage.setItem(key, JSON.stringify(state));
  } catch(e) { console.error('saveLocal:', e); }
};

const loadLocal = () => {
  try {
    const key = STORAGE_KEY + (currentUser ? '_' + currentUser.uid : '');
    const raw = localStorage.getItem(key);
    if (raw) Object.assign(state, JSON.parse(raw));
  } catch(e) { console.error('loadLocal:', e); }
};

// ─── MIGRATION ───────────────────────────────────────────────────────────────
const migrateData = async () => {
  let changed = false;
  const fixBudgets = (budgetsObj) => {
    Object.keys(budgetsObj || {}).forEach(cat => {
      if (budgetsObj[cat].kind === 'investment' && budgetsObj[cat].isFixed) {
        budgetsObj[cat].isFixed = false; changed = true;
      }
    });
  };
  fixBudgets(state.budgets);
  Object.keys(state.monthlyHistory || {}).forEach(m => fixBudgets(state.monthlyHistory[m]?.budgets));
  state.entries.forEach(e => {
    if (e && e.type === 'investment' && e.fixed === true && !e.recurring) {
      e.recurring = true; e.fixed = false; changed = true;
    }
    // MIGRAÇÃO: receita fixa antiga (fixed:true sem recurring:true) → recurring:true
    if (e && e.type === 'income' && e.fixed === true && !e.recurring) {
      e.recurring = true; changed = true;
    }
  });

  // MIGRAÇÃO: remover budgets kind:'income' que causavam valores fantasmas
  const incomeBudgetCats = Object.keys(state.budgets || {}).filter(cat => state.budgets[cat]?.kind === 'income');
  if (incomeBudgetCats.length > 0) {
    incomeBudgetCats.forEach(cat => { delete state.budgets[cat]; });
    Object.keys(state.monthlyHistory || {}).forEach(m => {
      incomeBudgetCats.forEach(cat => { if (state.monthlyHistory[m]?.budgets?.[cat]) delete state.monthlyHistory[m].budgets[cat]; });
    });
    changed = true;
  }
  if (changed) {
    saveLocal();
    if (currentUser) {
      try {
        for (const cat of Object.keys(state.budgets)) {
          if (state.budgets[cat].kind === 'investment')
            await setDoc(doc(db, 'users', currentUser.uid, 'budgets', cat), state.budgets[cat]);
        }
        for (const cat of incomeBudgetCats) {
          try { await deleteDoc(doc(db, 'users', currentUser.uid, 'budgets', cat)); } catch(_) {}
        }
        for (const e of state.entries) {
          if (e && e.type === 'investment' && e.recurring === true && e.fixed === false)
            await setDoc(doc(db, 'users', currentUser.uid, 'entries', e.id), e);
          if (e && e.type === 'income' && e.recurring === true)
            await setDoc(doc(db, 'users', currentUser.uid, 'entries', e.id), e);
        }
      } catch(err) { console.warn('migrateData remote:', err); }
    }
  }
};

// ─── HISTÓRICO MENSAL ─────────────────────────────────────────────────────────
const captureMonthlySnapshot = (month) => {
  if (!month) month = new Date().toISOString().slice(0,7);
  const snapshot = { budgets: {}, timestamp: new Date().toISOString() };
  Object.keys(state.budgets || {}).forEach(cat => {
    const b = state.budgets[cat];
    snapshot.budgets[cat] = {
      budget:  Number(b.budget  || 0),
      default: Number(b.default || 0),
      isFixed: b.kind === 'investment' ? false : !!b.isFixed,
      kind:    b.kind || 'expense'
    };
  });
  state.monthlyHistory = state.monthlyHistory || {};
  state.monthlyHistory[month] = snapshot;
  saveLocal();
};

const getBudgetForMonth = (category, month) => {
  if (!month) month = selectedFilterMonth !== 'all' ? selectedFilterMonth : new Date().toISOString().slice(0,7);
  if (state.monthlyHistory?.[month]?.budgets?.[category]) {
    return state.monthlyHistory[month].budgets[category];
  }
  const b = state.budgets?.[category];
  if (b) return {
    budget:  Number(b.budget  || 0),
    default: Number(b.default || 0),
    isFixed: b.kind === 'investment' ? false : !!b.isFixed,
    kind:    b.kind || 'expense'
  };
  return null;
};

let lastCheckedMonth = new Date().toISOString().slice(0,7);
setInterval(() => {
  const current = new Date().toISOString().slice(0,7);
  if (current !== lastCheckedMonth) {
    captureMonthlySnapshot(lastCheckedMonth);
    lastCheckedMonth = current;
  }
}, 3600000);

// ─── ENTRIES ─────────────────────────────────────────────────────────────────
const ensureEntryId = (e) => { if (!e.id || String(e.id).trim() === '') e.id = uid(); return e; };
const isValidEntry  = (e) => e && e.id && !isNaN(Number(e.value));

// ─── expandEntry ─────────────────────────────────────────────────────────────
// FIX: recurring entries now correctly appear in ALL months — past AND future —
// when a filterMonth is provided. No longer capped at "now".
const expandEntry = (e, filterMonth = null) => {
  if (!e) return [];

  // ── Case 1: Recurring (open-ended, expands every month from start) ────────
  if (e.recurring === true && !e.seriesId && !(e.series && Number(e.series.total) > 1)) {
    const startComp = e.competence || yyyyMmFromDate(e.date);
    if (!startComp) return [];

    if (filterMonth) {
      // ✅ KEY FIX: show in filterMonth as long as filterMonth >= startComp
      // and either there's no recurringEnd or filterMonth <= recurringEnd
      // This allows future months to correctly show recurring entries
      if (filterMonth >= startComp && (!e.recurringEnd || filterMonth <= e.recurringEnd)) {
        return [{ competence: filterMonth, value: Number(e.value || 0), entry: e }];
      }
      return [];
    }

    // No filterMonth — expand up to current month for "all months" view
    const nowComp = new Date().toISOString().slice(0,7);
    const endComp = e.recurringEnd || nowComp;
    const arr = [];
    const [sy, sm_] = startComp.split('-').map(Number);
    const [ey, em]  = endComp.split('-').map(Number);
    let y = sy, m = sm_;
    while (y < ey || (y === ey && m <= em)) {
      const comp = `${y}-${String(m).padStart(2,'0')}`;
      arr.push({ competence: comp, value: Number(e.value || 0), entry: e });
      m++; if (m > 12) { m = 1; y++; }
    }
    return arr;
  }

  // ── Case 2: Series child (installment) ───────────────────────────────────
  if (e.seriesIndex && e.seriesTotal) {
    const comp = e.competence || yyyyMmFromDate(e.date);
    if (filterMonth && comp !== filterMonth) return [];
    return [{ competence: comp, value: Number(e.value || 0), entry: e }];
  }

  // ── Case 3: Series parent ─────────────────────────────────────────────────
  if (e.series && e.series.total && Number(e.series.total) > 1) {
    const hasChildren = state.entries.some(ch => ch && ch.seriesId === e.id);
    if (hasChildren) return [];
    const arr = [];
    const start  = e.series.start;
    const total  = Number(e.series.total);
    const sidx   = Number(e.series.startIndex || 1);
    const remaining = Math.max(0, total - (sidx - 1));
    const perValue  = Number(e.value || 0);
    const parts = (start || '').split('-').map(Number);
    if (parts.length === 2 && parts[0] && parts[1]) {
      const [sy, sm_] = parts;
      for (let i = 0; i < remaining; i++) {
        const month = sm_ + i;
        const y = sy + Math.floor((month - 1) / 12);
        const m = ((month - 1) % 12) + 1;
        const comp = `${y}-${String(m).padStart(2,'0')}`;
        if (!filterMonth || comp === filterMonth) arr.push({ competence: comp, value: perValue, entry: e });
      }
      return arr;
    }
  }

  // ── Case 4: Simple single entry ───────────────────────────────────────────
  const comp = e.competence || yyyyMmFromDate(e.date);
  if (filterMonth && comp !== filterMonth) return [];
  return [{ competence: comp, value: Number(e.value || 0), entry: e }];
};

// ─── CALCULATIONS ─────────────────────────────────────────────────────────────
const calcTotals = (month) => {
  const sel = month === 'all' ? null : month;
  let realReceita = 0, fixedTotal = 0, variableTotal = 0, investTotal = 0;
  const byCat = {};

  state.entries.forEach(e => {
    if (!isValidEntry(e)) return;
    expandEntry(e, sel).forEach(inst => {
      const entry = inst.entry;
      const val   = Number(inst.value || 0);

      if (entry.type === 'income') { realReceita += val; return; }

      if (entry.type === 'investment') { investTotal += val; return; }

      const cat        = (entry.category && String(entry.category).trim()) || '(Sem categoria)';
      const budgetInfo = getBudgetForMonth(cat, sel);
      const isFixed    = entry.fixed || (budgetInfo && budgetInfo.isFixed && budgetInfo.kind === 'expense');

      if (isFixed) { fixedTotal += val; }
      else { variableTotal += val; byCat[cat] = (byCat[cat] || 0) + val; }
    });
  });

  if (sel) {
    Object.keys(state.budgets || {}).forEach(cat => {
      const b = getBudgetForMonth(cat, sel);
      if (!b || !b.isFixed) return;
      if (b.kind === 'expense') {
        const hasEntry = state.entries.some(e => {
          if (!isValidEntry(e) || e.type !== 'expense') return false;
          const comp = e.competence || yyyyMmFromDate(e.date);
          if (comp !== sel) return false;
          const eCat = (e.category && String(e.category).trim()) || '(Sem categoria)';
          return eCat === cat;
        });
        if (!hasEntry) fixedTotal += Number(b.default || b.budget || 0);
      }
      // Receitas fixas agora usam recurring:true nas entries → expandEntry cuida de todos os meses.
      // Não há mais fallback por budget para evitar valores fantasmas.
    });
  }

  return { realReceita, fixedTotal, variableTotal, investTotal, byCat };
};

const calcOrcamentoTotal = (month) => {
  const sel = month && month !== 'all' ? month : null;
  let orcVariavel = 0, orcFixo = 0, orcInvest = 0;
  Object.keys(state.budgets || {}).forEach(cat => {
    const b = getBudgetForMonth(cat, sel);
    if (!b || b.kind === 'income') return;
    if (b.kind === 'investment') { orcInvest += Number(b.budget || 0); }
    else if (b.isFixed)          { orcFixo += Number(b.default || b.budget || 0); }
    else                         { orcVariavel += Number(b.budget || 0); }
  });
  return { orcVariavel, orcFixo, orcInvest, total: orcVariavel + orcFixo + orcInvest };
};

const getAllCategories = () => {
  const set = new Set();
  Object.keys(state.budgets || {}).forEach(k => {
    if (k && k.trim() && state.budgets[k]?.kind !== 'investment') set.add(k.trim());
  });
  state.entries.forEach(e => {
    if (e.type === 'expense') {
      const cat = (e.category && String(e.category).trim()) || '';
      if (cat) set.add(cat);
    }
  });
  return Array.from(set).sort();
};

// ── Expense categories split by fixed / variable ──────────────────────────────
const getFixedExpenseCategories = () => {
  const set = new Set();
  Object.keys(state.budgets || {}).forEach(k => {
    if (k && k.trim() && state.budgets[k]?.kind !== 'investment' && state.budgets[k]?.isFixed) set.add(k.trim());
  });
  state.entries.forEach(e => {
    if (e.type === 'expense' && e.fixed) {
      const cat = (e.category && String(e.category).trim()) || '';
      if (cat) set.add(cat);
    }
  });
  return Array.from(set).sort();
};

const getVariableExpenseCategories = () => {
  const set = new Set();
  Object.keys(state.budgets || {}).forEach(k => {
    if (k && k.trim() && state.budgets[k]?.kind !== 'investment' && !state.budgets[k]?.isFixed) set.add(k.trim());
  });
  state.entries.forEach(e => {
    if (e.type === 'expense' && !e.fixed) {
      const cat = (e.category && String(e.category).trim()) || '';
      if (cat) set.add(cat);
    }
  });
  return Array.from(set).sort();
};

// ── getAllInvestmentCategories ─────────────────────────────────────────────────
// Single source of truth: union of budget (kind=investment) + entry (type=investment) categories
const getAllInvestmentCategories = () => {
  const set = new Set();
  // From budgets with kind='investment'
  Object.keys(state.budgets || {}).forEach(cat => {
    if (cat && cat.trim() && state.budgets[cat]?.kind === 'investment') set.add(cat.trim());
  });
  // From actual investment entries
  state.entries.forEach(e => {
    if (e && e.type === 'investment' && e.category && String(e.category).trim()) {
      set.add(String(e.category).trim());
    }
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b));
};

// ── calcInvestByCategory ──────────────────────────────────────────────────────
// Returns invested amount for a specific investment category in a given month
const calcInvestByCategory = (category, month) => {
  const sel = month && month !== 'all' ? month : null;
  let total = 0;
  state.entries.forEach(e => {
    if (!isValidEntry(e) || e.type !== 'investment') return;
    const eCat = (e.category && String(e.category).trim()) || '';
    if (eCat !== category) return;
    expandEntry(e, sel).forEach(inst => { total += Number(inst.value || 0); });
  });
  return total;
};

// ─── BUDGETS ─────────────────────────────────────────────────────────────────
const setBudget = async (category, data, month = null) => {
  const cat = String(category).trim();
  if (!cat) return;
  if (data.kind === 'investment') data.isFixed = false;

  const targetMonth = month
    || (selectedFilterMonth !== 'all' ? selectedFilterMonth : null)
    || new Date().toISOString().slice(0, 7);

  const budgetData = {
    budget:  Number(data.budget  || 0),
    default: Number(data.default || 0),
    isFixed: data.kind === 'investment' ? false : !!data.isFixed,
    kind:    data.kind || 'expense'
  };

  state.budgets = state.budgets || {};
  state.budgets[cat] = budgetData;

  state.monthlyHistory = state.monthlyHistory || {};
  if (!state.monthlyHistory[targetMonth]) {
    state.monthlyHistory[targetMonth] = { budgets: {}, timestamp: new Date().toISOString() };
  }
  state.monthlyHistory[targetMonth].budgets = state.monthlyHistory[targetMonth].budgets || {};
  state.monthlyHistory[targetMonth].budgets[cat] = { ...budgetData };

  if (currentUser) {
    try { await setDoc(doc(db, 'users', currentUser.uid, 'budgets', cat), budgetData); } catch(e) {}
    try {
      await setDoc(
        doc(db, 'users', currentUser.uid, 'monthlyBudgets', targetMonth),
        { budgets: state.monthlyHistory[targetMonth].budgets, updatedAt: new Date().toISOString() },
        { merge: true }
      );
    } catch(e) {}
  }

  saveLocal();
  window.dispatchEvent(new Event('app:state-changed'));
  setTimeout(renderAll, 10);
};

const ensureMonthHistory = (month) => {
  state.monthlyHistory = state.monthlyHistory || {};
  if (!state.monthlyHistory[month]) {
    const snapshot = { budgets: {}, timestamp: new Date().toISOString() };
    Object.keys(state.budgets || {}).forEach(cat => {
      const b = state.budgets[cat];
      if (b) snapshot.budgets[cat] = {
        budget:  Number(b.budget  || 0),
        default: Number(b.default || 0),
        isFixed: b.kind === 'investment' ? false : !!b.isFixed,
        kind:    b.kind || 'expense'
      };
    });
    state.monthlyHistory[month] = snapshot;
    saveLocal();
  }
};

const inheritBudgetFrom = async (sourceMonth, targetMonth) => {
  const source = state.monthlyHistory?.[sourceMonth];
  const sourceBudgets = source ? source.budgets : state.budgets;
  if (!sourceBudgets || Object.keys(sourceBudgets).length === 0) {
    alert('Nenhum orçamento encontrado em ' + sourceMonth); return;
  }
  state.monthlyHistory = state.monthlyHistory || {};
  state.monthlyHistory[targetMonth] = {
    budgets: JSON.parse(JSON.stringify(sourceBudgets)),
    timestamp: new Date().toISOString(),
    inheritedFrom: sourceMonth
  };
  Object.keys(state.monthlyHistory[targetMonth].budgets).forEach(cat => {
    if (state.monthlyHistory[targetMonth].budgets[cat].kind === 'investment')
      state.monthlyHistory[targetMonth].budgets[cat].isFixed = false;
  });
  if (currentUser) {
    try {
      await setDoc(
        doc(db, 'users', currentUser.uid, 'monthlyBudgets', targetMonth),
        { budgets: state.monthlyHistory[targetMonth].budgets, updatedAt: new Date().toISOString(), inheritedFrom: sourceMonth }
      );
    } catch(e) {}
  }
  saveLocal(); renderAll();
  alert('Orçamentos de ' + sourceMonth + ' copiados para ' + targetMonth + ' ✓');
};
window.inheritBudgetFrom = inheritBudgetFrom;

const removeBudget = async (category, month = null) => {
  const cat = String(category).trim();
  if (!cat) return;
  const targetMonth = month || (selectedFilterMonth !== 'all' ? selectedFilterMonth : null) || new Date().toISOString().slice(0,7);
  if (!confirm(`Remover orçamento de "${cat}" do mês ${targetMonth}?`)) return;
  if (state.monthlyHistory?.[targetMonth]?.budgets) {
    delete state.monthlyHistory[targetMonth].budgets[cat];
    if (currentUser) {
      try {
        await setDoc(
          doc(db, 'users', currentUser.uid, 'monthlyBudgets', targetMonth),
          { budgets: state.monthlyHistory[targetMonth].budgets, updatedAt: new Date().toISOString() }
        );
      } catch(e) {}
    }
  }
  if (currentUser) {
    try { await deleteDoc(doc(db, 'users', currentUser.uid, 'budgets', cat)); } catch(e) {}
  }
  delete state.budgets[cat];
  saveLocal(); renderAll();
};

// ─── ENTRIES CRUD ─────────────────────────────────────────────────────────────
const addEntry = async () => {
  const type         = el('input-type').value;
  const date         = formatDateISO(el('input-date').value);
  const competence   = el('input-competence').value || yyyyMmFromDate(date);
  const description  = el('input-desc').value.trim();

  // ── Category resolution (same logic for all types) ────────────────────────
  const catSelectEl = el('input-category-select');
  const catTextEl   = el('input-category-text');
  const catTextVisible = catTextEl && catTextEl.style.display !== 'none';
  const categoryRaw = catTextVisible
    ? catTextEl.value.trim()
    : (catSelectEl.value === '__new__' ? catTextEl.value.trim() : catSelectEl.value.trim());
  const category = categoryRaw || '';

  const value        = parseNumber(el('input-value').value);
  const fixedChecked = el('input-fixed').checked;
  const parceled     = el('input-parceled').checked;

  if (!value || value <= 0) { alert('Valor inválido'); return; }
  if ((type === 'expense' || type === 'investment') && !category) {
    alert('Escolha ou crie uma categoria'); return;
  }

  const finalCategory = category;
  const entryId = uid();

  // ── INVESTMENT ─────────────────────────────────────────────────────────────
  if (type === 'investment') {
    const isRecurring = fixedChecked;

    // ✅ Auto-create / update investment budget for this category
    // This ensures the category appears in the meta section and progress
    const existingBudget = state.budgets[finalCategory];
    if (!existingBudget || existingBudget.kind !== 'investment') {
      // Create with value as the goal (user can edit later)
      await setBudget(finalCategory, {
        budget:  value,
        default: value,
        isFixed: false,
        kind:    'investment'
      });
    }

    const entry = {
      id: entryId, date, competence,
      type: 'investment',
      category: finalCategory,
      description, value,
      recurring: isRecurring,
      fixed: false
    };
    state.entries.push(entry);
    if (currentUser) {
      try { await setDoc(doc(db, 'users', currentUser.uid, 'entries', entryId), entry); } catch(e) {}
    }
    saveLocal(); clearForm(); renderAll();
    window.dispatchEvent(new Event('app:state-changed'));
    return;
  }

  // ── INCOME ─────────────────────────────────────────────────────────────────
  if (type === 'income') {
    // FIX: receita fixa usa recurring:true (igual a investimentos recorrentes).
    // Não cria mais budget separado — evita duplicação e valores fantasmas.
    const entry = { id: entryId, date, competence, type: 'income', category: finalCategory, description, value, fixed: fixedChecked, recurring: fixedChecked };
    state.entries.push(entry);
    if (currentUser) {
      try { await setDoc(doc(db, 'users', currentUser.uid, 'entries', entryId), entry); } catch(e) {}
    }
    saveLocal(); clearForm(); renderAll();
    window.dispatchEvent(new Event('app:state-changed'));
    return;
  }

  // ── EXPENSE ────────────────────────────────────────────────────────────────
  const isNewCategory = catTextVisible && catTextEl.value.trim() !== '';
  if (isNewCategory || (fixedChecked && finalCategory)) {
    await setBudget(finalCategory, { budget: value, default: value, isFixed: fixedChecked, kind: 'expense' });
  }
  if (fixedChecked && finalCategory && state.budgets[finalCategory] && !state.budgets[finalCategory].isFixed) {
    await setBudget(finalCategory, { budget: value, default: value, isFixed: true, kind: 'expense' });
  }

  if (parceled) {
    const total   = Number(el('input-parcel-total').value) || 2;
    const current = Number(el('input-parcel-current').value) || 1;
    if (total <= 1) { alert('Parcelas inválidas'); return; }
    const root = {
      id: entryId, date, competence, type: 'expense',
      category: finalCategory, description, value, fixed: fixedChecked,
      series: { start: competence, total, startIndex: current, _expanded: true }
    };
    const children = [];
    const [sy, sm_] = competence.split('-').map(Number);
    const remaining = Math.max(0, total - (current - 1));
    for (let i = 0; i < remaining; i++) {
      const month = sm_ + i;
      const y = sy + Math.floor((month - 1) / 12);
      const m = ((month - 1) % 12) + 1;
      const comp = `${y}-${String(m).padStart(2,'0')}`;
      const idx  = current + i;
      children.push({
        id: uid(), date: `${y}-${String(m).padStart(2,'0')}-01`,
        competence: comp, type: 'expense', category: finalCategory,
        description: `${description} (${idx}/${total})`,
        value, fixed: fixedChecked, seriesId: root.id, seriesIndex: idx, seriesTotal: total
      });
    }
    state.entries.push(root, ...children);
    if (currentUser) {
      try {
        await setDoc(doc(db, 'users', currentUser.uid, 'entries', root.id), root);
        for (const ch of children) await setDoc(doc(db, 'users', currentUser.uid, 'entries', ch.id), ch);
      } catch(e) {}
    }
  } else {
    const entry = { id: entryId, date, competence, type: 'expense', category: finalCategory, description, value, fixed: fixedChecked };
    state.entries.push(entry);
    if (currentUser) {
      try { await setDoc(doc(db, 'users', currentUser.uid, 'entries', entryId), entry); } catch(e) {}
    }
  }
  saveLocal(); clearForm(); renderAll();
  window.dispatchEvent(new Event('app:state-changed'));
};

const deleteEntry = async (id) => {
  if (!confirm('Excluir lançamento?')) return;
  const root = state.entries.find(e => e.id === id && e.series);
  if (root) {
    const children = state.entries.filter(e => e.seriesId === id);
    const allIds = [id, ...children.map(c => c.id)];
    state.entries = state.entries.filter(e => !allIds.includes(e.id));
    if (currentUser) {
      try { for (const delId of allIds) await deleteDoc(doc(db, 'users', currentUser.uid, 'entries', delId)); } catch(e) {}
    }
  } else {
    state.entries = state.entries.filter(e => e.id !== id);
    if (currentUser) {
      try { await deleteDoc(doc(db, 'users', currentUser.uid, 'entries', id)); } catch(e) {}
    }
  }
  saveLocal(); renderAll();
  window.dispatchEvent(new Event('app:state-changed'));
};

const updateEntry = async (id, patch) => {
  const idx = state.entries.findIndex(e => e.id === id);
  if (idx === -1) return;
  if (patch.type === 'investment' || state.entries[idx].type === 'investment') {
    if (patch.fixed === true) { patch.recurring = true; patch.fixed = false; }
  }
  state.entries[idx] = { ...state.entries[idx], ...patch };
  if (currentUser) {
    try { await setDoc(doc(db, 'users', currentUser.uid, 'entries', id), state.entries[idx]); } catch(e) {}
  }
  saveLocal(); renderAll();
  window.dispatchEvent(new Event('app:state-changed'));
};

// ─── MODALS ───────────────────────────────────────────────────────────────────
const editEntry = (id) => {
  const entry = state.entries.find(e => e.id === id);
  if (!entry) { alert('Lançamento não encontrado'); return; }

  const isInvest   = entry.type === 'investment';
  const isParceled = !!(entry.series && Number(entry.series.total) > 1);

  // ── Branch: parceled series editor ──────────────────────────────────────────
  if (isParceled) {
    const children    = state.entries.filter(e => e.seriesId === id);
    const currentTotal = Number(entry.series.total || 2);
    const currentStart = Number(entry.series.startIndex || 1);

    const overlay = document.createElement('div'); overlay.className = 'app-edit-overlay';
    const modal   = document.createElement('div'); modal.className   = 'app-edit-modal';

    // Build parcel-count options
    const totalOpts = Array.from({length: 35}, (_,i) => i+2)
      .map(n => `<option value="${n}" ${n===currentTotal?'selected':''}>${n}x</option>`).join('');
    const startOpts = Array.from({length: currentTotal}, (_,i) => i+1)
      .map(n => `<option value="${n}" ${n===currentStart?'selected':''}>${n}</option>`).join('');

    modal.innerHTML = `
      <h3>Editar Parcelamento</h3>
      <p class="small" style="color:var(--warning);margin-bottom:12px">
        ⚠️ Alterar o valor atualiza <strong>todas as parcelas</strong>. Alterar o total ou a parcela inicial recria a série.
      </p>
      <div class="app-row"><label>Data inicial</label><input id="ep-date" type="date" value="${formatDateISO(entry.date)}"></div>
      <div class="app-row"><label>Competência inicial</label><input id="ep-comp" type="month" value="${entry.competence || yyyyMmFromDate(entry.date)}"></div>
      <div class="app-row"><label>Categoria</label><input id="ep-cat" value="${escapeHtml(entry.category || '')}"></div>
      <div class="app-row"><label>Descrição (base)</label><input id="ep-desc" value="${escapeHtml(entry.description?.replace(/ \(\d+\/\d+\)$/,'') || '')}"></div>
      <div class="app-row"><label>Valor por parcela (R$)</label><input id="ep-value" type="text" inputmode="decimal" value="${entry.value || 0}"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="app-row"><label>Total de parcelas</label><select id="ep-total">${totalOpts}</select></div>
        <div class="app-row"><label>Parcela inicial</label><select id="ep-start">${startOpts}</select></div>
      </div>
      <div class="app-row"><label><input id="ep-fixed" type="checkbox" ${entry.fixed?'checked':''}>Custo fixo mensal</label></div>
      <div class="app-actions">
        <button id="ep-cancel" class="muted-button">Cancelar</button>
        <button id="ep-save" style="background:var(--accent);color:#fff">Salvar série</button>
      </div>`;

    overlay.appendChild(modal); document.body.appendChild(overlay);

    // Rebuild start-index options when total changes
    const totalSel = modal.querySelector('#ep-total');
    const startSel = modal.querySelector('#ep-start');
    totalSel.addEventListener('change', () => {
      const t = Number(totalSel.value);
      const prev = Number(startSel.value);
      startSel.innerHTML = Array.from({length: t}, (_,i) => i+1)
        .map(n => `<option value="${n}" ${n===Math.min(prev,t)?'selected':''}>${n}</option>`).join('');
    });

    modal.querySelector('#ep-cancel').addEventListener('click', () => overlay.remove());
    modal.querySelector('#ep-save').addEventListener('click', async () => {
      const newValue = parseNumber(modal.querySelector('#ep-value').value);
      const newTotal = Number(totalSel.value);
      const newStart = Number(startSel.value);
      const newCat   = modal.querySelector('#ep-cat').value.trim();
      // Strip any trailing "(X/Y)" suffix left in the description field
      const descBase = modal.querySelector('#ep-desc').value.trim().replace(/ \(\d+\/\d+\)$/, '');
      const newDate  = modal.querySelector('#ep-date').value;
      const newComp  = modal.querySelector('#ep-comp').value;
      const newFixed = modal.querySelector('#ep-fixed').checked;

      if (!newComp) { alert('Competência inicial obrigatória'); return; }
      if (newTotal < 1) { alert('Total de parcelas inválido'); return; }
      if (newStart < 1 || newStart > newTotal) { alert('Parcela inicial inválida'); return; }

      // ── Step 1: Remove ALL existing children ─────────────────────────────────
      const oldChildIds = children.map(c => c.id);
      state.entries = state.entries.filter(e => !oldChildIds.includes(e.id));
      if (currentUser) {
        try {
          for (const cid of oldChildIds) {
            await deleteDoc(doc(db, 'users', currentUser.uid, 'entries', cid));
          }
        } catch(e) {}
      }

      // ── Step 2: Update root — keep description clean (no parcel suffix) ──────
      // The root is a metadata holder; the children carry the actual per-month entries.
      const newSeries = { start: newComp, total: newTotal, startIndex: newStart, _expanded: true };
      const rootPatch = {
        date:        formatDateISO(newDate),
        competence:  newComp,
        category:    newCat,
        description: descBase,   // ← no "(X/Y)" on root — avoids double display in table
        value:       newValue,
        fixed:       newFixed,
        series:      newSeries
      };
      const rootIdx = state.entries.findIndex(e => e.id === id);
      if (rootIdx !== -1) state.entries[rootIdx] = { ...state.entries[rootIdx], ...rootPatch };
      if (currentUser) {
        try { await setDoc(doc(db, 'users', currentUser.uid, 'entries', id), state.entries[rootIdx]); } catch(e) {}
      }

      // ── Step 3: Rebuild children — mirrors addEntry loop exactly ─────────────
      // remaining = number of installments from newStart through newTotal (inclusive)
      // Loop starts at i=0 → same competence month as root (the starting installment),
      // so the child for the starting month is always created and filter-by-month works.
      const [sy, sm_] = newComp.split('-').map(Number);
      const remaining = Math.max(0, newTotal - (newStart - 1)); // e.g. total=8, start=1 → 8 children
      const newChildren = [];
      for (let i = 0; i < remaining; i++) {
        const monthNum = sm_ + i;                                   // starts at same month as root
        const y    = sy + Math.floor((monthNum - 1) / 12);
        const m    = ((monthNum - 1) % 12) + 1;
        const comp = `${y}-${String(m).padStart(2,'0')}`;
        const idx  = newStart + i;                                  // starts at newStart, not newStart+1
        newChildren.push({
          id:          uid(),
          date:        `${y}-${String(m).padStart(2,'0')}-01`,
          competence:  comp,
          type:        'expense',
          category:    newCat,
          description: `${descBase} (${idx}/${newTotal})`,
          value:       newValue,
          fixed:       newFixed,
          seriesId:    id,
          seriesIndex: idx,
          seriesTotal: newTotal
        });
      }
      state.entries.push(...newChildren);
      if (currentUser) {
        try {
          for (const ch of newChildren) {
            await setDoc(doc(db, 'users', currentUser.uid, 'entries', ch.id), ch);
          }
        } catch(e) {}
      }

      saveLocal(); renderAll();
      window.dispatchEvent(new Event('app:state-changed'));
      overlay.remove();
    });
    return; // end parceled branch
  }

  // ── Branch: regular entry editor ────────────────────────────────────────────
  const overlay  = document.createElement('div');
  overlay.className = 'app-edit-overlay';
  const modal = document.createElement('div');
  modal.className = 'app-edit-modal';

  const recurringNote = (entry.recurring && isInvest)
    ? `<p class="small" style="color:var(--invest);margin-bottom:12px">🔄 Entrada recorrente — editá-la afeta todos os meses a partir de <strong>${entry.competence || yyyyMmFromDate(entry.date)}</strong></p>`
    : '';

  // Build category options for investments
  const investCats = getAllInvestmentCategories();
  const defaultInvestCats = ['Renda Fixa', 'Renda Variável', 'Previdência', 'Criptomoedas', 'Outros'];
  const allInvestOpts = [...new Set([...investCats, ...defaultInvestCats])].sort();
  const investCatOptions = allInvestOpts
    .map(c => `<option value="${escapeHtml(c)}" ${entry.category === c ? 'selected' : ''}>${escapeHtml(c)}</option>`)
    .join('');

  modal.innerHTML = `
    <h3>Editar Lançamento</h3>
    ${recurringNote}
    <div class="app-row"><label>Data</label><input id="edit-date" type="date" value="${formatDateISO(entry.date)}"></div>
    <div class="app-row"><label>Competência</label><input id="edit-comp" type="month" value="${entry.competence || yyyyMmFromDate(entry.date)}"></div>
    <div class="app-row"><label>Tipo</label><select id="edit-type">
      <option value="expense" ${entry.type==='expense'?'selected':''}>Despesa</option>
      <option value="income"  ${entry.type==='income'?'selected':''}>Receita</option>
      <option value="investment" ${isInvest?'selected':''}>Investimento</option>
    </select></div>
    <div class="app-row"><label>Categoria</label>
      ${isInvest
        ? `<select id="edit-cat-select">${investCatOptions}<option value="__new__">➕ Nova categoria</option></select>
           <input id="edit-cat-text" placeholder="Nova categoria" style="display:none;margin-top:6px;padding:8px;border:1.5px solid var(--border);border-radius:6px;width:100%;font-family:inherit">`
        : `<input id="edit-cat" value="${escapeHtml(entry.category || '')}">`
      }
    </div>
    <div class="app-row"><label>Descrição</label><input id="edit-desc" value="${escapeHtml(entry.description || '')}"></div>
    <div class="app-row"><label>Valor</label><input id="edit-value" value="${entry.value || 0}"></div>
    ${isInvest
      ? `<div class="app-row"><label><input id="edit-recurring" type="checkbox" ${entry.recurring?'checked':''}>Recorrente (mensal)</label></div>`
      : `<div class="app-row"><label><input id="edit-fixed" type="checkbox" ${entry.fixed?'checked':''}>Custo fixo mensal</label></div>`
    }
    <div class="app-actions">
      <button id="edit-cancel" class="muted-button">Cancelar</button>
      <button id="edit-save" style="background:var(--accent);color:#fff">Salvar</button>
    </div>`;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Wire up new-category toggle for investment edit
  if (isInvest) {
    const catSel = modal.querySelector('#edit-cat-select');
    const catTxt = modal.querySelector('#edit-cat-text');
    if (catSel && catTxt) {
      catSel.addEventListener('change', () => {
        catTxt.style.display = catSel.value === '__new__' ? 'block' : 'none';
        if (catSel.value === '__new__') catTxt.focus();
      });
    }
  }

  modal.querySelector('#edit-cancel').addEventListener('click', () => overlay.remove());
  modal.querySelector('#edit-save').addEventListener('click', async () => {
    const newType = modal.querySelector('#edit-type').value;
    let newCat;
    if (isInvest) {
      const catSel = modal.querySelector('#edit-cat-select');
      const catTxt = modal.querySelector('#edit-cat-text');
      newCat = catSel?.value === '__new__' ? catTxt?.value.trim() : catSel?.value.trim();
    } else {
      newCat = modal.querySelector('#edit-cat')?.value.trim();
    }
    const patch = {
      date:        formatDateISO(modal.querySelector('#edit-date').value),
      competence:  modal.querySelector('#edit-comp').value,
      type:        newType,
      category:    newCat || '',
      description: modal.querySelector('#edit-desc').value.trim(),
      value:       parseNumber(modal.querySelector('#edit-value').value),
    };
    if (newType === 'investment') {
      patch.recurring = !!modal.querySelector('#edit-recurring')?.checked;
      patch.fixed = false;
      // Auto-create budget for new/updated investment category
      if (newCat && (!state.budgets[newCat] || state.budgets[newCat].kind !== 'investment')) {
        await setBudget(newCat, { budget: patch.value, default: patch.value, isFixed: false, kind: 'investment' });
      }
    } else {
      patch.fixed = !!modal.querySelector('#edit-fixed')?.checked;
      patch.recurring = (patch.fixed && patch.type === 'income') ? true : false;
    }

    // ── FIX: receita/investimento recorrente alterado só a partir do mês atual ──
    const origEntry = state.entries.find(x => x.id === id);
    const isRecurringEdit = origEntry?.recurring && (origEntry?.type === 'income' || origEntry?.type === 'investment');
    if(isRecurringEdit && patch.value !== origEntry.value){
      // Encerra o original no mês anterior ao atual
      const nowM = new Date().toISOString().slice(0,7);
      const [y,m] = nowM.split('-').map(Number);
      const prevDate = new Date(y, m-2, 1);
      const prevM = prevDate.getFullYear()+'-'+String(prevDate.getMonth()+1).padStart(2,'0');
      origEntry.recurringEnd = prevM;
      if(currentUser){
        try { await setDoc(doc(db,'users',currentUser.uid,'entries',id), origEntry); } catch(e){}
      }
      // Cria nova entrada recorrente a partir do mês atual
      const newId = uid();
      const newRec = { ...origEntry, ...patch, id: newId, competence: nowM, date: nowM+'-01', recurringEnd: null };
      state.entries.push(newRec);
      if(currentUser){
        try { await setDoc(doc(db,'users',currentUser.uid,'entries',newId), newRec); } catch(e){}
      }
      saveLocal(); renderAll();
      overlay.remove();
      return;
    }
    await updateEntry(id, patch);
    overlay.remove();
  });
};

const renameBudgetCategory = async (oldCat, newCat) => {
  if (!newCat || newCat === oldCat) return;

  // Copy budget data under new name in global budgets
  const budgetData = state.budgets[oldCat];
  if (budgetData) {
    state.budgets[newCat] = { ...budgetData };
    delete state.budgets[oldCat];
  }

  // Copy across all monthly history
  Object.keys(state.monthlyHistory || {}).forEach(month => {
    const mb = state.monthlyHistory[month]?.budgets;
    if (mb && mb[oldCat] !== undefined) {
      mb[newCat] = { ...mb[oldCat] };
      delete mb[oldCat];
    }
  });

  // Update all entries that reference the old category
  state.entries.forEach(e => {
    if (e && e.category === oldCat) e.category = newCat;
  });

  // Persist to Firestore
  if (currentUser) {
    try {
      // Budgets: delete old doc, create new
      await deleteDoc(doc(db, 'users', currentUser.uid, 'budgets', oldCat));
      if (budgetData) await setDoc(doc(db, 'users', currentUser.uid, 'budgets', newCat), { ...budgetData });
      // Monthly budgets: update all affected months
      for (const month of Object.keys(state.monthlyHistory || {})) {
        const mb = state.monthlyHistory[month]?.budgets;
        if (mb) {
          await setDoc(
            doc(db, 'users', currentUser.uid, 'monthlyBudgets', month),
            { budgets: mb, updatedAt: new Date().toISOString() },
            { merge: true }
          );
        }
      }
      // Entries: update all affected
      for (const e of state.entries) {
        if (e && e.category === newCat) {
          await setDoc(doc(db, 'users', currentUser.uid, 'entries', e.id), e);
        }
      }
    } catch(err) { console.warn('renameBudgetCategory remote:', err); }
  }
};

const editBudget = (category) => {
  const cat = String(category).trim();
  const sel = selectedFilterMonth !== 'all' ? selectedFilterMonth : new Date().toISOString().slice(0,7);
  const b   = getBudgetForMonth(cat, sel) || { budget: 0, default: 0, isFixed: false, kind: 'expense' };
  const isInvest = b.kind === 'investment';

  const overlay = document.createElement('div');
  overlay.className = 'app-edit-overlay';
  const modal = document.createElement('div');
  modal.className = 'app-edit-modal';

  const investNote = isInvest
    ? `<p class="small" style="color:var(--invest);margin-bottom:12px">💜 Meta de investimentos — define quanto você quer investir nesta categoria este mês.</p>`
    : '';

  modal.innerHTML = `
    <h3>Editar ${isInvest ? 'Meta' : 'Orçamento'}</h3>
    <p class="small" style="color:var(--accent);margin-bottom:12px">📅 Editando: <strong>${sel}</strong></p>
    ${investNote}
    <div class="app-row">
      <label>Nome da categoria</label>
      <input id="edit-cat-name" value="${escapeHtml(cat)}" placeholder="Nome da categoria">
      <span class="small muted" style="margin-top:3px">Renomear atualiza todos os lançamentos vinculados.</span>
    </div>
    <div class="app-row"><label>${isInvest ? 'Meta mensal (R$)' : 'Orçamento (R$)'}</label>
      <input id="edit-budget" value="${b.budget || 0}" type="text" inputmode="decimal">
    </div>
    ${!isInvest ? `<div class="app-row"><label><input id="edit-isFixed" type="checkbox" ${b.isFixed?'checked':''}>Custo fixo mensal</label></div>` : ''}
    <div class="app-actions">
      <button id="edit-budget-cancel" class="muted-button">Cancelar</button>
      <button id="edit-budget-save" style="background:var(--accent);color:#fff">Salvar em ${sel}</button>
    </div>`;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modal.querySelector('#edit-budget-cancel').addEventListener('click', () => overlay.remove());
  modal.querySelector('#edit-budget-save').addEventListener('click', async () => {
    const newCatName = modal.querySelector('#edit-cat-name').value.trim();
    const budget     = parseNumber(modal.querySelector('#edit-budget').value);
    const isFixed    = isInvest ? false : !!modal.querySelector('#edit-isFixed')?.checked;

    if (!newCatName) { alert('O nome da categoria não pode ficar vazio'); return; }

    // Rename first (if needed), then update budget value
    if (newCatName !== cat) {
      await renameBudgetCategory(cat, newCatName);
    }
    await setBudget(newCatName, { budget, default: budget, isFixed, kind: b.kind || 'expense' }, sel);
    overlay.remove();
  });
};

// ─── RENDERING ────────────────────────────────────────────────────────────────
const rebuildMonthOptions = () => {
  const filterEl = el('filter-month');
  if (!filterEl) return;
  const monthsSet = new Set();
  state.entries.forEach(e => {
    expandEntry(e).forEach(inst => { if (inst.competence) monthsSet.add(inst.competence); });
  });
  const current = new Date().toISOString().slice(0,7);
  const unique  = [...new Set(['all', current, ...Array.from(monthsSet).sort().reverse()])];
  filterEl.innerHTML = '';
  unique.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m === 'all' ? 'Todos os meses' : m;
    filterEl.appendChild(opt);
  });
  if (unique.includes(selectedFilterMonth)) filterEl.value = selectedFilterMonth;
  else if (unique.includes(current)) { filterEl.value = current; selectedFilterMonth = current; }
  else { filterEl.value = unique[0]; selectedFilterMonth = unique[0]; }
  window.selectedFilterMonth = selectedFilterMonth;
};

const renderKPIs = () => {
  const sel    = selectedFilterMonth !== 'all' ? selectedFilterMonth : null;
  const totals = calcTotals(sel);
  const orc    = calcOrcamentoTotal(sel);

  // Parcelas separadas
  let parcelasTotal = 0;
  state.entries.forEach(e => {
    if(!isValidEntry(e)||!e.seriesId) return;
    const comp=e.competence||yyyyMmFromDate(e.date);
    if(sel&&comp!==sel) return;
    if(!sel) return;
    parcelasTotal+=Number(e.value||0);
  });

  const totalGasto = totals.variableTotal + totals.fixedTotal + totals.investTotal;
  const saldoLivre = totals.realReceita - totalGasto;

  if (el('k-variable'))        el('k-variable').textContent        = formatMoney(totals.variableTotal);
  if (el('k-fixed'))           el('k-fixed').textContent           = formatMoney(totals.fixedTotal);
  if (el('k-invest'))          el('k-invest').textContent          = formatMoney(totals.investTotal);
  if (el('k-parcelas-total'))  el('k-parcelas-total').textContent  = formatMoney(parcelasTotal);
  if (el('k-total-gasto'))     el('k-total-gasto').textContent     = formatMoney(totalGasto);
  if (el('k-receita'))         el('k-receita').textContent         = formatMoney(totals.realReceita);
  if (el('k-receita-display')) el('k-receita-display').textContent = formatMoney(totals.realReceita);
  if (el('k-orcamento-total')) el('k-orcamento-total').textContent = formatMoney(orc.total);
  if (el('k-budget-net')) {
    el('k-budget-net').textContent = formatMoney(saldoLivre);
    el('k-budget-net').style.color = saldoLivre >= 0 ? 'var(--accent)' : 'var(--danger)';
  }
  if (el('k-budget')) el('k-budget').textContent = formatMoney(orc.orcVariavel);
  if (el('k-net'))    el('k-net').textContent    = formatMoney(saldoLivre);
  try { renderGastosRecentes(sel); } catch(e){}
};

// ── renderVariableTable ──────────────────────────────────────────────────────
// Shows:
//   1. Expense variable categories
//   2. Investment meta section: consolidated header + per-category rows
const renderVariableTable = () => {
  const tbody = qs('#variable-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const sel = selectedFilterMonth !== 'all' ? selectedFilterMonth : null;

  // ── Expense variable categories ───────────────────────────────────────────
  const catSet = new Set();
  Object.keys(state.budgets || {}).forEach(cat => {
    const b = getBudgetForMonth(cat, sel);
    if (b && !b.isFixed && b.kind === 'expense') catSet.add(cat);
  });
  state.entries.forEach(e => {
    if (!isValidEntry(e) || e.type !== 'expense') return;
    expandEntry(e, sel).forEach(inst => {
      const entry      = inst.entry;
      const eCat       = (entry.category && String(entry.category).trim()) || '(Sem categoria)';
      const budgetInfo = getBudgetForMonth(eCat, sel);
      if (!entry.fixed && !(budgetInfo && budgetInfo.isFixed)) catSet.add(eCat);
    });
  });

  const cats = Array.from(catSet).sort((a,b) => a.localeCompare(b));
  let totalSpent = 0, totalBudget = 0;

  cats.forEach(cat => {
    const b      = getBudgetForMonth(cat, sel);
    const budget = Number(b?.budget || 0);
    let spent = 0;
    state.entries.forEach(e => {
      if (!isValidEntry(e)) return;
      expandEntry(e, sel).forEach(inst => {
        const entry      = inst.entry;
        if (entry.type !== 'expense') return;
        const eCat       = (entry.category && String(entry.category).trim()) || '(Sem categoria)';
        const budgetInfo = getBudgetForMonth(eCat, sel);
        if (entry.fixed || (budgetInfo && budgetInfo.isFixed)) return;
        if (eCat !== cat) return;
        spent += Number(inst.value || 0);
      });
    });
    const pctReal = budget > 0 ? Math.round((spent / budget) * 100) : (spent > 0 ? 100 : 0);
    const pctBar  = Math.min(100, pctReal);
    let color = '#10b981';
    if (pctReal > 100) color = '#ef4444';
    else if (pctReal > 70) color = '#f59e0b';
    const tr = document.createElement('tr');
    tbody.appendChild(_buildVariableRow(tr, cat, spent, budget, pctBar, pctReal, color, false));
    totalSpent  += spent;
    totalBudget += budget;
  });

  if (el('subtotal-variable-table'))  el('subtotal-variable-table').innerHTML  = '<strong>' + formatMoney(totalSpent) + '</strong>';
  if (el('subtotal-variable-budget')) el('subtotal-variable-budget').innerHTML = '<strong>' + formatMoney(totalBudget) + '</strong>';

  // ── Investment meta section ────────────────────────────────────────────────
  _renderInvestmentSection(tbody, sel);
};

// ── _renderInvestmentSection ─────────────────────────────────────────────────
// Renders: separator → consolidated header → per-category rows
// All driven by getAllInvestmentCategories() (single source of truth)
const _renderInvestmentSection = (tbody, sel) => {
  const investCats = getAllInvestmentCategories();
  const totalInvested = calcTotals(sel).investTotal;

  // Collect per-category data
  const catData = investCats.map(cat => {
    const b       = getBudgetForMonth(cat, sel);
    const goal    = Number(b?.budget || 0);
    const invested = calcInvestByCategory(cat, sel);
    return { cat, goal, invested };
  });

  // Also collect invested from entries that have no matching budget (orphan categories)
  const orphanMap = {};
  state.entries.forEach(e => {
    if (!isValidEntry(e) || e.type !== 'investment') return;
    const eCat = (e.category && String(e.category).trim()) || '(Sem categoria)';
    if (!investCats.includes(eCat)) {
      expandEntry(e, sel).forEach(inst => {
        orphanMap[eCat] = (orphanMap[eCat] || 0) + Number(inst.value || 0);
      });
    }
  });
  Object.keys(orphanMap).forEach(cat => {
    catData.push({ cat, goal: 0, invested: orphanMap[cat] });
  });

  const totalGoal = catData.reduce((s, d) => s + d.goal, 0);
  if (catData.length === 0 && totalInvested === 0) return;

  // ── Section separator ─────────────────────────────────────────────────────
  const sep = document.createElement('tr');
  sep.innerHTML = `
    <td colspan="5" style="
      background: linear-gradient(90deg, rgba(139,92,246,0.12), rgba(139,92,246,0.04));
      padding: 8px 14px;
      font-size: 0.7rem;
      font-weight: 700;
      color: var(--invest);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      border-top: 2px solid rgba(139,92,246,0.25);
      border-bottom: 1px solid rgba(139,92,246,0.12);
    ">💜 Meta de Investimentos</td>`;
  tbody.appendChild(sep);

  // ── Consolidated header row ───────────────────────────────────────────────
  const totalPct  = totalGoal > 0 ? Math.round((totalInvested / totalGoal) * 100) : (totalInvested > 0 ? 100 : 0);
  const totalBar  = Math.min(100, totalPct);
  const totalColor = totalPct >= 100 ? '#8B5CF6' : totalPct >= 70 ? '#a78bfa' : '#c4b5fd';

  const headerRow = document.createElement('tr');
  headerRow.style.cssText = 'background: rgba(139,92,246,0.06); font-weight: 700;';

  const thName = document.createElement('td');
  thName.innerHTML = `<span style="font-weight:700;color:var(--text)">Total Investido</span>
    <span style="display:inline-block;font-size:0.65rem;color:var(--invest);background:rgba(139,92,246,0.14);padding:1px 7px;border-radius:4px;margin-left:6px;font-weight:700">${catData.length} ${catData.length === 1 ? 'categoria' : 'categorias'}</span>`;

  const thSpent = document.createElement('td');
  thSpent.className = 'right';
  thSpent.innerHTML = `<strong style="color:var(--invest)">${formatMoney(totalInvested)}</strong>`;

  const thGoal = document.createElement('td');
  thGoal.className = 'right';
  thGoal.innerHTML = `<strong>${formatMoney(totalGoal)}</strong>`;

  const thProg = document.createElement('td');
  thProg.className = 'right';
  thProg.style.minWidth = '120px';
  thProg.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px">
      <div style="flex:1;height:10px;background:rgba(139,92,246,0.15);border-radius:5px;overflow:hidden">
        <div style="height:100%;width:${totalBar}%;background:${totalColor};border-radius:5px;transition:width 0.4s"></div>
      </div>
      <span style="font-size:0.72rem;color:var(--invest);min-width:36px;font-family:DM Mono,monospace;font-weight:700">${totalPct}%</span>
    </div>`;

  const thAct = document.createElement('td');
  thAct.className = 'right';
  thAct.innerHTML = `<button class="btn-ghost" style="background:#6d28d9;font-size:0.7rem" onclick="openNewInvestmentCategoryModal()">+ Meta</button>`;

  headerRow.append(thName, thSpent, thGoal, thProg, thAct);
  tbody.appendChild(headerRow);

  // ── Per-category rows ─────────────────────────────────────────────────────
  catData.sort((a, b) => b.invested - a.invested).forEach(({ cat, goal, invested }) => {
    const pct   = goal > 0 ? Math.round((invested / goal) * 100) : (invested > 0 ? 100 : 0);
    const pBar  = Math.min(100, pct);
    const pColor = pct >= 100 ? '#8B5CF6' : pct >= 70 ? '#a78bfa' : '#c4b5fd';

    const tr = document.createElement('tr');
    tr.style.cssText = 'background: rgba(139,92,246,0.02);';

    const tdName = document.createElement('td');
    tdName.style.paddingLeft = '24px';
    tdName.innerHTML = `<span style="color:var(--text-2);font-size:0.82rem">${escapeHtml(cat)}</span>`;

    const tdSpent = document.createElement('td');
    tdSpent.className = 'right';
    tdSpent.innerHTML = `<span style="color:var(--invest)">${formatMoney(invested)}</span>`;

    const tdGoal = document.createElement('td');
    tdGoal.className = 'right';
    tdGoal.innerHTML = goal > 0 ? formatMoney(goal) : `<span style="color:var(--text-3);font-size:0.75rem">— sem meta</span>`;

    const tdProg = document.createElement('td');
    tdProg.className = 'right';
    tdProg.style.minWidth = '120px';
    if (goal > 0) {
      tdProg.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px">
          <div style="flex:1;height:6px;background:rgba(139,92,246,0.12);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${pBar}%;background:${pColor};border-radius:3px;transition:width 0.4s"></div>
          </div>
          <span style="font-size:0.72rem;color:var(--text-2);min-width:36px;font-family:DM Mono,monospace">${pct}%</span>
        </div>`;
    } else {
      tdProg.innerHTML = `<span style="font-size:0.72rem;color:var(--text-3)">—</span>`;
    }

    const tdAct = document.createElement('td');
    tdAct.className = 'right';
    if (goal > 0) {
      const btnEdit = document.createElement('button');
      btnEdit.className = 'btn-ghost';
      btnEdit.style.cssText = 'background:#6d28d9;font-size:0.7rem';
      btnEdit.textContent = 'Editar';
      btnEdit.addEventListener('click', () => editBudget(cat));
      tdAct.appendChild(btnEdit);
    } else {
      const btnSet = document.createElement('button');
      btnSet.className = 'btn-ghost';
      btnSet.style.cssText = 'background:rgba(139,92,246,0.3);font-size:0.7rem;border:1px dashed rgba(139,92,246,0.5)';
      btnSet.textContent = '+ Meta';
      btnSet.addEventListener('click', () => _openSetInvestGoal(cat));
      tdAct.appendChild(btnSet);
    }

    tr.append(tdName, tdSpent, tdGoal, tdProg, tdAct);
    tbody.appendChild(tr);
  });
};

// ── _openSetInvestGoal ─────────────────────────────────────────────────────
// Quick modal to set a goal for an existing investment category
const _openSetInvestGoal = (cat) => {
  const sel = selectedFilterMonth !== 'all' ? selectedFilterMonth : new Date().toISOString().slice(0,7);
  const overlay = document.createElement('div');
  overlay.className = 'app-edit-overlay';
  const modal = document.createElement('div');
  modal.className = 'app-edit-modal';
  modal.innerHTML = `
    <h3>Definir Meta de Investimento</h3>
    <p class="small muted">Categoria: <strong>${escapeHtml(cat)}</strong> · mês: <strong>${sel}</strong></p>
    <div class="app-row"><label>Meta mensal (R$)</label>
      <input id="set-goal-value" value="0" type="text" inputmode="decimal">
    </div>
    <div class="app-actions">
      <button id="set-goal-cancel" class="muted-button">Cancelar</button>
      <button id="set-goal-save" style="background:var(--invest);color:#fff">Definir Meta</button>
    </div>`;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modal.querySelector('#set-goal-cancel').addEventListener('click', () => overlay.remove());
  modal.querySelector('#set-goal-save').addEventListener('click', async () => {
    const budget = parseNumber(modal.querySelector('#set-goal-value').value);
    await setBudget(cat, { budget, default: budget, isFixed: false, kind: 'investment' }, sel);
    overlay.remove();
  });
};

const _buildVariableRow = (tr, cat, spent, budget, pctBar, pctReal, color, isInvest) => {
  const tdName = document.createElement('td');
  tdName.innerHTML = escapeHtml(cat) + (isInvest ? ' <span style="font-size:0.65rem;color:var(--invest);font-weight:700;background:rgba(139,92,246,0.12);padding:1px 6px;border-radius:4px">Investimentos</span>' : '');
  const tdSpent  = document.createElement('td'); tdSpent.className  = 'right'; tdSpent.innerHTML  = formatMoney(spent);
  const tdBudget = document.createElement('td'); tdBudget.className = 'right'; tdBudget.innerHTML = formatMoney(budget);
  const tdProgress = document.createElement('td'); tdProgress.className = 'right'; tdProgress.style.minWidth = '120px';
  tdProgress.innerHTML = `<div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden"><div style="height:100%;width:${pctBar}%;background:${color};transition:width 0.3s"></div></div><span style="font-size:0.72rem;color:var(--text-2);min-width:36px;font-family:DM Mono,monospace">${pctReal}%</span></div>`;
  const tdActions = document.createElement('td'); tdActions.className = 'right';
  const btnEdit   = document.createElement('button'); btnEdit.className = 'btn-ghost'; btnEdit.style.background = isInvest ? '#6d28d9' : '#334155'; btnEdit.textContent = 'Editar'; btnEdit.addEventListener('click', () => editBudget(cat));
  const btnRemove = document.createElement('button'); btnRemove.className = 'btn-ghost'; btnRemove.style.background = '#ef4444'; btnRemove.style.marginLeft = '6px'; btnRemove.textContent = 'Remover'; btnRemove.addEventListener('click', () => removeBudget(cat));
  tdActions.appendChild(btnEdit); tdActions.appendChild(btnRemove);
  tr.appendChild(tdName); tr.appendChild(tdSpent); tr.appendChild(tdBudget); tr.appendChild(tdProgress); tr.appendChild(tdActions);
  return tr;
};

const updateGlobalProgressBar = () => {
  const labelEl = el('global-progress-label');
  const barEl   = el('global-progress-bar');
  const titleEl = el('progress-title-display');
  if (!labelEl || !barEl) return;
  const sel    = selectedFilterMonth !== 'all' ? selectedFilterMonth : null;
  const totals = calcTotals(sel);
  const orc    = calcOrcamentoTotal(sel);
  const numerator   = totals.variableTotal + totals.fixedTotal + totals.investTotal;
  const denominator = orc.total;
  const pctReal = denominator > 0 ? Math.round((numerator / denominator) * 100) : (numerator > 0 ? 100 : 0);
  const pctBar  = Math.min(100, pctReal);
  let color = '#10C9A0';
  if (pctReal > 100) color = '#F0483A';
  else if (pctReal > 70) color = '#F5A623';
  labelEl.textContent = `Mês: ${sel || 'todos'}`;
  if (titleEl) titleEl.textContent = `${formatMoney(numerator)} / ${formatMoney(denominator)}`;
  barEl.style.width      = pctBar + '%';
  barEl.style.background = color;
  barEl.textContent      = pctReal + '%';
};

// ✅ FIX: usa expandEntry para receitas recorrentes aparecerem em todos os meses corretos,
// exatamente como renderInvestmentTable faz para investimentos recorrentes.
const renderIncomeTable = () => {
  const tbody = qs('#incomes-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const sel = selectedFilterMonth !== 'all' ? selectedFilterMonth : null;

  const rows = [];
  state.entries.forEach(e => {
    if (!isValidEntry(e) || e.type !== 'income') return;
    expandEntry(e, sel).forEach(inst => {
      rows.push({ entry: e, competence: inst.competence, value: inst.value });
    });
  });

  if (rows.length === 0) { tbody.innerHTML = '<tr><td colspan="5" class="muted">Nenhuma receita</td></tr>'; return; }
  rows.sort((a, b) => new Date(b.entry.date) - new Date(a.entry.date));

  let total = 0;
  rows.forEach(({ entry: e, value }) => {
    total += Number(value || 0);
    const fixedBadge = e.recurring
      ? ' <span style="font-size:0.65rem;color:var(--accent);background:rgba(16,201,160,0.12);padding:1px 6px;border-radius:4px;font-weight:700">🔄 Fixa</span>'
      : '';
    const tr = document.createElement('tr');
    tr.style.borderLeft = e.recurring ? '3px solid rgba(16,201,160,0.4)' : '';
    const tdDate = document.createElement('td'); tdDate.textContent = formatDateISO(e.date);
    const tdCat  = document.createElement('td'); tdCat.textContent  = escapeHtml(e.category || '');
    const tdDesc = document.createElement('td'); tdDesc.innerHTML   = escapeHtml(e.description || '') + fixedBadge;
    const tdVal  = document.createElement('td'); tdVal.className = 'right'; tdVal.innerHTML = formatMoney(value);
    const tdAct  = document.createElement('td'); tdAct.className = 'right';
    const bEdit  = document.createElement('button'); bEdit.className = 'btn-ghost'; bEdit.style.background = '#334155'; bEdit.textContent = 'Editar'; bEdit.addEventListener('click', () => editEntry(e.id));
    const bDel   = document.createElement('button'); bDel.className  = 'btn-ghost'; bDel.style.background  = '#ef4444'; bDel.style.marginLeft = '6px';
    bDel.textContent = 'Excluir';
    bDel.addEventListener('click', () => {
      const msg = e.recurring
        ? 'Excluir esta receita fixa? Ela será removida de TODOS os meses.'
        : 'Excluir receita?';
      if (!confirm(msg)) return;
      deleteEntry(e.id);
    });
    tdAct.appendChild(bEdit); tdAct.appendChild(bDel);
    tr.append(tdDate, tdCat, tdDesc, tdVal, tdAct);
    tbody.appendChild(tr);
  });
  if (el('subtotal-incomes')) el('subtotal-incomes').innerHTML = '<strong>' + formatMoney(total) + '</strong>';
};

// ── renderInvestmentTable ─────────────────────────────────────────────────────
// ✅ FIX: uses expandEntry which now correctly handles recurring in future months
const renderInvestmentTable = () => {
  const tbody = qs('#investments-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const sel = selectedFilterMonth !== 'all' ? selectedFilterMonth : null;

  const rows = [];
  state.entries.forEach(e => {
    if (!isValidEntry(e) || e.type !== 'investment') return;
    expandEntry(e, sel).forEach(inst => {
      rows.push({ entry: e, competence: inst.competence, value: inst.value });
    });
  });

  if (rows.length === 0) { tbody.innerHTML = '<tr><td colspan="5" class="muted">Nenhum investimento</td></tr>'; return; }
  rows.sort((a,b) => new Date(b.entry.date) - new Date(a.entry.date));

  let total = 0;
  rows.forEach(({ entry: e, value }) => {
    total += Number(value || 0);
    const recurringBadge = e.recurring
      ? ' <span style="font-size:0.65rem;color:var(--invest);background:rgba(139,92,246,0.12);padding:1px 6px;border-radius:4px;font-weight:700">🔄 Recorrente</span>'
      : '';
    const tr = document.createElement('tr');
    tr.style.borderLeft = e.recurring ? '3px solid rgba(139,92,246,0.4)' : '';
    const tdDate = document.createElement('td'); tdDate.textContent = formatDateISO(e.date);
    const tdCat  = document.createElement('td'); tdCat.innerHTML  = escapeHtml(e.category || '') + recurringBadge;
    const tdDesc = document.createElement('td'); tdDesc.textContent = escapeHtml(e.description || '');
    const tdVal  = document.createElement('td'); tdVal.className = 'right'; tdVal.style.color = 'var(--invest)'; tdVal.innerHTML = formatMoney(value);
    const tdAct  = document.createElement('td'); tdAct.className = 'right';
    const bEdit = document.createElement('button'); bEdit.className = 'btn-ghost'; bEdit.style.background = '#334155'; bEdit.textContent = 'Editar'; bEdit.addEventListener('click', () => editEntry(e.id));
    const bDel  = document.createElement('button'); bDel.className  = 'btn-ghost'; bDel.style.background  = '#ef4444'; bDel.style.marginLeft = '6px'; bDel.textContent = 'Excluir';
    bDel.addEventListener('click', () => {
      const msg = e.recurring
        ? 'Excluir este investimento recorrente? Ele será removido de TODOS os meses.'
        : 'Excluir investimento?';
      if (!confirm(msg)) return;
      deleteEntry(e.id);
    });
    tdAct.appendChild(bEdit); tdAct.appendChild(bDel);
    tr.append(tdDate, tdCat, tdDesc, tdVal, tdAct);
    tbody.appendChild(tr);
  });
  if (el('subtotal-investments')) el('subtotal-investments').innerHTML = '<strong>' + formatMoney(total) + '</strong>';
};

const renderParcelTable = () => {
  const tbody = qs('#parcelas-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const sel   = selectedFilterMonth !== 'all' ? selectedFilterMonth : null;
  const roots = state.entries.filter(e => e && e.series && e.series.total && Number(e.series.total) > 1);
  if (roots.length === 0) { tbody.innerHTML = '<tr><td colspan="6" class="muted">Nenhuma parcela</td></tr>'; return; }
  let total = 0;

  roots.forEach(root => {
    const children = state.entries.filter(e => e.seriesId === root.id);
    // Strip any legacy "(X/Y)" suffix from root description for clean display
    const baseDesc = (root.description || '').replace(/ \(\d+\/\d+\)$/, '');

    let displayValue = 0;
    let parcelLabel  = '';

    if (sel) {
      // ── Filtered mode: find the child whose competence matches the filter ──
      if (children.length === 0) return; // no children yet, skip
      const child = children.find(c => c.competence === sel);
      if (!child) return; // this series has no installment in the selected month
      displayValue = Number(child.value || 0);
      parcelLabel  = `${child.seriesIndex}/${root.series.total}`;
    } else {
      // ── All-months mode: sum all children, show range ─────────────────────
      if (children.length > 0) {
        displayValue = children.reduce((sum, c) => sum + Number(c.value || 0), 0);
        const minIdx = Math.min(...children.map(c => Number(c.seriesIndex || 1)));
        const maxIdx = Math.max(...children.map(c => Number(c.seriesIndex || 1)));
        parcelLabel  = minIdx === maxIdx
          ? `${minIdx}/${root.series.total}`
          : `${minIdx}–${maxIdx}/${root.series.total}`;
      } else {
        // Root only (no children yet)
        displayValue = Number(root.value || 0);
        parcelLabel  = `${root.series.startIndex || 1}/${root.series.total}`;
      }
    }

    total += displayValue;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${root.series.start || ''}</td>
      <td>${escapeHtml(root.category || '')}</td>
      <td>${escapeHtml(baseDesc)}</td>
      <td>${parcelLabel}</td>
      <td class="right">${formatMoney(displayValue)}</td>
      <td class="right">
        <button class="btn-ghost" style="background:#334155" onclick="editEntry('${root.id}')">Editar</button>
        <button class="btn-ghost" style="background:#ef4444;margin-left:4px" onclick="deleteEntry('${root.id}')">Excluir</button>
      </td>`;
    tbody.appendChild(tr);
  });

  if (el('subtotal-parcelas')) el('subtotal-parcelas').innerHTML = '<strong>' + formatMoney(total) + '</strong>';
};

const renderFixedTable = () => {
  const tbody = qs('#fixed-list-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const sel = selectedFilterMonth !== 'all' ? selectedFilterMonth : null;
  const catSet = new Set([
    ...Object.keys(state.budgets || {}),
    ...(sel && state.monthlyHistory?.[sel]?.budgets ? Object.keys(state.monthlyHistory[sel].budgets) : [])
  ]);
  const fixedCats = Array.from(catSet).filter(cat => {
    const b = getBudgetForMonth(cat, sel);
    return b && b.isFixed && b.kind === 'expense';
  }).sort();
  if (fixedCats.length === 0) { tbody.innerHTML = '<tr><td colspan="3" class="muted">Nenhuma conta fixa neste mês</td></tr>'; return; }
  let total = 0;
  fixedCats.forEach(cat => {
    const b   = getBudgetForMonth(cat, sel);
    const val = Number(b.default || b.budget || 0);
    total += val;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(cat)}</td><td class="right">${formatMoney(val)}</td><td class="right"><button class="btn-ghost" style="background:#334155" onclick="editBudget('${cat.replace(/'/g,"\'")}')">Editar</button><button class="btn-ghost" style="background:#ef4444;margin-left:4px" onclick="removeBudget('${cat.replace(/'/g,"\'")}')">Remover</button></td>`;
    tbody.appendChild(tr);
  });
  if (el('subtotal-fixed-list')) el('subtotal-fixed-list').innerHTML = '<strong>' + formatMoney(total) + '</strong>';
  const fixedMonthEl = el('fixed-active-month');
  if (fixedMonthEl) fixedMonthEl.textContent = sel || 'todos';
};

const renderBudgetTable = () => {
  const tbody = qs('#modal-budgets-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const sel = selectedFilterMonth !== 'all' ? selectedFilterMonth : null;
  const catSet = new Set([
    ...Object.keys(state.budgets || {}),
    ...(sel && state.monthlyHistory?.[sel]?.budgets ? Object.keys(state.monthlyHistory[sel].budgets) : [])
  ]);
  const cats = Array.from(catSet).filter(cat => {
    const b = getBudgetForMonth(cat, sel);
    return b && !b.isFixed && b.kind !== 'income';
  }).sort();
  const monthLabelEl = el('budget-active-month');
  if (monthLabelEl) monthLabelEl.textContent = sel || 'todos';
  if (cats.length === 0) { tbody.innerHTML = '<tr><td colspan="3" class="muted">Nenhum orçamento variável neste mês</td></tr>'; return; }
  let total = 0;
  cats.forEach(cat => {
    const b           = getBudgetForMonth(cat, sel);
    const val         = Number(b.budget || 0);
    const isInvestCat = b.kind === 'investment';
    total += val;
    const hasMonthOverride = sel && state.monthlyHistory?.[sel]?.budgets?.[cat];
    const badge = isInvestCat
      ? ' <span style="font-size:0.65rem;background:rgba(139,92,246,0.12);color:var(--invest);padding:1px 6px;border-radius:4px;font-weight:700">💜 Meta Invest</span>'
      : (hasMonthOverride ? '' : ' <span style="font-size:0.65rem;color:var(--text-3);font-weight:400">(padrão)</span>');
    const tr = document.createElement('tr');
    if (isInvestCat) tr.style.background = 'rgba(139,92,246,0.03)';
    tr.innerHTML = `<td>${escapeHtml(cat)}${badge}</td><td class="right">${formatMoney(val)}</td><td class="right"><button class="btn-ghost" style="background:${isInvestCat?'#6d28d9':'#334155'}" onclick="editBudget('${cat.replace(/'/g,"\'")}')">Editar</button><button class="btn-ghost" style="background:#ef4444;margin-left:4px" onclick="removeBudget('${cat.replace(/'/g,"\'")}')">Remover</button></td>`;
    tbody.appendChild(tr);
  });
  if (el('subtotal-budgets')) el('subtotal-budgets').innerHTML = '<strong>' + formatMoney(total) + '</strong>';
};

const renderAllEntriesTable = () => {
  const tbody = qs('#entries-table-duplicate tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const sel = selectedFilterMonth !== 'all' ? selectedFilterMonth : null;
  const displayRows = [];
  state.entries.forEach(e => {
    if (!isValidEntry(e)) return;
    if (e.series && e.series.total && Number(e.series.total) > 1 && !e.seriesId) {
      const hasChildren = state.entries.some(ch => ch && ch.seriesId === e.id);
      if (hasChildren) return;
    }
    // ✅ expandEntry handles recurring correctly for any filterMonth
    expandEntry(e, sel).forEach(inst => {
      displayRows.push({ entry: e, competence: inst.competence, value: inst.value });
    });
  });
  displayRows.sort((a, b) => new Date(b.entry.date) - new Date(a.entry.date));
  if (displayRows.length === 0) { tbody.innerHTML = '<tr><td colspan="7" class="muted">Nenhum lançamento</td></tr>'; return; }
  let total = 0;
  displayRows.forEach(({ entry: e, competence: comp, value }) => {
    total += Number(value || 0);
    const typeLabel = e.type === 'income' ? 'Receita' : (e.type === 'investment' ? 'Investimento' : 'Despesa');
    const recurBadge = e.recurring ? ' 🔄' : '';
    const tr = document.createElement('tr');
    if (e.type === 'investment') tr.style.borderLeft = '3px solid rgba(139,92,246,0.4)';
    const tdComp = document.createElement('td'); tdComp.textContent = comp;
    const tdDate = document.createElement('td'); tdDate.textContent = formatDateISO(e.date);
    const tdType = document.createElement('td'); tdType.textContent = typeLabel + recurBadge;
    if (e.type === 'investment') tdType.style.color = 'var(--invest)';
    const tdCat  = document.createElement('td'); tdCat.textContent  = escapeHtml(e.category || '');
    const tdDesc = document.createElement('td'); tdDesc.textContent = escapeHtml(e.description || '');
    const tdVal  = document.createElement('td'); tdVal.className = 'right'; tdVal.innerHTML = formatMoney(value);
    if (e.type === 'investment') tdVal.style.color = 'var(--invest)';
    const tdAct  = document.createElement('td'); tdAct.className = 'right';
    const bEdit  = document.createElement('button'); bEdit.className = 'btn-ghost'; bEdit.style.background = '#334155'; bEdit.textContent = 'Editar'; bEdit.addEventListener('click', () => editEntry(e.id));
    const bDel   = document.createElement('button'); bDel.className  = 'btn-ghost'; bDel.style.background  = '#ef4444'; bDel.style.marginLeft = '6px'; bDel.textContent = 'Excluir'; bDel.addEventListener('click', () => deleteEntry(e.id));
    tdAct.appendChild(bEdit); tdAct.appendChild(bDel);
    tr.append(tdComp, tdDate, tdType, tdCat, tdDesc, tdVal, tdAct);
    tbody.appendChild(tr);
  });
  if (el('subtotal-entries')) el('subtotal-entries').innerHTML = '<strong>' + formatMoney(total) + '</strong>';
};

const renderMonthlyProjection = () => {
  const tbody = qs('#monthly-projection tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const startMonth = selectedFilterMonth !== 'all' ? selectedFilterMonth : new Date().toISOString().slice(0,7);
  const [sy, sm_]  = startMonth.split('-').map(Number);
  const months = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(sy, sm_ - 1 + i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
  }
  const rows = months.map(month => {
    const totals = calcTotals(month);
    const orc    = calcOrcamentoTotal(month);
    const entradas  = totals.realReceita;
    const saidas    = totals.variableTotal + totals.fixedTotal + totals.investTotal;
    const planejado = orc.total;
    const saldo     = entradas - saidas;
    return { month, entradas, saidas, planejado, saldo };
  });
  rows.forEach(r => {
    const saldoColor = r.saldo >= 0 ? 'var(--accent)' : 'var(--danger)';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.month}</td><td class="right">${formatMoney(r.entradas)}</td><td class="right">${formatMoney(r.saidas)}</td><td class="right">${formatMoney(r.planejado)}</td><td class="right" style="color:${saldoColor}">${formatMoney(r.saldo)}</td>`;
    tbody.appendChild(tr);
  });
  const tE = rows.reduce((s,r) => s+r.entradas, 0);
  const tS = rows.reduce((s,r) => s+r.saidas, 0);
  const tP = rows.reduce((s,r) => s+r.planejado, 0);
  if (el('subtotal-monthly-entradas'))  el('subtotal-monthly-entradas').innerHTML  = '<strong>' + formatMoney(tE) + '</strong>';
  if (el('subtotal-monthly-saidas'))    el('subtotal-monthly-saidas').innerHTML    = '<strong>' + formatMoney(tS) + '</strong>';
  if (el('subtotal-monthly-planejado')) el('subtotal-monthly-planejado').innerHTML = '<strong>' + formatMoney(tP) + '</strong>';
  if (el('subtotal-monthly-saldo'))     el('subtotal-monthly-saldo').innerHTML     = '<strong>' + formatMoney(tE-tS) + '</strong>';
  try {
    const canvas = el('monthlyChart');
    if (canvas && typeof Chart !== 'undefined') {
      const labels   = rows.map(r => r.month);
      const datasets = [
        { label:'Entradas',  data:rows.map(r=>r.entradas),  type:'bar',  backgroundColor:'#10C9A0' },
        { label:'Saídas',    data:rows.map(r=>r.saidas),    type:'bar',  backgroundColor:'#F0483A' },
        { label:'Planejado', data:rows.map(r=>r.planejado), type:'line', borderColor:'#3B82F6', backgroundColor:'rgba(59,130,246,0.1)', borderWidth:2, fill:true, tension:0.3 }
      ];
      if (window._monthlyChartInstance) {
        window._monthlyChartInstance.data.labels   = labels;
        window._monthlyChartInstance.data.datasets = datasets;
        window._monthlyChartInstance.update();
      } else {
        window._monthlyChartInstance = new Chart(canvas.getContext('2d'), {
          data: { labels, datasets },
          options: { responsive:true, maintainAspectRatio:false, interaction:{ mode:'index', intersect:false }, scales:{ y:{ beginAtZero:true, ticks:{ callback:v=>'R$'+Number(v).toLocaleString('pt-BR') } } }, plugins:{ legend:{ position:'bottom', labels:{ font:{ family:'DM Sans', size:12 }, padding:16 } } } }
        });
      }
    }
  } catch(e) { console.warn('Chart error:', e); }
};

const renderAll = () => {
  try {
    try { populateCategorySelect(); } catch(e) {}
    rebuildMonthOptions();
    renderKPIs();
    renderVariableTable();
    updateGlobalProgressBar();
    renderIncomeTable();
    renderInvestmentTable();
    renderParcelTable();
    renderFixedTable();
    renderBudgetTable();
    renderAllEntriesTable();
    renderMonthlyProjection();
    // Novos renderizadores
    try { renderOrcamentoNovo(); } catch(e) { console.warn('renderOrcamentoNovo',e); }
    try { renderLembretes(); } catch(e) {}
    try { renderGastosRecentes(selectedFilterMonth !== 'all' ? selectedFilterMonth : null); } catch(e) {}
    try { renderAnalyticTab(analCurrentTab); } catch(e) {}
    try { updateDashboardParcelas(); } catch(e) {}
    try { renderGastosDiarios(); } catch(e) {}
  } catch(e) { console.error('renderAll:', e); }
};

// Atualiza total de parcelas no KPI do dashboard
function updateDashboardParcelas(){
  const sel = selectedFilterMonth !== 'all' ? selectedFilterMonth : null;
  let totalParcelas = 0;
  state.entries.forEach(e => {
    if(!isValidEntry(e)||!e.seriesId) return;
    const comp=e.competence||yyyyMmFromDate(e.date);
    if(sel&&comp!==sel) return;
    if(!sel) return;
    totalParcelas+=Number(e.value||0);
  });
  const el2=el('k-parcelas-total');
  if(el2) el2.textContent=formatMoney(totalParcelas);
}

// ─── LEMBRETES (Contas a Pagar) ───────────────────────────────────────────────
const LEMBRETES_KEY = 'finance_lembretes_v1';
let lembretes = JSON.parse(localStorage.getItem(LEMBRETES_KEY) || '[]');

function saveLembretes(){
  localStorage.setItem(LEMBRETES_KEY, JSON.stringify(lembretes));
  try {
    if(window.db && currentUser){
      db.collection('users').doc(currentUser.uid).collection('lembretes')
        .doc('list').set({ items: lembretes }, { merge: true });
    }
  } catch(e){}
}

function loadLembretesFromCloud(){
  if(!window.db || !currentUser) return;
  db.collection('users').doc(currentUser.uid).collection('lembretes')
    .doc('list').get().then(doc => {
      if(doc.exists && doc.data().items){
        lembretes = doc.data().items;
        localStorage.setItem(LEMBRETES_KEY, JSON.stringify(lembretes));
        renderLembretes();
      }
    }).catch(e => console.error('loadLembretes', e));
}

function renderLembretes(){
  const container = el('lembretes-list');
  if(!container) return;
  const now = new Date();
  const mes = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  const hoje = now.getDate();
  if(!lembretes.length){
    container.innerHTML = '<div class="lembrete-empty small muted">Nenhuma conta. Clique em "+ Adicionar" para criar.</div>';
    return;
  }
  const sorted = [...lembretes].sort((a,b) => {
    const ap = a.pago?.[mes]?.pago||false, bp = b.pago?.[mes]?.pago||false;
    if(ap!==bp) return ap?1:-1;
    return (a.dia||31)-(b.dia||31);
  });

  const pendentes = sorted.filter(l => !l.pago?.[mes]?.pago);
  const pagas     = sorted.filter(l =>  l.pago?.[mes]?.pago);

  function buildItem(l, pago){
    const mesData = l.pago?.[mes]||{};
    const valorRef = mesData.valorReal!=null ? mesData.valorReal : (l.valor||0);
    const diasR = (l.dia||0) - hoje;
    const vencido = diasR < 0;
    const urgente = diasR >= 0 && diasR <= 3;
    let statusClass='lembrete-pendente', statusText=l.dia?`Vence dia ${l.dia}`:'Sem vencimento';
    if(pago)    { statusClass='lembrete-pago';    statusText=`Pago em ${mesData.dataPago||mes} · ${formatMoney(valorRef)}`; }
    else if(vencido){ statusClass='lembrete-vencido'; statusText=`⚠️ Vencida (dia ${l.dia})`; }
    else if(urgente){ statusClass='lembrete-urgente'; statusText=`🔥 Vence em ${diasR}d`; }
    const valorExibido = l.fixo ? formatMoney(l.valor||0) : (valorRef>0?formatMoney(valorRef):'Valor variável');
    return `<div class="lembrete-item ${statusClass}">
      <div class="lembrete-body" style="flex:1">
        <div class="lembrete-desc ${pago?'pago-text':''}">${escapeHtml(l.desc||'')}</div>
        <div class="lembrete-meta">
          <span class="lembrete-status-badge">${statusText}</span>
          ${l.cat?`<span class="lembrete-cat">${escapeHtml(l.cat)}</span>`:''}
          <span class="lembrete-cat" style="color:var(--text-2)">${valorExibido}</span>
        </div>
      </div>
      <div class="lembrete-valor-wrap">
        ${!pago ? `<button class="lembrete-pagar-btn" onclick="abrirConfirmarPagamento('${l.id}')">Pagar</button>` : `<span class="lembrete-check-paid">✓</span>`}
        <div class="lembrete-actions">
          <button class="lembrete-edit-btn" onclick="editLembrete('${l.id}')">✏️</button>
          <button class="lembrete-del-btn" onclick="deleteLembrete('${l.id}')">✕</button>
        </div>
      </div>
    </div>`;
  }

  let html = '';
  if(pendentes.length){
    html += `<div class="lembrete-section-title">Pendentes (${pendentes.length})</div>`;
    html += pendentes.map(l=>buildItem(l,false)).join('');
  }
  if(pagas.length){
    html += `<div class="lembrete-section-title" style="margin-top:10px;color:var(--text-3)">Pagas este mês (${pagas.length})</div>`;
    html += pagas.map(l=>buildItem(l,true)).join('');
  }
  container.innerHTML = html;
}

function abrirConfirmarPagamento(id){
  const l = lembretes.find(x=>x.id===id); if(!l) return;
  const modal = el('lembrete-pagar-modal-back'); if(!modal) return;
  el('lembrete-pagar-id').value = id;
  const valorInp = el('lembrete-pagar-valor');
  if(valorInp) valorInp.value = l.valor>0 ? l.valor.toFixed(2) : '';
  const dataInp = el('lembrete-pagar-data');
  if(dataInp) dataInp.value = new Date().toISOString().slice(0,10);
  const catInp = el('lembrete-pagar-cat');
  if(catInp) catInp.value = l.cat||'';
  modal.style.display = 'flex';
}
window.abrirConfirmarPagamento = abrirConfirmarPagamento;

function initPagarModal(){
  el('lembrete-pagar-cancel')?.addEventListener('click',()=>{
    const m=el('lembrete-pagar-modal-back'); if(m) m.style.display='none';
  });
  el('lembrete-pagar-confirm')?.addEventListener('click', async()=>{
    const id = el('lembrete-pagar-id')?.value;
    const valor = parseFloat(el('lembrete-pagar-valor')?.value)||0;
    const data = el('lembrete-pagar-data')?.value||new Date().toISOString().slice(0,10);
    const cat = (el('lembrete-pagar-cat')?.value||'').trim()||'Outros';
    const l = lembretes.find(x=>x.id===id); if(!l) return;

    // Mark as paid in lembrete
    const mes = new Date().toISOString().slice(0,7);
    if(!l.pago) l.pago={};
    l.pago[mes] = { pago:true, valorReal:valor, dataPago:data };
    saveLembretes();

    // Create actual expense entry
    try {
      const desc = l.desc || 'Conta paga';
      const entry = {
        id: uid(), type:'expense', fixed:false,
        value: valor, date: data,
        competence: data.slice(0,7),
        category: cat, description: desc,
        _fromLembrete: id, createdAt: new Date().toISOString()
      };
      state.entries.push(entry);
      saveLocal();
      if(currentUser && window.db){
        await db.collection('users').doc(currentUser.uid).collection('entries').doc(entry.id).set(entry);
      }
      dispatchEvent(new Event('app:state-changed'));
    } catch(err){ console.error('lembrete launch entry',err); }

    renderLembretes();
    const m=el('lembrete-pagar-modal-back'); if(m) m.style.display='none';

    // Toast
    const toast=document.createElement('div');
    toast.textContent=`✅ Pagamento de ${formatMoney(valor)} lançado!`;
    toast.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#012b29;color:#fff;padding:12px 24px;border-radius:10px;font-weight:700;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.3)';
    document.body.appendChild(toast); setTimeout(()=>toast.remove(),3000);
  });
}

function toggleLembretePago(id){
  // Now handled by abrirConfirmarPagamento
  abrirConfirmarPagamento(id);
}
function updateLembreteValorMes(id,val){
  const l=lembretes.find(x=>x.id===id); if(!l) return;
  const mes=new Date().toISOString().slice(0,7);
  if(!l.pago) l.pago={};
  l.pago[mes]={...(l.pago[mes]||{}), valorReal:parseFloat(val)||0};
  saveLembretes();
}
function editLembrete(id){
  const l=lembretes.find(x=>x.id===id); if(!l) return;
  const modal=el('lembrete-modal-back'); if(!modal) return;
  el('lembrete-modal-title').textContent='Editar Lembrete';
  el('lembrete-edit-id').value=id;
  el('lembrete-desc').value=l.desc||'';
  el('lembrete-valor').value=l.valor||0;
  el('lembrete-dia').value=l.dia||'';
  el('lembrete-cat').value=l.cat||'';
  modal.style.display='flex';
}
function deleteLembrete(id){
  if(!confirm('Excluir este lembrete?')) return;
  lembretes=lembretes.filter(x=>x.id!==id);
  saveLembretes(); renderLembretes();
}
function initLembretes(){
  function openLembreteModal(id){
    const modal=el('lembrete-modal-back'); if(!modal) return;
    if(id){
      const l=lembretes.find(x=>x.id===id); if(!l) return;
      el('lembrete-modal-title').textContent='Editar Conta';
      el('lembrete-edit-id').value=id;
      el('lembrete-desc').value=l.desc||'';
      el('lembrete-cat').value=l.cat||'';
      el('lembrete-dia').value=l.dia||'';
      el('lembrete-valor').value=l.valor||'';
      if(el('lembrete-fixo')) el('lembrete-fixo').checked=!!l.fixo;
    } else {
      el('lembrete-modal-title').textContent='Nova Conta a Pagar';
      el('lembrete-edit-id').value='';
      ['lembrete-desc','lembrete-cat'].forEach(i=>{const e=el(i);if(e)e.value='';});
      ['lembrete-valor','lembrete-dia'].forEach(i=>{const e=el(i);if(e)e.value='';});
      if(el('lembrete-fixo')) el('lembrete-fixo').checked=false;
    }
    modal.style.display='flex';
  }

  el('btn-add-lembrete')?.addEventListener('click',()=>openLembreteModal(null));
  el('lembrete-cancel')?.addEventListener('click',()=>{ const m=el('lembrete-modal-back');if(m)m.style.display='none'; });

  // Toggle valor label based on fixo
  el('lembrete-fixo')?.addEventListener('change', e=>{
    const lbl=el('lembrete-valor-label');
    if(lbl) lbl.textContent=e.target.checked?'Valor fixo (R$)':'Valor estimado (R$) — pode mudar ao pagar';
  });

  el('lembrete-save')?.addEventListener('click',()=>{
    const id=el('lembrete-edit-id')?.value;
    const desc=(el('lembrete-desc')?.value||'').trim();
    const cat=(el('lembrete-cat')?.value||'').trim();
    const dia=parseInt(el('lembrete-dia')?.value)||null;
    const fixo=!!(el('lembrete-fixo')?.checked);
    const valor=parseFloat(el('lembrete-valor')?.value)||0;
    if(!desc){alert('Descreva a conta');return;}
    if(id){
      const l=lembretes.find(x=>x.id===id);
      if(l){l.desc=desc;l.cat=cat;l.dia=dia;l.fixo=fixo;l.valor=valor;}
    } else {
      lembretes.push({id:'l'+Date.now(),desc,cat,dia,fixo,valor,pago:{}});
    }
    saveLembretes(); renderLembretes();
    el('lembrete-modal-back').style.display='none';
  });

  // Wire editLembrete global
  window.editLembrete = id => openLembreteModal(id);

  initPagarModal();
  renderLembretes();
}
window.toggleLembretePago=toggleLembretePago;
window.updateLembreteValorMes=updateLembreteValorMes;
window.editLembrete=editLembrete;
window.deleteLembrete=deleteLembrete;

// ─── ORÇAMENTO NOVO ───────────────────────────────────────────────────────────
function renderOrcamentoNovo(){
  const sel=selectedFilterMonth!=='all'?selectedFilterMonth:null;
  const totals=calcTotals(sel);
  const orc=calcOrcamentoTotal(sel);
  const totalGasto=totals.variableTotal+totals.fixedTotal+totals.investTotal;
  const saldoLivre=orc.total-totalGasto;
  const receita=totals.realReceita;

  const fluxoEl=el('orc-fluxo-resumo');
  if(fluxoEl){
    const pct=orc.total>0?Math.min(100,Math.round((totalGasto/orc.total)*100)):0;
    let barColor='#10b981';
    if(pct>100) barColor='var(--danger)';
    else if(pct>80) barColor='var(--warning)';
    fluxoEl.innerHTML=`<div class="orc-resumo-bar-card">
      <div class="orc-resumo-row">
        <div class="orc-resumo-item"><div class="orc-resumo-label">💰 Receita</div><div class="orc-resumo-val orc-val-income">${formatMoney(receita)}</div></div>
        <div class="orc-resumo-arrow">→</div>
        <div class="orc-resumo-item"><div class="orc-resumo-label">📊 Total Gasto</div><div class="orc-resumo-val orc-val-expense">${formatMoney(totalGasto)}</div></div>
        <div class="orc-resumo-arrow">→</div>
        <div class="orc-resumo-item"><div class="orc-resumo-label">🎯 Saldo Livre</div><div class="orc-resumo-val" style="color:${saldoLivre>=0?'var(--accent)':'var(--danger)'}">${formatMoney(saldoLivre)}</div></div>
      </div>
      <div style="margin-top:12px">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <span class="small muted">Orçamento utilizado</span>
          <span class="small" style="font-weight:700;color:${barColor}">${pct}%</span>
        </div>
        <div style="background:var(--border);border-radius:6px;height:8px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${barColor};border-radius:6px;transition:width 0.4s"></div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:4px">
          <span class="small muted">Gasto: ${formatMoney(totalGasto)}</span>
          <span class="small muted">Planejado: ${formatMoney(orc.total)}</span>
        </div>
      </div>
    </div>`;
  }

  const distEl=el('orc-dist-grid');
  if(distEl){
    const items=[
      {label:'Fixas',val:totals.fixedTotal,orc:orc.orcFixo,color:'var(--warning)',icon:'🔒'},
      {label:'Variáveis',val:totals.variableTotal,orc:orc.orcVariavel,color:'var(--danger)',icon:'💸'},
      {label:'Investimentos',val:totals.investTotal,orc:orc.orcInvest,color:'var(--invest)',icon:'💜'},
    ];
    distEl.innerHTML=`<div class="orc-dist-row">`+items.map(it=>{
      const p=it.orc>0?Math.min(100,Math.round((it.val/it.orc)*100)):(it.val>0?100:0);
      return `<div class="orc-dist-card">
        <div class="orc-dist-icon">${it.icon}</div>
        <div class="orc-dist-label">${it.label}</div>
        <div class="orc-dist-val" style="color:${it.color}">${formatMoney(it.val)}</div>
        <div class="orc-dist-orc">de ${formatMoney(it.orc)}</div>
        <div class="orc-dist-bar-track"><div class="orc-dist-bar-fill" style="width:${p}%;background:${it.color}"></div></div>
        <div class="orc-dist-pct" style="color:${it.color}">${p}%</div>
      </div>`;
    }).join('')+`</div>`;
  }

  const catList=el('orc-categorias-list');
  const subtotalsEl=el('orc-subtotals');
  if(!catList) return;
  catList.innerHTML='';
  const catSet=new Set([
    ...Object.keys(state.budgets||{}),
    ...(sel&&state.monthlyHistory?.[sel]?.budgets?Object.keys(state.monthlyHistory[sel].budgets):[])
  ]);
  const cats=Array.from(catSet).filter(cat=>{
    const b=getBudgetForMonth(cat,sel);
    return b&&b.kind!=='income';
  }).sort();
  if(!cats.length){
    catList.innerHTML='<div class="small muted" style="padding:16px">Nenhuma categoria. Use "+ Nova Categoria" para começar.</div>';
    return;
  }
  let totalOrc=0,totalGastoC=0;
  cats.forEach(cat=>{
    const b=getBudgetForMonth(cat,sel); if(!b) return;
    const orcado=Number(b.budget||0);
    const isInvest=b.kind==='investment';
    let gasto=0;
    if(isInvest){ gasto=calcInvestByCategory(cat,sel); }
    else {
      state.entries.forEach(e=>{
        if(!isValidEntry(e)||e.type!=='expense') return;
        expandEntry(e,sel).forEach(inst=>{
          const eCat=(inst.entry.category&&String(inst.entry.category).trim())||'(Sem categoria)';
          if(eCat!==cat) return;
          const bi=getBudgetForMonth(eCat,sel);
          if(inst.entry.fixed||(bi&&bi.isFixed)) return;
          gasto+=Number(inst.value||0);
        });
      });
    }
    totalOrc+=orcado; totalGastoC+=gasto;
    const restante=orcado-gasto;
    const pct=orcado>0?Math.min(100,Math.round((gasto/orcado)*100)):(gasto>0?100:0);
    let barColor='#10b981';
    if(pct>100) barColor='var(--danger)';
    else if(pct>80) barColor='var(--warning)';
    const typeIcon=isInvest?'💜':b.isFixed?'🔒':'💸';
    const div=document.createElement('div');
    div.className='orc-cat-item';
    div.innerHTML=`
      <div class="orc-cat-header">
        <div class="orc-cat-name"><span class="orc-cat-icon">${typeIcon}</span><span>${escapeHtml(cat)}</span></div>
        <div class="orc-cat-values">
          <span class="orc-cat-gasto" style="color:${barColor}">${formatMoney(gasto)}</span>
          <span class="orc-cat-sep">·</span>
          <span class="orc-cat-orc">de ${formatMoney(orcado)}</span>
          <span class="orc-cat-pct" style="color:${barColor}">${pct}%</span>
        </div>
      </div>
      <div class="orc-cat-bar-track"><div class="orc-cat-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
      <div class="orc-cat-restante" style="color:${restante>=0?'var(--text-3)':'var(--danger)'}">
        ${restante>=0?'Disponível':'Excedido'}: ${formatMoney(Math.abs(restante))}
        <span class="orc-cat-edit" onclick="editBudget('${cat.replace(/'/g,"\\'")}')" style="cursor:pointer">✏️ Editar</span>
      </div>`;
    catList.appendChild(div);
  });
  if(subtotalsEl){
    const resto=totalOrc-totalGastoC;
    subtotalsEl.innerHTML=`<div class="orc-subtotal-row">
      <span>Orçado: <strong>${formatMoney(totalOrc)}</strong></span>
      <span>Gasto: <strong style="color:var(--danger)">${formatMoney(totalGastoC)}</strong></span>
      <span style="color:${resto>=0?'var(--accent)':'var(--danger)'}">Disponível: <strong>${formatMoney(resto)}</strong></span>
    </div>`;
  }
}

// ─── DASHBOARD ANALÍTICO ──────────────────────────────────────────────────────
let analCurrentTab='evolucao';

function initAnalTabs(){
  document.addEventListener('click',e=>{
    const btn=e.target.closest('[data-atab]'); if(!btn) return;
    analCurrentTab=btn.getAttribute('data-atab');
    document.querySelectorAll('.anal-tab').forEach(b=>b.classList.toggle('active',b.getAttribute('data-atab')===analCurrentTab));
    document.querySelectorAll('.anal-panel').forEach(p=>p.classList.toggle('active',p.id===`atab-${analCurrentTab}`));
    renderAnalyticTab(analCurrentTab);
  });
}

function renderAnalyticTab(tab){
  if(tab==='evolucao') renderAnalEvolucao();
  else if(tab==='categorias') renderAnalCategorias();
  else if(tab==='projecao') renderAnalProjecao();
}

function renderAnalEvolucao(){
  const kpiRow=el('anal-kpi-row'); if(!kpiRow) return;
  const nowM=new Date().toISOString().slice(0,7);
  const [sy,sm]=nowM.split('-').map(Number);
  const months=[];
  for(let i=0;i<12;i++){
    const d=new Date(sy,sm-12+i,1);
    months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
  }
  const rows=months.map(m=>{
    const t=calcTotals(m), o=calcOrcamentoTotal(m);
    return {month:m,entradas:t.realReceita,saidas:t.variableTotal+t.fixedTotal+t.investTotal,planejado:o.total,saldo:t.realReceita-(t.variableTotal+t.fixedTotal+t.investTotal)};
  });
  const tE=rows.reduce((s,r)=>s+r.entradas,0);
  const tS=rows.reduce((s,r)=>s+r.saidas,0);
  const tSaldo=rows.reduce((s,r)=>s+r.saldo,0);
  const mPos=rows.filter(r=>r.saldo>=0).length;
  kpiRow.innerHTML=`
    <div class="anal-kpi"><div class="anal-kpi-label">Receita 12m</div><div class="anal-kpi-val" style="color:var(--income)">${formatMoney(tE)}</div></div>
    <div class="anal-kpi"><div class="anal-kpi-label">Gasto 12m</div><div class="anal-kpi-val" style="color:var(--danger)">${formatMoney(tS)}</div></div>
    <div class="anal-kpi"><div class="anal-kpi-label">Saldo 12m</div><div class="anal-kpi-val" style="color:${tSaldo>=0?'var(--accent)':'var(--danger)'}">${formatMoney(tSaldo)}</div></div>
    <div class="anal-kpi"><div class="anal-kpi-label">Meses positivos</div><div class="anal-kpi-val">${mPos}/12</div></div>`;
  if(el('subtotal-monthly-entradas')) el('subtotal-monthly-entradas').innerHTML='<strong>'+formatMoney(tE)+'</strong>';
  if(el('subtotal-monthly-saidas')) el('subtotal-monthly-saidas').innerHTML='<strong>'+formatMoney(tS)+'</strong>';
  if(el('subtotal-monthly-saldo')) el('subtotal-monthly-saldo').innerHTML='<strong>'+formatMoney(tSaldo)+'</strong>';
  if(el('subtotal-monthly-planejado')) el('subtotal-monthly-planejado').innerHTML='<strong>'+formatMoney(rows.reduce((s,r)=>s+r.planejado,0))+'</strong>';
}

function renderAnalCategorias(){
  const sel=selectedFilterMonth!=='all'?selectedFilterMonth:null;
  const totals=calcTotals(sel);
  const catMap={};
  state.entries.forEach(e=>{
    if(!isValidEntry(e)||e.type!=='expense') return;
    expandEntry(e,sel).forEach(inst=>{
      const cat=(inst.entry.category&&String(inst.entry.category).trim())||'Outros';
      const bi=getBudgetForMonth(cat,sel);
      if(inst.entry.fixed||(bi&&bi.isFixed)) return;
      catMap[cat]=(catMap[cat]||0)+Number(inst.value||0);
    });
  });
  const cats=Object.entries(catMap).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const total=cats.reduce((s,c)=>s+c[1],0);
  const colors=['#10C9A0','#F0483A','#F5A623','#8B5CF6','#3B82F6','#ec4899','#14b8a6','#f97316'];
  const rankEl=el('cat-ranking');
  if(rankEl) rankEl.innerHTML=cats.map(([cat,val],i)=>`
    <div class="cat-rank-item">
      <div class="cat-rank-dot" style="background:${colors[i%colors.length]}"></div>
      <div class="cat-rank-name">${escapeHtml(cat)}</div>
      <div class="cat-rank-pct">${total>0?Math.round((val/total)*100):0}%</div>
      <div class="cat-rank-val">${formatMoney(val)}</div>
    </div>`).join('');
  try {
    const c1=el('catDonutChart');
    if(c1&&typeof Chart!=='undefined'){
      if(window._catDonutInst){window._catDonutInst.destroy();window._catDonutInst=null;}
      if(cats.length) window._catDonutInst=new Chart(c1.getContext('2d'),{type:'doughnut',data:{labels:cats.map(c=>c[0]),datasets:[{data:cats.map(c=>c[1]),backgroundColor:colors.slice(0,cats.length),borderWidth:2,borderColor:'#fff'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},cutout:'65%'}});
    }
    const c2=el('tipoBarChart');
    if(c2&&typeof Chart!=='undefined'){
      if(window._tipoBarInst){window._tipoBarInst.destroy();window._tipoBarInst=null;}
      window._tipoBarInst=new Chart(c2.getContext('2d'),{type:'bar',data:{labels:['Variável','Fixo','Investimento'],datasets:[{data:[totals.variableTotal,totals.fixedTotal,totals.investTotal],backgroundColor:['#F0483A','#F5A623','#8B5CF6'],borderRadius:6}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,ticks:{callback:v=>'R$'+Number(v).toLocaleString('pt-BR')}}}}});
    }
  } catch(e){ console.warn('charts',e); }
}

function renderAnalProjecao(){
  const now=new Date();
  const projecaoCards=el('projecao-cards');
  const projecaoParcelas=el('projecao-parcelas');
  if(!projecaoCards) return;
  const months=[];
  for(let i=0;i<6;i++){
    const d=new Date(now.getFullYear(),now.getMonth()+i,1);
    months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
  }
  projecaoCards.innerHTML=months.map(m=>{
    const t=calcTotals(m),saidas=t.variableTotal+t.fixedTotal+t.investTotal,saldo=t.realReceita-saidas;
    const cur=m===now.toISOString().slice(0,7);
    return `<div class="proj-card ${cur?'proj-card-current':''}">
      <div class="proj-card-month">${m}</div>
      <div class="proj-card-receita">${formatMoney(t.realReceita)}<span>receita</span></div>
      <div class="proj-card-gasto">${formatMoney(saidas)}<span>previsto</span></div>
      <div class="proj-card-saldo" style="color:${saldo>=0?'var(--accent)':'var(--danger)'}">${formatMoney(saldo)}<span>saldo</span></div>
    </div>`;
  }).join('');
  if(projecaoParcelas){
    // Only show series that still have future installments
    const roots=state.entries.filter(e=>{
      if(!e||!e.series||!(Number(e.series.total)>1)) return false;
      // Check if there are children still in the future
      const children=state.entries.filter(c=>c.seriesId===e.id);
      const hasMore=children.some(c=>{
        const d=new Date((c.competence||'2000-01')+'-01');
        return d>=new Date(now.getFullYear(),now.getMonth(),1);
      });
      return hasMore;
    });
    if(!roots.length){projecaoParcelas.innerHTML='<div class="small muted" style="padding:12px">Nenhum parcelamento ativo no momento.</div>';return;}
    projecaoParcelas.innerHTML=roots.map(root=>{
      const children=state.entries.filter(c=>c.seriesId===root.id);
      const desc=(root.description||'').replace(/ \(\d+\/\d+\)$/,'');
      const nowDate=new Date(now.getFullYear(),now.getMonth(),1);
      const paid=children.filter(c=>{const d=new Date((c.competence||'2000-01')+'-01');return d<nowDate;}).length;
      const remaining=children.filter(c=>{const d=new Date((c.competence||'2000-01')+'-01');return d>=nowDate;}).length;
      const total=Number(root.series.total)||children.length;
      const pct=total>0?Math.round((paid/total)*100):0;
      return `<div class="parcela-prog-item">
        <div class="parcela-prog-header">
          <span style="font-weight:600">${escapeHtml(desc)}</span>
          <span class="small muted">${paid}/${total} pagas · <strong>${remaining} restante(s)</strong> · ${formatMoney(root.value)}/mês</span>
        </div>
        <div style="background:var(--border);border-radius:4px;height:7px;overflow:hidden;margin-top:5px">
          <div style="height:100%;width:${pct}%;background:var(--accent);border-radius:4px;transition:width 0.3s"></div>
        </div>
      </div>`;
    }).join('');
  }
}

function renderGastosRecentes(sel){
  const container=el('gastos-recentes-list'); if(!container) return;
  const rows=[];
  state.entries.forEach(e=>{
    if(!isValidEntry(e)||e.type!=='expense'||e.fixed) return;
    if(e.seriesId) return;
    const bi=getBudgetForMonth((e.category||'').trim(),sel);
    if(bi&&bi.isFixed) return;
    expandEntry(e,sel).forEach(inst=>rows.push({entry:e,value:inst.value,date:e.date}));
  });
  rows.sort((a,b)=>new Date(b.date)-new Date(a.date));
  const recent=rows.slice(0,5);
  if(!recent.length){container.innerHTML='<div class="small muted" style="padding:12px 0">Nenhum gasto variável neste mês.</div>';return;}
  container.innerHTML=recent.map(r=>`
    <div class="gasto-recente-item">
      <div class="gasto-recente-left">
        <span class="gasto-recente-cat">${escapeHtml(r.entry.category||'—')}</span>
        <span class="gasto-recente-desc">${escapeHtml(r.entry.description||'')}</span>
      </div>
      <div class="gasto-recente-val">−${formatMoney(r.value)}</div>
    </div>`).join('');
}

window.renderOrcamentoNovo=renderOrcamentoNovo;
window.renderLembretes=renderLembretes;
window.loadLembretesFromCloud=loadLembretesFromCloud;




// ─── GASTOS DIÁRIOS ───────────────────────────────────────────────────────────
let gdPeriod='month', gdFromDate=null, gdToDate=null, gdCatFilter='';

function getGDDateRange(){
  const now=new Date(), today=now.toISOString().slice(0,10), month=now.toISOString().slice(0,7);
  if(gdPeriod==='today') return {from:today,to:today};
  if(gdPeriod==='7d'){const d=new Date(now);d.setDate(d.getDate()-6);return{from:d.toISOString().slice(0,10),to:today};}
  if(gdPeriod==='30d'){const d=new Date(now);d.setDate(d.getDate()-29);return{from:d.toISOString().slice(0,10),to:today};}
  if(gdPeriod==='month') return {from:month+'-01',to:month+'-31'};
  if(gdPeriod==='prev-month'){const d=new Date(now.getFullYear(),now.getMonth()-1,1);const m=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');return{from:m+'-01',to:m+'-31'};}
  if(gdPeriod==='custom'&&gdFromDate&&gdToDate) return {from:gdFromDate,to:gdToDate};
  return {from:month+'-01',to:month+'-31'};
}

function renderGastosDiarios(){
  const listEl=el('gd-list'), summaryEl=el('gd-period-summary');
  if(!listEl) return;
  const {from,to}=getGDDateRange();
  const rows=[];
  state.entries.forEach(e=>{
    if(!isValidEntry(e)||e.type!=='expense'||e.fixed) return;
    const bi=getBudgetForMonth((e.category||'').trim(),yyyyMmFromDate(e.date));
    if(bi&&bi.isFixed) return;
    const d=e.date?e.date.slice(0,10):'';
    if(!d||d<from||d>to) return;
    if(gdCatFilter&&(e.category||'')!==gdCatFilter) return;
    rows.push({entry:e,date:d,value:Number(e.value||0)});
  });
  // Populate cat filter
  const catFilter=el('gd-filter-cat');
  if(catFilter){
    const cats=[...new Set(rows.map(r=>r.entry.category||'').filter(Boolean))].sort();
    const prev=catFilter.value;
    catFilter.innerHTML='<option value="">Todas</option>'+cats.map(c=>`<option value="${escapeHtml(c)}"${c===prev?' selected':''}>${escapeHtml(c)}</option>`).join('');
  }
  rows.sort((a,b)=>b.date.localeCompare(a.date));
  const totalPeriod=rows.reduce((s,r)=>s+r.value,0);
  if(summaryEl){
    const dayCount=rows.length?new Set(rows.map(r=>r.date)).size:0;
    summaryEl.innerHTML=totalPeriod>0
      ?`<div class="gd-summary-total"><span>Total no período:</span><strong>${formatMoney(totalPeriod)}</strong></div><div class="gd-summary-avg">${dayCount} dia(s) com gastos · média ${formatMoney(dayCount?totalPeriod/dayCount:0)}/dia</div>`
      :'<div class="gd-summary-total" style="color:var(--text-3)">Nenhum gasto neste período.</div>';
  }
  if(!rows.length){listEl.innerHTML='<div class="gd-empty">Nenhum gasto variável neste período.</div>';return;}
  const byDate={};
  rows.forEach(r=>{(byDate[r.date]=byDate[r.date]||[]).push(r);});
  listEl.innerHTML=Object.keys(byDate).sort().reverse().map(date=>{
    const items=byDate[date];
    const dayTotal=items.reduce((s,r)=>s+r.value,0);
    const [y,m,d]=date.split('-');
    return `<div class="gd-day-group">
      <div class="gd-day-header"><span class="gd-day-date">${d}/${m}/${y}</span><span class="gd-day-total">${formatMoney(dayTotal)}</span></div>
      ${items.map(r=>`<div class="gd-item">
        <div class="gd-item-left">
          <span class="gd-item-cat">${escapeHtml(r.entry.category||'—')}</span>
          <span class="gd-item-desc">${escapeHtml(r.entry.description||'')}</span>
        </div>
        <div class="gd-item-right">
          <span class="gd-item-val">−${formatMoney(r.value)}</span>
          <div class="gd-item-actions">
            <button class="gd-item-btn" onclick="editEntry('${r.entry.id}')">✏️</button>
            <button class="gd-item-btn gd-item-btn-del" onclick="deleteEntry('${r.entry.id}')">🗑</button>
          </div>
        </div>
      </div>`).join('')}
    </div>`;
  }).join('');
}

function initGastosDiarios(){
  document.addEventListener('click',e=>{
    const pill=e.target.closest('[data-period]'); if(!pill) return;
    gdPeriod=pill.getAttribute('data-period');
    document.querySelectorAll('[data-period]').forEach(p=>p.classList.remove('active'));
    pill.classList.add('active');
    const cr=el('gd-custom-range'); if(cr) cr.style.display=gdPeriod==='custom'?'flex':'none';
    if(gdPeriod!=='custom') renderGastosDiarios();
  });
  el('gd-apply-custom')?.addEventListener('click',()=>{
    gdFromDate=el('gd-from')?.value; gdToDate=el('gd-to')?.value;
    if(gdFromDate&&gdToDate) renderGastosDiarios();
  });
  el('gd-filter-cat')?.addEventListener('change',e=>{gdCatFilter=e.target.value;renderGastosDiarios();});
}

// ─── FORM HELPERS ─────────────────────────────────────────────────────────────
const clearForm = () => {
  el('input-desc').value  = '';
  el('input-value').value = '';
  el('input-category-select').value = '';
  el('input-category-text').value   = '';
  el('input-fixed').checked    = false;
  el('input-parceled').checked = false;
  const pg = document.getElementById('parcel-group');
  if (pg) pg.classList.remove('visible');
};

// ── populateCategorySelect: for expenses ──────────────────────────────────────
const populateCategorySelect = () => {
  const sel = el('input-category-select');
  if (!sel) return;
  const type = el('input-type')?.value;
  if (type === 'investment') { populateInvestmentCategorySelect(); return; }
  if (type === 'income') { sel.innerHTML = '<option value="">-- sem categoria --</option>'; return; }

  // Filter categories by whether it's a fixed or variable expense
  const isFixed = el('input-fixed')?.checked;
  const cats = isFixed ? getFixedExpenseCategories() : getVariableExpenseCategories();

  sel.innerHTML = '<option value="">-- selecione --</option>';
  cats.forEach(cat => {
    const opt = document.createElement('option'); opt.value = cat; opt.textContent = cat; sel.appendChild(opt);
  });
  const newOpt = document.createElement('option'); newOpt.value = '__new__'; newOpt.textContent = '➕ Nova categoria'; sel.appendChild(newOpt);
};

// ── populateInvestmentCategorySelect ─────────────────────────────────────────
// Dynamically built from single source of truth (getAllInvestmentCategories)
// plus sensible defaults if the list is still empty
const populateInvestmentCategorySelect = () => {
  const sel = el('input-category-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- selecione --</option>';
  const existing = getAllInvestmentCategories();
  const defaults  = ['Renda Fixa', 'Renda Variável', 'Previdência', 'Criptomoedas', 'Outros'];
  const all       = [...new Set([...existing, ...defaults])].sort();
  all.forEach(cat => {
    const opt = document.createElement('option'); opt.value = cat; opt.textContent = cat; sel.appendChild(opt);
  });
  const newOpt = document.createElement('option'); newOpt.value = '__new__'; newOpt.textContent = '➕ Nova categoria'; sel.appendChild(newOpt);
};

// ── toggleCategoryField ───────────────────────────────────────────────────────
// Investments now use the same dynamic category mechanism as expenses
const toggleCategoryField = () => {
  const type      = el('input-type').value;
  const fixedLbl  = document.getElementById('fixed-check-label');
  const fixedSub  = document.getElementById('fixed-sublabel');
  const newCatRow = document.getElementById('new-cat-row');
  const catText   = el('input-category-text');

  if (type === 'investment') {
    el('input-category-select').disabled = false;
    populateInvestmentCategorySelect();
    // Only hide text field if currently showing — let __new__ option toggle it
    if (el('input-category-select').value !== '__new__') {
      if (newCatRow) newCatRow.style.display = 'none';
      if (catText)   catText.style.display = 'none';
    }
    if (fixedLbl) fixedLbl.textContent = 'Recorrente (aporte mensal automático)';
    if (fixedSub) fixedSub.style.display = 'none';
    return;
  }

  if (fixedLbl) fixedLbl.textContent = 'Custo fixo mensal';
  if (fixedSub) fixedSub.style.display = type === 'expense' ? '' : 'none';

  if (type === 'income') {
    el('input-category-select').disabled = false;
    el('input-category-select').innerHTML = '<option value="">-- sem categoria --</option>';
    if (newCatRow) newCatRow.style.display = 'none';
    if (catText)   catText.style.display = 'none';
    return;
  }

  el('input-category-select').disabled = false;
  populateCategorySelect();
};

const updateParcelOptions = () => {
  const total   = Number(el('input-parcel-total').value) || 2;
  const current = el('input-parcel-current');
  current.innerHTML = '';
  for (let i = 1; i <= total; i++) { const opt = document.createElement('option'); opt.value = i; opt.textContent = String(i); current.appendChild(opt); }
};

// ── openNewCategoryModal ──────────────────────────────────────────────────────
// Supports both expense and investment categories
const openNewCategoryModal = () => {
  const overlay = document.createElement('div'); overlay.className = 'app-edit-overlay';
  const modal   = document.createElement('div'); modal.className   = 'app-edit-modal';
  modal.innerHTML = `
    <h3>Nova Categoria / Meta</h3>
    <div class="app-row"><label>Nome</label><input id="new-cat-name" placeholder="Ex: Criptomoedas"></div>
    <div class="app-row"><label>Tipo</label><select id="new-cat-kind">
      <option value="expense">Despesa variável</option>
      <option value="investment">Meta de Investimentos 💜</option>
    </select></div>
    <div class="app-row"><label>Valor / Meta (R$)</label><input id="new-cat-budget" value="0"></div>
    <div class="app-row" id="new-cat-fixed-row"><label><input id="new-cat-fixed" type="checkbox">Marcar como Fixo (despesa recorrente)</label></div>
    <div class="app-actions">
      <button id="new-cat-cancel" class="muted-button">Cancelar</button>
      <button id="new-cat-save" style="background:var(--accent);color:#fff">Criar</button>
    </div>`;
  overlay.appendChild(modal); document.body.appendChild(overlay);
  const kindSel  = modal.querySelector('#new-cat-kind');
  const fixedRow = modal.querySelector('#new-cat-fixed-row');
  kindSel.addEventListener('change', () => {
    fixedRow.style.display = kindSel.value === 'investment' ? 'none' : '';
  });
  modal.querySelector('#new-cat-cancel').addEventListener('click', () => overlay.remove());
  modal.querySelector('#new-cat-save').addEventListener('click', async () => {
    const name    = modal.querySelector('#new-cat-name').value.trim();
    const kind    = modal.querySelector('#new-cat-kind').value;
    const budget  = parseNumber(modal.querySelector('#new-cat-budget').value);
    const isFixed = kind === 'investment' ? false : modal.querySelector('#new-cat-fixed').checked;
    if (!name) { alert('Digite o nome da categoria'); return; }
    const targetM = (typeof selectedFilterMonth !== 'undefined' && selectedFilterMonth !== 'all') ? selectedFilterMonth : null;
    await setBudget(name, { budget, default: budget, isFixed, kind }, targetM);
    overlay.remove();
  });
};

// ── openNewInvestmentCategoryModal ────────────────────────────────────────────
// Shortcut modal specifically for investment meta creation
const openNewInvestmentCategoryModal = () => {
  const overlay = document.createElement('div'); overlay.className = 'app-edit-overlay';
  const modal   = document.createElement('div'); modal.className   = 'app-edit-modal';
  const sel     = selectedFilterMonth !== 'all' ? selectedFilterMonth : new Date().toISOString().slice(0,7);
  modal.innerHTML = `
    <h3>Nova Meta de Investimento 💜</h3>
    <p class="small muted" style="margin-bottom:12px">Mês: <strong>${sel}</strong></p>
    <div class="app-row"><label>Categoria</label><input id="new-invest-name" placeholder="Ex: Criptomoedas"></div>
    <div class="app-row"><label>Meta mensal (R$)</label><input id="new-invest-budget" value="0" type="text" inputmode="decimal"></div>
    <div class="app-actions">
      <button id="new-invest-cancel" class="muted-button">Cancelar</button>
      <button id="new-invest-save" style="background:var(--invest);color:#fff">Criar Meta</button>
    </div>`;
  overlay.appendChild(modal); document.body.appendChild(overlay);
  modal.querySelector('#new-invest-cancel').addEventListener('click', () => overlay.remove());
  modal.querySelector('#new-invest-save').addEventListener('click', async () => {
    const name   = modal.querySelector('#new-invest-name').value.trim();
    const budget = parseNumber(modal.querySelector('#new-invest-budget').value);
    if (!name) { alert('Digite o nome da categoria'); return; }
    await setBudget(name, { budget, default: budget, isFixed: false, kind: 'investment' }, sel);
    overlay.remove();
  });
};
window.openNewInvestmentCategoryModal = openNewInvestmentCategoryModal;
window.renderOrcamentoNovo = renderOrcamentoNovo;
window.renderLembretes = renderLembretes;
window.loadLembretesFromCloud = loadLembretesFromCloud;

// ─── AUTH ─────────────────────────────────────────────────────────────────────
let entriesUnsub = null, budgetsUnsub = null;

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (entriesUnsub)  { entriesUnsub();  entriesUnsub  = null; }
  if (budgetsUnsub)  { budgetsUnsub();  budgetsUnsub  = null; }
  const authGuestEl = el('auth-guest'), authUserEl = el('auth-user'), userEmailEl = el('user-email-display');

  if (user) {
    if (authGuestEl)  authGuestEl.style.display  = 'none';
    if (authUserEl)   authUserEl.style.display   = 'flex';
    if (userEmailEl)  userEmailEl.textContent    = user.email || user.uid;
    try {
      entriesUnsub = onSnapshot(collection(db, 'users', user.uid, 'entries'), snap => {
        state.entries = [];
        snap.forEach(d => { const data = d.data(); data.id = d.id; ensureEntryId(data); state.entries.push(data); });
        saveLocal(); renderAll();
        const ss = el('sync-status'); if (ss) ss.textContent = 'Conectado';
      });
    } catch(e) { console.error('entries snapshot:', e); }
    try {
      budgetsUnsub = onSnapshot(collection(db, 'users', user.uid, 'budgets'), snap => {
        state.budgets = {};
        snap.forEach(d => { state.budgets[d.id] = d.data(); });
        saveLocal(); renderAll();
      });
    } catch(e) { console.error('budgets snapshot:', e); }
    try {
      if (!window._monthlyBudgetsUnsub) {
        window._monthlyBudgetsUnsub = onSnapshot(collection(db, 'users', user.uid, 'monthlyBudgets'), snap => {
          state.monthlyHistory = state.monthlyHistory || {};
          snap.forEach(d => {
            const data = d.data();
            if (data.budgets) {
              state.monthlyHistory[d.id] = state.monthlyHistory[d.id] || {};
              state.monthlyHistory[d.id].budgets = data.budgets;
              if (data.inheritedFrom) state.monthlyHistory[d.id].inheritedFrom = data.inheritedFrom;
            }
          });
          saveLocal(); renderAll();
        });
      }
    } catch(e) { console.error('monthlyBudgets snapshot:', e); }
    await migrateData();
  } else {
    if (authGuestEl) authGuestEl.style.display = 'flex';
    if (authUserEl)  authUserEl.style.display  = 'none';
    loadLocal();
    await migrateData();
    renderAll();
    const ss = el('sync-status'); if (ss) ss.textContent = 'Offline';
  }
});

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadLocal();
  const current = new Date().toISOString().slice(0,7);
  if (!state.monthlyHistory || !state.monthlyHistory[current]) captureMonthlySnapshot(current);
  ensureMonthHistory(current);

  el('input-date').value        = new Date().toISOString().slice(0,10);
  el('input-competence').value  = new Date().toISOString().slice(0,7);

  const parcelTotal = el('input-parcel-total');
  if (parcelTotal) {
    for (let i = 2; i <= 36; i++) { const opt = document.createElement('option'); opt.value = i; opt.textContent = i + 'x'; parcelTotal.appendChild(opt); }
  }
  updateParcelOptions();

  qsa('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      qsa('.panel').forEach(p => { p.classList.remove('active'); p.style.display = ''; });
      const target = btn.dataset.target;
      const panel  = el('panel-' + target);
      if (panel) { panel.classList.add('active'); panel.style.display = 'block'; }
    });
  });

  // Type pills wiring (new sheet design)
  document.querySelectorAll('.sheet-type-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.sheet-type-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const t = pill.getAttribute('data-type');
      const inp = el('input-type');
      if (inp) inp.value = t;
      toggleCategoryField();
      // Show/hide fixed toggle based on type
      const fixedChip = el('chip-fixed');
      const parceledChip = el('chip-parceled');
      if (t === 'income') {
        if(fixedChip) fixedChip.style.display = 'flex';
        if(parceledChip) parceledChip.style.display = 'none';
      } else if (t === 'investment') {
        if(fixedChip) fixedChip.style.display = 'flex';
        if(parceledChip) parceledChip.style.display = 'none';
      } else {
        if(fixedChip) fixedChip.style.display = 'flex';
        if(parceledChip) parceledChip.style.display = 'flex';
      }
      // Update pill color
      const colors = { expense:'var(--danger)', income:'var(--income)', investment:'var(--invest)' };
      document.querySelector('.sheet-valor-prefix').style.color = colors[t]||'var(--accent)';
    });
  });
  el('input-type').addEventListener('change', toggleCategoryField);
  el('input-fixed').addEventListener('change', () => { populateCategorySelect(); });
  el('btn-add').addEventListener('click', addEntry);
  el('btn-clear').addEventListener('click', clearForm);

  el('input-parceled').addEventListener('change', (e) => {
    const show = e.target.checked;
    const pg   = document.getElementById('parcel-group');
    if (pg) show ? pg.classList.add('visible') : pg.classList.remove('visible');
    if (show) updateParcelOptions();
  });

  el('input-parcel-total').addEventListener('change', updateParcelOptions);

  el('input-category-select').addEventListener('change', (e) => {
    const newCatRow = document.getElementById('new-cat-row');
    const catText   = el('input-category-text');
    if (e.target.value === '__new__') {
      if (newCatRow) newCatRow.style.display = 'flex';
      if (catText)   { catText.style.display = 'block'; catText.focus(); }
    } else {
      if (newCatRow) newCatRow.style.display = 'none';
      if (catText)   catText.style.display   = 'none';
    }
  });

  const btnNewCat = el('btn-open-budgets-modal');
  if (btnNewCat) btnNewCat.addEventListener('click', openNewCategoryModal);

  el('filter-month').addEventListener('change', (e) => {
    selectedFilterMonth = e.target.value;
    window.selectedFilterMonth = selectedFilterMonth;
    if (selectedFilterMonth !== 'all') ensureMonthHistory(selectedFilterMonth);
    renderAll();
  });

  el('btn-signin').addEventListener('click', async () => {
    const email = el('auth-email').value, pass = el('auth-pass').value;
    if (!email || !pass) { alert('Preencha email e senha'); return; }
    try { await signInWithEmailAndPassword(auth, email, pass); } catch(e) { alert('Erro ao entrar: ' + e.message); }
  });

  el('btn-signup').addEventListener('click', async () => {
    const email = el('auth-email').value, pass = el('auth-pass').value;
    if (!email || !pass) { alert('Preencha email e senha'); return; }
    try { await createUserWithEmailAndPassword(auth, email, pass); alert('Conta criada!'); } catch(e) { alert('Erro: ' + e.message); }
  });

  el('btn-signout').addEventListener('click', async () => {
    try { await signOut(auth); } catch(e) { alert('Erro ao sair'); }
  });

  window.addEventListener('app:state-changed', () => { try { renderAll(); } catch(e) {} });

  populateCategorySelect();
  renderAll();
  try { initLembretes(); } catch(e){ console.warn('initLembretes',e); }
  try { initAnalTabs(); } catch(e){ console.warn('initAnalTabs',e); }
  try { if(typeof currentUser !== 'undefined' && currentUser) loadLembretesFromCloud(); } catch(e){}
});

// ─── EXPOSE GLOBALS ───────────────────────────────────────────────────────────
window.editEntry                    = editEntry;
window.deleteEntry                  = deleteEntry;
window.editBudget                   = editBudget;
window.removeBudget                 = removeBudget;
window.renderAll                    = renderAll;
window.calcTotals                   = calcTotals;
window.calcOrcamentoTotal           = calcOrcamentoTotal;
window.updateGlobalProgressBar      = updateGlobalProgressBar;
window.renderKPIs                   = renderKPIs;
window.renderMonthlyProjection      = renderMonthlyProjection;
window.expandEntry                  = expandEntry;
window.getBudgetForMonth            = getBudgetForMonth;
window.formatMoney                  = formatMoney;
window.inheritBudgetFrom            = inheritBudgetFrom;
window.getAllInvestmentCategories    = getAllInvestmentCategories;
window.openNewInvestmentCategoryModal = openNewInvestmentCategoryModal;
