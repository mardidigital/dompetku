/* ============================================================
   DOMPETKU — js/app.js (frontend statis, GitHub Pages)
   Berbicara dengan backend Google Apps Script lewat fetch (JSON).
   Prinsip Instant UX + Scale Turbo:
   1) SPA murni         : pindah menu = tampil/sembunyi, 0 ms
   2) Cache-first (SWR) : buka aplikasi langsung dari localStorage, lalu
                          cek versi ke server (balasan "unchanged" ~100 byte)
   3) Optimistic UI     : simpan/ubah/hapus tampil seketika + antrean lokal
   4) Batch             : seluruh antrean dikirim dalam SATU panggilan `sync`
   5) Hemat kuota       : de-dupe request, polling adaptif, jeda saat tab disembunyikan
   ============================================================ */
(function () {
'use strict';

/* ---------- util ---------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const OUT = 'Pengeluaran', IN = 'Pemasukan', OWNER = 'Pemilik';
const nf = new Intl.NumberFormat('id-ID');
const rp = (n) => 'Rp ' + nf.format(Math.round(n || 0));
const sgn = (n, j) => (j === IN ? '+' : '−') + rp(n);
const BLN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (add) => { const d = new Date(); d.setDate(d.getDate() + (add || 0)); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const mLabel = (k) => BLN[+k.slice(5, 7) - 1] + ' ' + k.slice(0, 4);
const mShift = (k, n) => { let y = +k.slice(0, 4), m = +k.slice(5, 7) - 1 + n; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return y + '-' + pad(m + 1); };
const fmtTgl = (iso) => (+iso.slice(8, 10)) + ' ' + BLN[+iso.slice(5, 7) - 1] + ' ' + iso.slice(0, 4);
const dayLabel = (iso) => iso === isoDay(0) ? 'Hari ini, ' + fmtTgl(iso) : iso === isoDay(-1) ? 'Kemarin, ' + fmtTgl(iso) : fmtTgl(iso);
const ini = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase();
const ic = (n, fill) => '<span class="ms' + (fill ? ' fill' : '') + '" aria-hidden="true">' + n + '</span>';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* abaikan */ } };
const newId = () => 'T' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const debounce = (f, ms) => { let t; return function () { const a = arguments; clearTimeout(t); t = setTimeout(() => f.apply(null, a), ms); }; };

/* ---------- state ---------- */
const NOW_M = isoDay(0).slice(0, 7);
const S = {
  user: null, token: '', sv: '', ms: 0, kat: [], pengguna: [], srv: [], trx: [], pend: {}, dbUrl: '', ver: 0,
  view: 'beranda', prev: 'beranda', bulan: NOW_M, rmode: 'bulan',
  f: { jenis: 'all', bulan: NOW_M, dari: '', sampai: '', kat: '', q: '', limit: 25, rentang: false },
  form: null, queue: [], inflight: 0, lastSync: 0, online: true, built: {}, charts: []
};
const katMap = () => { const m = {}; S.kat.forEach((k) => { m[k.nama] = k; }); return m; };
const nameOf = (email) => { const p = S.pengguna.filter((x) => x.email === email)[0]; return p ? p.nama : (email || '').split('@')[0] || '—'; };
const isOwner = () => S.user && S.user.peran === OWNER;
const canEdit = (t) => isOwner() || t.oleh === S.user.email;
const cmp = (a, b) => (a.tgl < b.tgl ? 1 : a.tgl > b.tgl ? -1 : (b.dibuat || 0) - (a.dibuat || 0));

/* ---------- jembatan ke server (REST) ---------- */
const CFG = window.DOMPETKU_CONFIG || {};
const GAS_URL = String(CFG.GAS_URL || '').trim();
const CLIENT_ID = String(CFG.GOOGLE_CLIENT_ID || '').trim();
const ACTION = { sinkronkan: 'sync', ambilData: 'boot', simpanKategori: 'katSave', hapusKategori: 'katDel', undangAnggota: 'memAdd', hapusAnggota: 'memDel', migrasiPindai: 'migScan', migrasiImpor: 'migRun' };
const ARGS = { sinkronkan: (o) => ({ ops: o }), ambilData: (v) => ({ v: v }), simpanKategori: (k, n) => ({ k: k, namaLama: n }), hapusKategori: (n) => ({ nama: n }), undangAnggota: (e, n) => ({ email: e, nama: n }), hapusAnggota: (e) => ({ email: e }), migrasiPindai: (s) => ({ sumber: s }), migrasiImpor: (s) => ({ sumber: s }) };
const inflightReq = {};
let writeEpoch = 0;
function call(action, data, tokenOverride) {
  if (!GAS_URL || /XXXX|ISI_/.test(GAS_URL)) return Promise.reject(new Error('GAS_URL di js/config.js belum diisi.'));
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const to = setTimeout(() => { if (ctl) ctl.abort(); }, 45000);
  // text/plain => "simple request": tanpa preflight CORS (GAS tidak menjawab OPTIONS)
  return fetch(GAS_URL, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: action, token: tokenOverride === undefined ? S.token : tokenOverride, data: data || {} }), signal: ctl ? ctl.signal : undefined })
    .then((r) => { if (!r.ok) throw new Error('Server menjawab ' + r.status); return r.json(); })
    .catch((e) => { throw new Error(e && e.name === 'AbortError' ? 'Server terlalu lama menjawab.' : (e && e.message === 'Failed to fetch' ? 'Tidak ada koneksi ke server.' : (e && e.message) || 'Gagal terhubung.')); })
    .finally(() => clearTimeout(to));
}
/* gs(namaFungsi, ...arg): pembungkus tipis agar sisa kode tetap sama. Permintaan baca kembar berbagi satu promise. */
function gs(fn) {
  const args = Array.prototype.slice.call(arguments, 1);
  const action = ACTION[fn], data = ARGS[fn].apply(null, args);
  const isRead = action === 'boot';
  let key = null;
  if (isRead) { key = writeEpoch + '|' + JSON.stringify(data); if (inflightReq[key]) return inflightReq[key]; } else writeEpoch++;
  const p = call(action, data).then((res) => {
    if (res && res.code === 'AUTH') { authLost(); const e = new Error(res.message || 'Sesi berakhir.'); e.auth = true; throw e; }
    if (res && res.ms != null) S.ms = res.ms;
    return res;
  });
  if (key) { inflightReq[key] = p; const clr = () => { delete inflightReq[key]; }; p.then(clr, clr); }
  return p;
}

/* ---------- sesi ---------- */
function loadToken() { try { const o = JSON.parse(lsGet('dk_token') || 'null'); if (o && o.token && o.email && o.exp * 1000 > Date.now()) return o; } catch (e) { /* abaikan */ } return null; }
function saveToken(t, email, exp) { S.token = t; lsSet('dk_token', JSON.stringify({ token: t, email: email, exp: exp })); }
function clearToken() { S.token = ''; try { localStorage.removeItem('dk_token'); } catch (e) { /* abaikan */ } }
function authLost() { clearToken(); stopPoll(); renderGate({ status: 'login', message: 'Sesi berakhir. Silakan masuk lagi.' }); }
function logout(hapusLokal) {
  clearToken(); stopPoll();
  try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch (e) { /* abaikan */ }
  if (hapusLokal) { try { localStorage.removeItem('dk_data'); localStorage.removeItem('dk_queue'); } catch (e) { /* abaikan */ } S.queue = []; }
  S.user = null; renderGate({ status: 'login' });
}

/* ---------- toast ---------- */
let toastT;
function toast(msg, kind) {
  const t = $('#toast'); t.className = 'toast' + (kind === 'err' ? ' err' : '');
  t.innerHTML = (kind === 'err' ? ic('error') : kind === 'warn' ? ic('warning') : ic('task_alt', true)) + '<span>' + esc(msg) + '</span>';
  void t.offsetWidth; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), kind === 'err' ? 4200 : 2600);
}

/* ---------- persistensi lokal ---------- */
function saveLocal() {
  lsSet('dk_data', JSON.stringify({ user: S.user, kat: S.kat, pengguna: S.pengguna, srv: S.srv, dbUrl: S.dbUrl, v: S.sv }));
}
function saveQueue() { lsSet('dk_queue', JSON.stringify({ u: S.user && S.user.email, q: S.queue })); }
function loadQueue(email) {
  try { const o = JSON.parse(lsGet('dk_queue') || 'null'); if (o && o.u === email && Array.isArray(o.q)) return o.q; } catch (e) { /* abaikan */ }
  return [];
}

/* ---------- data ---------- */
function setData(d) {
  S.user = d.user; S.kat = d.kategori || []; S.pengguna = d.pengguna || []; S.srv = d.transaksi || []; S.dbUrl = d.dbUrl || ''; S.sv = d.v || '';
  recompute(); saveLocal();
}
function recompute() {
  let list = S.srv.slice(); const pend = {};
  S.queue.forEach((op) => {
    if (op.type === 'add') {
      if (!list.some((x) => x.id === op.trx.id)) list.push(Object.assign({}, op.trx, { oleh: S.user.email, dibuat: op.ts || Date.now() }));
      pend[op.trx.id] = 1;
    } else if (op.type === 'edit') {
      list = list.map((x) => (x.id === op.trx.id ? Object.assign({}, x, op.trx) : x)); pend[op.trx.id] = 1;
    } else if (op.type === 'del') {
      list = list.filter((x) => x.id !== op.id);
    }
  });
  list.sort(cmp); S.trx = list; S.pend = pend; S.ver++;
}
const monthTrx = (m) => S.trx.filter((t) => t.tgl.slice(0, m.length) === m);
const totals = (l) => l.reduce((a, t) => { if (t.jenis === IN) a.in += t.nominal; else a.out += t.nominal; return a; }, { in: 0, out: 0 });
const saldoSampai = (m) => S.trx.reduce((a, t) => (t.tgl.slice(0, 7) <= m ? a + (t.jenis === IN ? t.nominal : -t.nominal) : a), 0);
function budgetRows(prefix, factor) {
  const spent = {};
  S.trx.forEach((t) => { if (t.jenis === OUT && t.tgl.slice(0, prefix.length) === prefix) spent[t.kategori] = (spent[t.kategori] || 0) + t.nominal; });
  return S.kat.filter((k) => k.jenis === OUT && k.batas > 0).map((k) => {
    const limit = k.batas * factor, sp = spent[k.nama] || 0;
    return { k: k, spent: sp, limit: limit, pct: limit ? sp / limit * 100 : 0 };
  }).sort((a, b) => b.pct - a.pct);
}
const lvl = (p) => (p >= 100 ? 'bad' : p >= 80 ? 'warn' : 'ok');
const lvlTxt = (p) => (p >= 100 ? 'Melebihi (' + Math.round(p) + '%)' : p >= 80 ? 'Hampir habis (' + Math.round(p) + '%)' : 'Aman (' + Math.round(p) + '%)');
const lvlIc = (p) => (p >= 100 ? 'error' : p >= 80 ? 'warning' : 'check_circle');

/* ---------- komponen kecil ---------- */
function catIc(nama, sm) {
  const k = katMap()[nama] || { warna: '#7C6CF0', ikon: 'category' };
  return '<span class="cat-ic' + (sm ? ' sm' : '') + '" style="--c:' + esc(k.warna) + '">' + ic(esc(k.ikon)) + '</span>';
}
function trxRow(t) {
  return '<div class="trx" role="listitem">' + catIc(t.kategori) +
    '<div class="m"><b>' + esc(t.kategori) + '</b><small>' + esc(t.ket || '—') + ' • ' + esc(dayLabel(t.tgl)) + '</small></div>' +
    '<div class="r"><b class="num ' + (t.jenis === IN ? 'amt-in' : 'amt-out') + '">' + sgn(t.nominal, t.jenis) + '</b><small>' + esc(nameOf(t.oleh)) + '</small></div></div>';
}
function emptyBox(icon, title, text) { return '<div class="empty">' + ic(icon) + '<b>' + esc(title) + '</b><span>' + esc(text) + '</span></div>'; }

/* ============================================================
   NAVIGASI (client-side, 0 ms)
   ============================================================ */
const TITLES = { beranda: 'Beranda', riwayat: 'Riwayat Transaksi', tambah: 'Tambah Transaksi', ringkasan: 'Ringkasan Laporan', pengaturan: 'Pengaturan' };
function go(view, opts) {
  opts = opts || {};
  if (view === 'tambah' && !opts.keepForm) openForm(null);
  if (S.view !== view && S.view !== 'tambah') S.prev = S.view;
  S.view = view;
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + view));
  $$('#nav [data-go]').forEach((a) => { const on = a.getAttribute('data-go') === view; if (!a.classList.contains('fab')) { a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); } });
  const form = view === 'tambah';
  $('#nav').hidden = form; $('#savebar').hidden = !form; $('#app').classList.toggle('no-nav', form); document.body.classList.toggle('form', form);
  $('#subtitle').textContent = TITLES[view] || '';
  renderView(view);
  window.scrollTo(0, 0);
}
function renderView(v) {
  v = v || S.view;
  ({ beranda: renderBeranda, riwayat: renderRiwayat, ringkasan: renderRingkasan, pengaturan: renderPengaturan, tambah: function () {} }[v])();
}

/* ============================================================
   BERANDA
   ============================================================ */
function renderBeranda() {
  const m = S.bulan, list = monthTrx(m), t = totals(list), saldo = saldoSampai(m);
  const rows = budgetRows(m, 1), tl = rows.reduce((a, r) => a + r.limit, 0), ts = rows.reduce((a, r) => a + r.spent, 0), pct = tl ? ts / tl * 100 : 0;
  let hcls = '', htxt;
  if (!list.length) htxt = 'Belum ada transaksi bulan ini';
  else if (t.out <= t.in) { const h = t.in ? Math.round((t.in - t.out) / t.in * 100) : 0; htxt = 'Kondisi aman • Surplus ' + rp(t.in - t.out) + (t.in ? ' (' + h + '%)' : ''); }
  else { hcls = 'bad'; htxt = 'Defisit ' + rp(t.out - t.in) + ' bulan ini'; }
  const warn = rows.filter((r) => r.pct >= 80);
  const alerts = warn.length ? '<div class="alerts" role="region" aria-label="Peringatan anggaran">' + warn.map((r) =>
    '<div class="alert ' + lvl(r.pct) + '">' + ic(r.pct >= 100 ? 'error' : 'warning', true) + '<div><b>' + esc(r.k.nama) + '</b> ' + (r.pct >= 100 ? 'melewati anggaran (' + Math.round(r.pct) + '%)' : 'sudah ' + Math.round(r.pct) + '% dari anggaran') + '. Sisa ' + rp(Math.max(0, r.limit - r.spent)) + '.</div></div>').join('') + '</div>' : '';
  const recent = S.trx.slice(0, 5);
  $('#v-beranda').innerHTML =
    '<div class="card saldo"><div class="row1"><div class="lbl">' + ic('account_balance_wallet', true) + 'Saldo Anda</div>' +
    '<div class="monthnav" role="group" aria-label="Pilih bulan"><button type="button" data-act="mprev" aria-label="Bulan sebelumnya">' + ic('chevron_left') + '</button><span>' + mLabel(m) + '</span><button type="button" data-act="mnext" aria-label="Bulan berikutnya"' + (m >= NOW_M ? ' disabled' : '') + '>' + ic('chevron_right') + '</button></div></div>' +
    '<div class="amt num"><small>' + (saldo < 0 ? '−Rp' : 'Rp') + '</small><b>' + nf.format(Math.abs(Math.round(saldo))) + '</b></div>' +
    '<div class="health ' + hcls + '"><i></i><span>' + esc(htxt) + '</span></div></div>' +
    '<div class="duo"><div class="sum out"><div class="h"><span class="ic">' + ic('arrow_downward') + '</span><span class="tag">' + mLabel(m) + '</span></div><div><small>Pengeluaran</small><b class="num">' + rp(t.out) + '</b></div></div>' +
    '<div class="sum in"><div class="h"><span class="ic">' + ic('arrow_upward') + '</span><span class="tag">' + mLabel(m) + '</span></div><div><small>Pemasukan</small><b class="num">' + rp(t.in) + '</b></div></div></div>' +
    '<div class="card"><div class="card-h"><div style="display:flex;align-items:center;gap:8px"><span class="cat-ic sm" style="--c:#7C6CF0">' + ic('pie_chart') + '</span><h2 class="t" style="font-size:15px">Anggaran Bulanan</h2></div>' +
    (tl ? '<span class="stat ' + lvl(pct) + '">' + ic(lvlIc(pct)) + Math.round(pct) + '% terpakai</span>' : '') + '</div>' +
    (tl ? '<div class="bar" role="progressbar" aria-valuenow="' + Math.min(100, Math.round(pct)) + '" aria-valuemin="0" aria-valuemax="100" aria-label="Anggaran terpakai"><i class="' + (pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : '') + '" style="width:' + Math.min(100, pct) + '%"></i></div>' +
      '<div class="kv" style="margin-top:12px"><div><small>Sisa anggaran</small><b class="num">' + rp(Math.max(0, tl - ts)) + '</b></div><div style="text-align:right"><small>Total rencana</small><b class="num" style="color:var(--ink-2)">' + rp(tl) + '</b></div></div>'
      : '<p class="sub">Belum ada batas anggaran. ' + (isOwner() ? 'Atur di Pengaturan → Kategori &amp; Anggaran.' : 'Pemilik dapat mengaturnya di Pengaturan.') + '</p>') + '</div>' +
    alerts +
    '<div class="sec-h"><div style="display:flex;align-items:center;gap:8px"><h2 class="t">Transaksi Terbaru</h2><span class="pill">' + recent.length + '</span></div><button class="link" type="button" data-go="riwayat">Lihat semua' + ic('chevron_right') + '</button></div>' +
    '<div class="card" style="padding:8px">' + (recent.length ? '<div class="list" role="list">' + recent.map(trxRow).join('') + '</div>' : emptyBox('receipt_long', 'Belum ada transaksi', 'Ketuk tombol + untuk mencatat yang pertama.')) + '</div>';
}

/* ============================================================
   RIWAYAT (filter, daftar, ekspor)
   ============================================================ */
function monthOptions() {
  const set = {}; set[NOW_M] = 1; S.trx.forEach((t) => { set[t.tgl.slice(0, 7)] = 1; });
  return Object.keys(set).sort().reverse();
}
function renderRiwayat() {
  const v = $('#v-riwayat');
  if (!S.built.riwayat) {
    v.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap"><div><h1 class="page">Riwayat Transaksi</h1><p class="sub" style="display:flex;align-items:center;gap:4px;margin-top:4px">' + ic('filter_alt') + 'Unduhan mengikuti filter aktif</p></div>' +
      '<div class="tools"><button class="btn sm" type="button" data-act="xlsx" id="bX">' + ic('table_chart') + 'Excel</button><button class="btn sm" type="button" data-act="pdf" id="bP">' + ic('picture_as_pdf') + 'PDF</button></div></div>' +
      '<div class="search"><span class="ms" aria-hidden="true">search</span><input class="input" id="fq" type="search" placeholder="Cari keterangan transaksi…" aria-label="Cari keterangan" autocomplete="off"></div>' +
      '<div class="chips" id="fjenis" role="group" aria-label="Jenis"></div>' +
      '<div class="grid2"><div class="field"><label for="fbulan">Bulan</label><select class="input" id="fbulan"></select></div><div class="field"><label for="fkat">Kategori</label><select class="input" id="fkat"></select></div></div>' +
      '<div><button class="link" type="button" data-act="rentang" id="bRent">' + ic('calendar_month') + '<span>Rentang tanggal</span></button><div class="grid2" id="rentang" hidden><div class="field"><label for="fdari">Dari</label><input class="input" type="date" id="fdari"></div><div class="field"><label for="fsampai">Sampai</label><input class="input" type="date" id="fsampai"></div></div></div>' +
      '<div class="card" id="rsum" style="padding:14px"></div><div id="rlist" class="group"></div>';
    S.built.riwayat = 1;
  }
  const mo = monthOptions();
  $('#fbulan').innerHTML = '<option value="all">Semua bulan</option>' + mo.map((k) => '<option value="' + k + '">' + mLabel(k) + '</option>').join('');
  $('#fbulan').value = S.f.bulan;
  $('#fkat').innerHTML = '<option value="">Semua kategori</option>' + S.kat.map((k) => '<option>' + esc(k.nama) + '</option>').join('');
  $('#fkat').value = S.f.kat;
  $('#fjenis').innerHTML = [['all', 'Semua'], [OUT, 'Pengeluaran'], [IN, 'Pemasukan']].map((x) => '<button type="button" class="chip' + (S.f.jenis === x[0] ? ' on' : '') + '" data-jenis="' + x[0] + '" aria-pressed="' + (S.f.jenis === x[0]) + '">' + (x[0] === OUT ? '<i style="background:var(--out)"></i>' : x[0] === IN ? '<i style="background:var(--in)"></i>' : '') + x[1] + '</button>').join('');
  $('#rentang').hidden = !S.f.rentang;
  updateRiwayatList();
}
function filtered() {
  const f = S.f, q = f.q.trim().toLowerCase();
  return S.trx.filter((t) => {
    if (f.jenis !== 'all' && t.jenis !== f.jenis) return false;
    if (f.dari || f.sampai) { if (f.dari && t.tgl < f.dari) return false; if (f.sampai && t.tgl > f.sampai) return false; }
    else if (f.bulan !== 'all' && t.tgl.slice(0, 7) !== f.bulan) return false;
    if (f.kat && t.kategori !== f.kat) return false;
    if (q && (t.ket + ' ' + t.kategori + ' ' + nameOf(t.oleh)).toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
}
function updateRiwayatList() {
  const all = filtered(), t = totals(all), show = all.slice(0, S.f.limit);
  $('#rsum').innerHTML = '<div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><div><span class="eyebrow">Hasil filter</span><div style="font-weight:800;font-size:16px">' + nf.format(all.length) + ' transaksi</div></div>' +
    '<div style="text-align:right;font-size:13px"><div class="amt-in num" style="font-weight:800">+' + rp(t.in) + '</div><div class="amt-out num" style="font-weight:800">−' + rp(t.out) + '</div></div></div>';
  if (!all.length) { $('#rlist').innerHTML = emptyBox('search', 'Tidak ada transaksi', 'Ubah filter atau tambahkan transaksi baru.'); return; }
  const groups = []; let cur = null;
  show.forEach((x) => { if (!cur || cur.d !== x.tgl) { cur = { d: x.tgl, items: [] }; groups.push(cur); } cur.items.push(x); });
  $('#rlist').innerHTML = groups.map((g) => {
    const gt = totals(g.items), net = gt.in - gt.out;
    return '<div class="group" role="list" aria-label="' + esc(dayLabel(g.d)) + '"><div class="day"><span>' + esc(dayLabel(g.d)) + '</span><span class="num ' + (net >= 0 ? 'amt-in' : 'amt-out') + '">' + (net >= 0 ? '+' : '−') + rp(Math.abs(net)) + '</span></div>' + g.items.map(trxCard).join('') + '</div>';
  }).join('') + (all.length > show.length ? '<button class="btn block" type="button" data-act="more">Muat lebih banyak (' + (all.length - show.length) + ')</button>' : '');
}
function trxCard(t) {
  const ed = canEdit(t), who = nameOf(t.oleh) + (t.oleh && S.pengguna.some((p) => p.email === t.oleh && p.peran === OWNER) ? ' (Pemilik)' : '');
  return '<div class="trx-card' + (t.jenis === IN ? ' income' : '') + (S.pend[t.id] ? ' pending' : '') + '" role="listitem">' +
    '<div class="trx" style="padding:0">' + catIc(t.kategori) + '<div class="m"><b>' + esc(t.ket || t.kategori) + '</b><small>' + esc(t.kategori) + '</small></div>' +
    '<div class="r"><b class="num ' + (t.jenis === IN ? 'amt-in' : 'amt-out') + '">' + sgn(t.nominal, t.jenis) + '</b><small>' + (S.pend[t.id] ? 'Menyinkronkan…' : '') + '</small></div></div>' +
    '<div class="foot"><span class="who">' + esc(who) + '</span>' +
    (ed ? '<div class="acts"><button class="ib" type="button" data-act="edit" data-id="' + esc(t.id) + '" aria-label="Ubah transaksi ' + esc(t.ket || t.kategori) + '">' + ic('edit') + '</button><button class="ib del" type="button" data-act="del" data-id="' + esc(t.id) + '" aria-label="Hapus transaksi ' + esc(t.ket || t.kategori) + '">' + ic('delete') + '</button></div>'
      : '<span class="lock">' + ic('lock') + 'Hanya pencatat</span>') + '</div></div>';
}

/* ---- ekspor Excel / PDF (pustaka dimuat saat dibutuhkan) ---- */
const LIB = {
  chart: 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  xlsx: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  atable: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js'
};
const loaded = {};
function loadScript(url) {
  if (loaded[url]) return loaded[url];
  loaded[url] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = url; s.async = true; s.onload = res; s.onerror = () => { delete loaded[url]; rej(new Error('Gagal memuat pustaka. Periksa koneksi internet.')); }; document.head.appendChild(s); });
  return loaded[url];
}
function periodeLabel() {
  const f = S.f; if (f.dari || f.sampai) return (f.dari || '…') + ' s/d ' + (f.sampai || '…');
  return f.bulan === 'all' ? 'Semua periode' : mLabel(f.bulan);
}
function filterDesk() {
  const f = S.f, p = ['Periode: ' + periodeLabel()];
  if (f.jenis !== 'all') p.push('Jenis: ' + f.jenis); if (f.kat) p.push('Kategori: ' + f.kat); if (f.q.trim()) p.push('Cari: "' + f.q.trim() + '"');
  return p.join('  |  ');
}
async function exportFile(kind, btn) {
  const rows = filtered().slice().sort((a, b) => (a.tgl < b.tgl ? -1 : a.tgl > b.tgl ? 1 : (a.dibuat || 0) - (b.dibuat || 0)));
  if (!rows.length) { toast('Tidak ada data untuk diunduh.', 'err'); return; }
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = ic('sync') + 'Menyiapkan…';
  const t = totals(rows), nama = 'Dompetku_' + periodeLabel().replace(/[^\w-]+/g, '_');
  try {
    if (kind === 'xlsx') {
      await loadScript(LIB.xlsx);
      const aoa = [['Tanggal', 'Jenis', 'Kategori', 'Keterangan', 'Nominal (Rp)', 'Pencatat']];
      rows.forEach((r) => aoa.push([r.tgl, r.jenis, r.kategori, r.ket, r.nominal, nameOf(r.oleh)]));
      aoa.push([], ['', '', '', 'Total Pemasukan', t.in], ['', '', '', 'Total Pengeluaran', t.out], ['', '', '', 'Selisih', t.in - t.out]);
      const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 34 }, { wch: 16 }, { wch: 16 }];
      for (let i = 2; i <= aoa.length; i++) { const c = ws['E' + i]; if (c && typeof c.v === 'number') c.z = '#,##0'; }
      const per = {}; rows.forEach((r) => { const k = r.jenis + '|' + r.kategori; per[k] = (per[k] || 0) + r.nominal; });
      const a2 = [['Jenis', 'Kategori', 'Total (Rp)']]; Object.keys(per).sort().forEach((k) => a2.push([k.split('|')[0], k.split('|')[1], per[k]]));
      const ws2 = XLSX.utils.aoa_to_sheet(a2); ws2['!cols'] = [{ wch: 14 }, { wch: 24 }, { wch: 16 }];
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Transaksi'); XLSX.utils.book_append_sheet(wb, ws2, 'Per Kategori');
      XLSX.writeFile(wb, nama + '.xlsx');
    } else {
      await loadScript(LIB.jspdf); await loadScript(LIB.atable);
      const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
      doc.setFontSize(16); doc.text('Dompetku - Laporan Transaksi', 40, 46);
      doc.setFontSize(9); doc.setTextColor(90); doc.text(doc.splitTextToSize(filterDesk(), 515), 40, 64);
      doc.text('Dicetak: ' + fmtTgl(isoDay(0)) + ' oleh ' + nameOf(S.user.email), 40, 88);
      doc.autoTable({
        startY: 102, head: [['Tanggal', 'Jenis', 'Kategori', 'Keterangan', 'Nominal (Rp)', 'Pencatat']],
        body: rows.map((r) => [fmtTgl(r.tgl), r.jenis, r.kategori, r.ket, nf.format(r.nominal), nameOf(r.oleh)]),
        foot: [['', '', '', 'Total Pemasukan', nf.format(t.in), ''], ['', '', '', 'Total Pengeluaran', nf.format(t.out), ''], ['', '', '', 'Selisih', nf.format(t.in - t.out), '']],
        styles: { fontSize: 8, cellPadding: 4 }, headStyles: { fillColor: [255, 217, 61], textColor: [31, 34, 55] }, footStyles: { fillColor: [244, 242, 255], textColor: [31, 34, 55] },
        columnStyles: { 4: { halign: 'right' } }
      });
      doc.save(nama + '.pdf');
    }
    toast('File ' + (kind === 'xlsx' ? 'Excel' : 'PDF') + ' diunduh (' + rows.length + ' baris).');
  } catch (e) { toast(e.message || 'Gagal membuat file.', 'err'); }
  btn.disabled = false; btn.innerHTML = old;
}

/* ============================================================
   FORM TAMBAH / UBAH
   ============================================================ */
function openForm(trx) {
  const jenis = trx ? trx.jenis : OUT;
  S.form = { id: trx ? trx.id : null, jenis: jenis, nominal: trx ? trx.nominal : 0, kat: trx ? trx.kategori : '', tgl: trx ? trx.tgl : isoDay(0), ket: trx ? trx.ket : '' };
  if (!S.form.kat) S.form.kat = defaultCat(jenis);
  renderForm();
}
function defaultCat(jenis) {
  const last = lsGet('dk_lastcat_' + jenis), ok = S.kat.filter((k) => k.jenis === jenis);
  return (ok.filter((k) => k.nama === last)[0] || ok[0] || {}).nama || '';
}
function renderForm() {
  const F = S.form, cats = S.kat.filter((k) => k.jenis === F.jenis), edit = !!F.id;
  $('#saveTxt').textContent = edit ? 'Simpan Perubahan' : 'Simpan Transaksi';
  $('#v-tambah').innerHTML =
    '<div style="display:flex;align-items:center;gap:6px"><button class="ib bg" type="button" data-act="back" aria-label="Kembali">' + ic('arrow_back') + '</button><h1 class="page" style="font-size:22px">' + (edit ? 'Ubah Transaksi' : 'Tambah Transaksi') + '</h1></div>' +
    '<div class="seg" role="group" aria-label="Jenis transaksi"><button type="button" data-fjenis="' + OUT + '" class="out' + (F.jenis === OUT ? ' on' : '') + '" aria-pressed="' + (F.jenis === OUT) + '">' + ic('arrow_downward') + 'Pengeluaran</button><button type="button" data-fjenis="' + IN + '" class="in' + (F.jenis === IN ? ' on' : '') + '" aria-pressed="' + (F.jenis === IN) + '">' + ic('arrow_upward') + 'Pemasukan</button></div>' +
    '<div class="amount-box"><label class="eyebrow" for="fnom">Nominal transaksi</label><div class="amount-row"><span>Rp</span><input id="fnom" inputmode="numeric" autocomplete="off" placeholder="0" value="' + (F.nominal ? nf.format(F.nominal) : '') + '" aria-describedby="enom"></div></div>' +
    '<div class="err" id="enom" role="alert"></div>' +
    '<div class="quick" role="group" aria-label="Tambah nominal cepat"><button type="button" data-add="10000">+10 rb</button><button type="button" data-add="50000">+50 rb</button><button type="button" data-add="100000">+100 rb</button><button type="button" data-add="500000">+500 rb</button><button type="button" class="reset" data-add="0">Reset</button></div>' +
    '<div class="field"><label id="lcat">Pilih kategori</label><div class="catpick" role="radiogroup" aria-labelledby="lcat">' + cats.map((k) => '<button type="button" role="radio" aria-checked="' + (k.nama === F.kat) + '" class="' + (k.nama === F.kat ? 'on' : '') + '" style="--c:' + esc(k.warna) + '" data-cat="' + esc(k.nama) + '"><span class="cat-ic" style="--c:' + esc(k.warna) + '">' + ic(esc(k.ikon), k.nama === F.kat) + '</span><span class="n">' + esc(k.nama) + '</span></button>').join('') + '</div><div class="err" id="ecat" role="alert"></div></div>' +
    '<div id="fhint"></div>' +
    '<div class="field"><label for="ftgl">Tanggal</label><input class="input" type="date" id="ftgl" value="' + F.tgl + '" max="' + isoDay(1) + '"><div class="err" id="etgl" role="alert"></div></div>' +
    '<div class="field"><label for="fket">Keterangan (opsional)</label><input class="input" id="fket" maxlength="200" placeholder="Contoh: makan siang bersama rekan" value="' + esc(F.ket) + '" autocomplete="off"></div>';
  updateHint();
}
function updateHint() {
  const F = S.form, box = $('#fhint'); if (!box) return;
  if (F.jenis !== OUT) { box.innerHTML = ''; return; }
  const k = katMap()[F.kat]; if (!k) { box.innerHTML = ''; return; }
  if (!k.batas) { box.innerHTML = '<div class="hint">' + ic('lightbulb') + '<div>Kategori <b>' + esc(k.nama) + '</b> belum punya batas anggaran.</div></div>'; return; }
  const m = (F.tgl || isoDay(0)).slice(0, 7);
  const spent = monthTrx(m).filter((t) => t.jenis === OUT && t.kategori === k.nama && t.id !== F.id).reduce((a, t) => a + t.nominal, 0) + (F.nominal || 0);
  const p = spent / k.batas * 100, sisa = k.batas - spent;
  box.innerHTML = '<div class="hint ' + lvl(p) + '">' + ic(lvlIc(p), true) + '<div>' + (sisa >= 0 ? 'Sisa anggaran <b>' + esc(k.nama) + '</b>: <b>' + rp(sisa) + '</b> dari ' + rp(k.batas) : '<b>' + esc(k.nama) + '</b> melebihi anggaran <b>' + rp(-sisa) + '</b> (batas ' + rp(k.batas) + ')') + ' <span class="stat ' + lvl(p) + '" style="margin-left:4px">' + lvlTxt(p) + '</span></div></div>';
}
function saveForm() {
  const F = S.form; let ok = true;
  const setE = (id, m) => { const e = $('#' + id); if (e) e.textContent = m || ''; if (m) ok = false; };
  F.ket = $('#fket').value.trim(); F.tgl = $('#ftgl').value;
  setE('enom', F.nominal > 0 ? '' : 'Nominal wajib diisi dan harus lebih dari 0.');
  setE('ecat', F.kat && katMap()[F.kat] && katMap()[F.kat].jenis === F.jenis ? '' : 'Pilih kategori yang sesuai.');
  setE('etgl', !F.tgl ? 'Tanggal wajib diisi.' : F.tgl > isoDay(1) ? 'Tanggal tidak boleh di masa depan lebih dari satu hari.' : '');
  if (!ok) { const f = $('.err:not(:empty)'); if (f) f.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (F.nominal <= 0) $('#fnom').focus(); return; }
  const trx = { id: F.id || newId(), tgl: F.tgl, jenis: F.jenis, kategori: F.kat, nominal: Math.round(F.nominal), ket: F.ket };
  lsSet('dk_lastcat_' + F.jenis, F.kat);
  const edit = !!F.id;
  if (edit) queueEdit(trx); else enqueue({ type: 'add', trx: trx, ts: Date.now() });
  // peringatan anggaran 80% / 100%
  let w = null;
  if (F.jenis === OUT) { const r = budgetRows(F.tgl.slice(0, 7), 1).filter((x) => x.k.nama === F.kat)[0]; if (r && r.pct >= 80) w = r; }
  S.form = null; go(S.prev === 'tambah' ? 'beranda' : S.prev);
  if (w) toast(w.k.nama + (w.pct >= 100 ? ' melewati anggaran (' : ' sudah ') + Math.round(w.pct) + (w.pct >= 100 ? '%)' : '% dari anggaran'), 'warn');
  else toast((edit ? 'Perubahan disimpan • ' : 'Transaksi disimpan • ') + rp(trx.nominal));
}

/* ============================================================
   ANTREAN SINKRONISASI (Optimistic UI + batch)
   ============================================================ */
function enqueue(op) { S.queue.push(op); afterQueue(); }
function afterQueue() { saveQueue(); recompute(); renderAfterData(); flush(); }
function queueEdit(trx) {
  const i = S.queue.findIndex((o, n) => n >= S.inflight && o.type === 'add' && o.trx.id === trx.id);
  if (i > -1) { S.queue[i].trx = trx; afterQueue(); return; }
  const j = S.queue.findIndex((o, n) => n >= S.inflight && o.type === 'edit' && o.trx.id === trx.id);
  if (j > -1) { S.queue[j].trx = trx; afterQueue(); return; }
  enqueue({ type: 'edit', trx: trx });
}
function queueDel(id) {
  const i = S.queue.findIndex((o, n) => n >= S.inflight && o.type === 'add' && o.trx.id === id);
  if (i > -1) { S.queue = S.queue.filter((o, n) => n !== i && !(n > i && o.trx && o.trx.id === id)); afterQueue(); return; }
  S.queue = S.queue.filter((o, n) => n < S.inflight || !(o.type === 'edit' && o.trx.id === id));
  enqueue({ type: 'del', id: id });
}
let flushTimer, watchdog, retryN = 0;
function flush() {
  clearTimeout(flushTimer);
  if (S.inflight || !S.queue.length) { updateSync(); return; }
  const batch = S.queue.slice(0, 50); S.inflight = batch.length; updateSync();
  let done = false;
  watchdog = setTimeout(() => { if (!done) { done = true; fail(); } }, 50000);
  const fail = () => { S.inflight = 0; retryN++; S.online = false; updateSync(); flushTimer = setTimeout(flush, Math.min(30000, 2500 * retryN)); };
  gs('sinkronkan', batch).then((res) => {
    if (done) return; done = true; clearTimeout(watchdog);
    S.inflight = 0;
    if (!res || !res.success) {
      const msg = (res && res.message) || 'Gagal menyinkronkan.';
      if (/belum terdaftar/.test(msg)) { toast(msg, 'err'); S.queue = []; saveQueue(); recompute(); renderAfterData(); updateSync(); return; }
      toast(msg, 'err'); retryN++; S.online = false; updateSync(); flushTimer = setTimeout(flush, Math.min(30000, 2500 * retryN)); return;
    }
    retryN = 0; S.online = true; S.lastSync = Date.now();
    if (res.base && res.base === S.sv && res.v) S.sv = res.v; else if (res.v) S.sv = '';   // versi cocok => data lokal sudah mutakhir
    S.queue.splice(0, batch.length);
    batch.forEach((op, i) => {
      const r = res.results[i] || { ok: true };
      if (!r.ok) { toast(r.message || 'Satu perubahan ditolak server.', 'err'); return; }
      if (op.type === 'add') { if (!S.srv.some((x) => x.id === op.trx.id)) S.srv.push(Object.assign({}, op.trx, { oleh: S.user.email, dibuat: op.ts || Date.now() })); }
      else if (op.type === 'edit') S.srv = S.srv.map((x) => (x.id === op.trx.id ? Object.assign({}, x, op.trx) : x));
      else if (op.type === 'del') S.srv = S.srv.filter((x) => x.id !== op.id);
    });
    saveQueue(); recompute(); saveLocal(); renderAfterData(); updateSync();
    if (S.queue.length) flush();
  }).catch((e) => { if (done) return; done = true; clearTimeout(watchdog); if (e && e.auth) { S.inflight = 0; updateSync(); return; } fail(); });
}
function updateSync() {
  const b = $('#sync'); if (!b) return;
  const n = S.queue.length; let cls = 'sync', icon = 'cloud_done', txt = 'Tersimpan';
  if (S.inflight) { cls += ' busy'; icon = 'sync'; txt = 'Menyinkronkan…'; }
  else if (n) { cls += ' off'; icon = 'cloud_off'; txt = n + ' tertunda'; }
  b.className = cls; b.innerHTML = ic(icon) + '<span id="syncTxt">' + txt + '</span>';
}
function renderAfterData() {
  if (S.view === 'tambah') return;
  if (S.view === 'riwayat') { renderRiwayat(); return; }
  renderView(S.view);
}
let refreshing = false;
async function refresh(manual) {
  if (refreshing) return; refreshing = true;
  try {
    const d = await gs('ambilData', S.sv || '');
    if (d && d.success === false) throw new Error(d.message || 'Gagal memuat.');
    if (d && d.status === 'ok' && d.unchanged) { S.lastSync = Date.now(); S.online = true; if (manual) toast('Data sudah yang terbaru.'); }
    else if (d && d.status === 'ok') {
      const keep = S.queue.length; setData(d); S.lastSync = Date.now(); S.online = true;
      if (S.view !== 'tambah') renderAfterData();
      if (manual) toast('Data diperbarui' + (keep ? ' (' + keep + ' perubahan masih tertunda)' : '') + '.');
    } else if (d) { renderGate(d); }
  } catch (e) { if (e && e.auth) { refreshing = false; return; } S.online = false; if (manual) toast('Gagal memuat data: ' + e.message, 'err'); }
  refreshing = false; updateSync();
}

/* ============================================================
   RINGKASAN & GRAFIK
   ============================================================ */
function cssv(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function destroyCharts() { S.charts.forEach((c) => { try { c.destroy(); } catch (e) { /* abaikan */ } }); S.charts = []; }
const short = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1).replace('.0', '') + ' M' : n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + ' jt' : n >= 1e3 ? Math.round(n / 1e3) + ' rb' : String(n));
function renderRingkasan() {
  destroyCharts();
  const year = S.rmode === 'tahun', pre = year ? S.bulan.slice(0, 4) : S.bulan, list = S.trx.filter((t) => t.tgl.slice(0, pre.length) === pre), t = totals(list);
  const spend = {}; list.forEach((x) => { if (x.jenis === OUT) spend[x.kategori] = (spend[x.kategori] || 0) + x.nominal; });
  const cats = Object.keys(spend).map((n) => ({ n: n, v: spend[n], c: (katMap()[n] || { warna: '#7C6CF0' }).warna })).sort((a, b) => b.v - a.v);
  const months = []; if (year) for (let i = 1; i <= 12; i++) months.push(pre + '-' + pad(i)); else for (let i = 5; i >= 0; i--) months.push(mShift(S.bulan, -i));
  const mt = months.map((k) => totals(monthTrx(k)));
  const act = mt.filter((x) => x.in || x.out), avg = act.length ? act.reduce((a, x) => a + x.in - x.out, 0) / act.length : 0;
  const rows = budgetRows(pre, year ? 12 : 1), tl = rows.reduce((a, r) => a + r.limit, 0), ts = rows.reduce((a, r) => a + r.spent, 0), bp = tl ? ts / tl * 100 : 0;
  const R = 15.9155, dash = Math.min(100, bp);
  $('#v-ringkasan').innerHTML =
    '<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap"><div class="seg" style="flex:1;min-width:200px" role="group" aria-label="Periode"><button type="button" data-mode="bulan" class="' + (!year ? 'on in' : '') + '" style="' + (!year ? 'background:var(--yellow);color:var(--yellow-ink)' : '') + '" aria-pressed="' + !year + '">Bulanan</button><button type="button" data-mode="tahun" class="' + (year ? 'on in' : '') + '" style="' + (year ? 'background:var(--yellow);color:var(--yellow-ink)' : '') + '" aria-pressed="' + year + '">Tahunan</button></div>' +
    '<div class="monthnav" style="background:var(--surface);border:1px solid var(--line)" role="group" aria-label="Pilih periode"><button type="button" data-act="mprev" aria-label="Sebelumnya" style="color:var(--ink)">' + ic('chevron_left') + '</button><span>' + (year ? pre : mLabel(S.bulan)) + '</span><button type="button" data-act="mnext" aria-label="Berikutnya" style="color:var(--ink)"' + ((year ? +pre >= +NOW_M.slice(0, 4) : S.bulan >= NOW_M) ? ' disabled' : '') + '>' + ic('chevron_right') + '</button></div></div>' +
    '<div class="card"><div class="card-h"><div><span class="eyebrow">Analisis pengeluaran</span><h2 class="t">Proporsi Kategori</h2></div><span class="pill">' + cats.length + ' kategori</span></div>' +
    (cats.length ? '<div class="chart-wrap" id="cw1"><canvas id="chDonut" role="img" aria-label="Grafik donat proporsi pengeluaran per kategori"></canvas><div class="donut-center"><small>Total keluar</small><b class="num">' + rp(t.out) + '</b></div></div>' +
      '<div class="legend">' + cats.map((c) => '<div class="lg"><div class="l"><i style="background:' + esc(c.c) + '"></i><span>' + esc(c.n) + '</span></div><div class="r"><span class="num">' + rp(c.v) + '</span><em>' + Math.round(c.v / t.out * 100) + '%</em></div></div>').join('') + '</div>'
      : emptyBox('donut_large', 'Belum ada pengeluaran', 'Grafik muncul setelah ada transaksi pengeluaran pada periode ini.')) + '</div>' +
    '<div class="card"><div class="card-h"><div><span class="eyebrow">Tren kas</span><h2 class="t">Pemasukan vs Pengeluaran</h2></div><div class="keys"><span><i style="background:#7C6CF0"></i>Masuk</span><span><i style="background:#2F9BFF"></i>Keluar</span></div></div>' +
    '<div class="chart-wrap bars"><canvas id="chBar" role="img" aria-label="Grafik batang pemasukan dan pengeluaran per bulan"></canvas></div>' +
    '<div class="kv" style="margin-top:12px"><div><small>Rata-rata selisih / bulan</small><b class="num ' + (avg >= 0 ? 'amt-in' : 'amt-out') + '">' + (avg >= 0 ? '+' : '−') + rp(Math.abs(avg)) + '</b></div><span class="stat ' + (avg >= 0 ? 'ok' : 'bad') + '">' + ic(avg >= 0 ? 'verified' : 'warning') + (avg >= 0 ? 'Arus kas sehat' : 'Arus kas defisit') + '</span></div></div>' +
    '<div class="card"><div class="card-h"><div style="display:flex;align-items:center;gap:12px"><div class="ring" role="img" aria-label="' + Math.round(bp) + ' persen anggaran terpakai"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="' + R + '" fill="none" stroke="var(--surface-3)" stroke-width="4.5"/><circle cx="18" cy="18" r="' + R + '" fill="none" stroke="' + (bp >= 100 ? '#DC2626' : bp >= 80 ? '#F5B301' : '#FFD93D') + '" stroke-width="4.5" stroke-linecap="round" stroke-dasharray="' + dash + ' 100"/></svg><b class="num">' + Math.round(bp) + '%</b></div><div><span class="eyebrow">Batas pengeluaran</span><h2 class="t">Anggaran ' + (year ? 'Tahunan' : 'Keluarga') + '</h2></div></div>' +
    '<div style="text-align:right"><small class="sub">Sisa kuota</small><div class="num" style="font-weight:800;font-size:16px">' + rp(Math.max(0, tl - ts)) + '</div></div></div>' +
    (rows.length ? '<div style="display:flex;flex-direction:column;gap:10px">' + rows.map((r) => '<div class="bud"><div class="h"><div class="n">' + catIc(r.k.nama, true) + '<span>' + esc(r.k.nama) + '</span></div><span class="stat ' + lvl(r.pct) + '">' + ic(lvlIc(r.pct)) + lvlTxt(r.pct) + '</span></div><div class="bar"><i class="' + (r.pct >= 100 ? 'bad' : r.pct >= 80 ? 'warn' : '') + '" style="width:' + Math.min(100, r.pct) + '%"></i></div><div class="f"><span>Terpakai <b class="num">' + rp(r.spent) + '</b></span><span>Batas ' + rp(r.limit) + '</span></div></div>').join('') + '</div>'
      : '<p class="sub">Belum ada batas anggaran per kategori.</p>') +
    (isOwner() ? '<div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--line);margin-top:14px;padding-top:6px"><span class="sub" style="display:flex;align-items:center;gap:4px">' + ic('lock_person') + 'Akses Pemilik</span><button class="link" type="button" data-go="pengaturan">Kelola anggaran' + ic('arrow_forward') + '</button></div>' : '') + '</div>';
  if (!cats.length && t.in === 0 && t.out === 0 && !act.length) return;
  loadScript(LIB.chart).then(() => {
    if (S.view !== 'ringkasan' || !window.Chart) return;
    destroyCharts();
    const tx = cssv('--ink-2'), grid = cssv('--line'), surf = cssv('--surface');
    Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif"; Chart.defaults.color = tx;
    const tip = { callbacks: { label: (c) => ' ' + c.dataset.label + ': ' + rp(c.parsed.y != null ? c.parsed.y : c.parsed) } };
    const d = $('#chDonut');
    if (d) S.charts.push(new Chart(d, { type: 'doughnut', data: { labels: cats.map((c) => c.n), datasets: [{ label: 'Pengeluaran', data: cats.map((c) => c.v), backgroundColor: cats.map((c) => c.c), borderColor: surf, borderWidth: 3, hoverOffset: 6 }] }, options: { cutout: '70%', maintainAspectRatio: false, animation: { duration: 400 }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' ' + c.label + ': ' + rp(c.parsed) } } } } }));
    const b = $('#chBar');
    if (b) S.charts.push(new Chart(b, { type: 'bar', data: { labels: months.map((k) => BLN[+k.slice(5, 7) - 1]), datasets: [{ label: 'Pemasukan', data: mt.map((x) => x.in), backgroundColor: '#7C6CF0', borderRadius: 8, maxBarThickness: 18 }, { label: 'Pengeluaran', data: mt.map((x) => x.out), backgroundColor: '#2F9BFF', borderRadius: 8, maxBarThickness: 18 }] }, options: { maintainAspectRatio: false, animation: { duration: 400 }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: grid, borderDash: [4, 4] }, border: { display: false }, ticks: { callback: (v) => short(v), maxTicksLimit: 4 } } }, plugins: { legend: { display: false }, tooltip: tip } } }));
  }).catch(() => { $$('.chart-wrap canvas').forEach((c) => { c.parentNode.insertAdjacentHTML('afterbegin', '<p class="sub" style="text-align:center">Grafik tidak dapat dimuat (periksa koneksi). Angka tetap tersedia di bawah.</p>'); c.remove(); }); });
}

/* ============================================================
   PENGATURAN
   ============================================================ */
function renderPengaturan() {
  const u = S.user, own = isOwner(), rows = budgetRows(NOW_M, 1), rm = {}; rows.forEach((r) => { rm[r.k.nama] = r; });
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  $('#v-pengaturan').innerHTML =
    '<div class="card"><div class="profile"><div class="avatar lg">' + esc(ini(u.nama)) + '</div><div style="min-width:0"><div class="nm">' + esc(u.nama) + '</div><div class="em">' + esc(u.email) + '</div><div style="margin-top:6px"><span class="chip-role">' + (own ? '👑 ' : '') + esc(u.peran) + '</span></div></div></div></div>' +
    '<div class="note">' + ic('admin_panel_settings', true) + '<div>' + (own ? '<b>Hak akses Pemilik.</b> Anda dapat mengelola kategori, anggaran, anggota keluarga, dan mengubah transaksi siapa pun.' : '<b>Anggota Keluarga.</b> Anda dapat mencatat transaksi dan melihat laporan. Kategori, anggaran, dan undangan dikelola Pemilik.') + '</div></div>' +
    '<div class="sec-h"><div style="display:flex;align-items:center;gap:8px"><h2 class="t">Kategori &amp; Anggaran</h2><span class="pill">' + S.kat.length + '</span></div>' + (own ? '<button class="btn sm primary" type="button" data-act="kat-add">' + ic('add') + 'Tambah</button>' : '') + '</div>' +
    '<div style="display:flex;flex-direction:column;gap:10px">' + S.kat.map((k) => {
      const r = rm[k.nama];
      return '<div class="cat-row"><div class="h"><div class="n">' + catIc(k.nama) + '<div><b>' + esc(k.nama) + '</b><small>' + esc(k.jenis) + (k.jenis === OUT ? ' • ' + (k.batas ? 'Batas ' + rp(k.batas) + '/bln' : 'Tanpa batas') : '') + '</small></div></div>' +
        (own ? '<div class="a"><button class="ib" type="button" data-act="kat-edit" data-n="' + esc(k.nama) + '" aria-label="Ubah kategori ' + esc(k.nama) + '">' + ic('edit') + '</button><button class="ib del" type="button" data-act="kat-del" data-n="' + esc(k.nama) + '" aria-label="Hapus kategori ' + esc(k.nama) + '">' + ic('delete') + '</button></div>' : '') + '</div>' +
        (r ? '<div><div class="kv" style="margin-bottom:6px"><span class="stat ' + lvl(r.pct) + '">' + ic(lvlIc(r.pct)) + lvlTxt(r.pct) + '</span><b class="num" style="font-size:13px">' + rp(r.spent) + '</b></div><div class="bar"><i class="' + (r.pct >= 100 ? 'bad' : r.pct >= 80 ? 'warn' : '') + '" style="width:' + Math.min(100, r.pct) + '%"></i></div></div>' : '') + '</div>';
    }).join('') + '</div>' +
    '<div class="sec-h"><div style="display:flex;align-items:center;gap:8px"><h2 class="t">Anggota Keluarga</h2><span class="pill">' + S.pengguna.length + ' orang</span></div>' + (own ? '<button class="btn sm" type="button" data-act="mem-add">' + ic('person_add') + 'Undang</button>' : '') + '</div>' +
    '<div class="card" style="padding:8px 16px">' + S.pengguna.map((p) => '<div class="member"><div class="n"><div class="avatar sm">' + esc(ini(p.nama)) + '</div><div><b>' + esc(p.nama) + (p.email === u.email ? ' (Anda)' : '') + '</b><small>' + esc(p.email) + '</small></div></div><div style="display:flex;align-items:center;gap:2px;flex:none"><span class="pill" style="' + (p.peran === OWNER ? 'background:var(--yellow);color:var(--yellow-ink)' : '') + '">' + esc(p.peran) + '</span>' + (own && p.email !== u.email ? '<button class="ib del" type="button" data-act="mem-del" data-e="' + esc(p.email) + '" aria-label="Hapus ' + esc(p.nama) + '">' + ic('person_remove') + '</button>' : '') + '</div></div>').join('') + '</div>' +
    '<h2 class="t" style="padding:0 4px">Tampilan &amp; Data</h2>' +
    '<div class="card"><div class="setrow"><div><b>Mode gelap</b><small>Nyaman untuk mata di malam hari</small></div><button class="sw" type="button" role="switch" aria-checked="' + dark + '" aria-label="Mode gelap" data-act="tema"></button></div>' +
    '<div class="setrow" style="border-top:1px solid var(--line);margin-top:8px;padding-top:8px"><div><b>Sinkronisasi</b><small id="syncDesc">' + (S.queue.length ? S.queue.length + ' perubahan menunggu dikirim' : 'Semua perubahan tersimpan di Google Sheets') + '</small></div><button class="btn sm" type="button" data-act="refresh">' + ic('refresh') + 'Muat ulang</button></div>' +
    (own ? '<div class="setrow" style="border-top:1px solid var(--line);margin-top:8px;padding-top:8px"><div><b>Spreadsheet database</b><small>Dompetku_DB</small></div>' + (S.dbUrl ? '<a class="btn sm" href="' + esc(S.dbUrl) + '" target="_blank" rel="noopener">Buka ' + ic('open_in_new') + '</a>' : '') + '</div>' +
      '<div class="setrow" style="border-top:1px solid var(--line);margin-top:8px;padding-top:8px"><div><b>Impor dari spreadsheet lama</b><small>Pindai dulu, lalu impor. Aman diulang.</small></div><button class="btn sm" type="button" data-act="migrasi">' + ic('upload_file') + 'Impor</button></div>' : '') + '</div>' +
    '<div class="card" style="padding:8px 16px"><div class="setrow"><div><b>Keluar</b><small>' + esc(u.email) + '</small></div><button class="btn sm" type="button" data-act="logout">' + ic('logout') + 'Keluar</button></div></div>' +
    '<p class="sub" style="text-align:center">Dompetku v1.1 • GitHub Pages + Google Apps Script' + (S.ms ? ' • server ' + S.ms + ' ms' : '') + '</p>';
}

/* ============================================================
   MODAL
   ============================================================ */
let lastFocus = null;
function openSheet(title, body, onMount) {
  lastFocus = document.activeElement;
  const h = $('#modalHost');
  h.innerHTML = '<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="shT"><div class="grab"></div><div class="h"><h2 id="shT">' + esc(title) + '</h2><button class="ib" type="button" data-close aria-label="Tutup">' + ic('close') + '</button></div>' + body + '</div></div>';
  const sc = $('#scrim'); sc.addEventListener('click', (e) => { if (e.target === sc || e.target.closest('[data-close]')) closeSheet(); });
  if (onMount) onMount($('.sheet', h));
  const f = $('input,select,button.btn', h); if (f && !/Mobi|Android/i.test(navigator.userAgent)) f.focus();
}
function closeSheet() { $('#modalHost').innerHTML = ''; if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) { /* abaikan */ } }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#scrim')) closeSheet(); });
function confirmBox(title, text, okText, danger) {
  return new Promise((resolve) => {
    openSheet(title, '<p class="sub" style="font-size:14.5px">' + text + '</p><div style="display:flex;gap:10px"><button class="btn block" type="button" data-close>Batal</button><button class="btn block ' + (danger ? 'danger' : 'primary') + '" type="button" id="cOk">' + esc(okText) + '</button></div>', (el) => {
      $('#cOk', el).onclick = () => { closeSheet(); resolve(true); };
      $('#scrim').addEventListener('click', (e) => { if (e.target.id === 'scrim' || e.target.closest('[data-close]')) resolve(false); });
    });
  });
}
const COLORS = ['#F59E0B', '#34C38F', '#2F9BFF', '#7C6CF0', '#F0508A', '#EF4444', '#0EA5E9', '#14B8A6'];
const ICONS = ['restaurant', 'shopping_bag', 'directions_car', 'bolt', 'confirmation_number', 'favorite', 'school', 'payments', 'redeem', 'savings', 'home', 'flight', 'pets', 'checkroom', 'local_cafe', 'work'];
function katModal(nama) {
  const old = nama ? S.kat.filter((k) => k.nama === nama)[0] : null;
  const K = old ? Object.assign({}, old) : { nama: '', jenis: OUT, batas: 0, warna: COLORS[0], ikon: ICONS[0] };
  const used = old && S.trx.some((t) => t.kategori === old.nama);
  const body = '<div class="field"><label for="kn">Nama kategori</label><input class="input" id="kn" maxlength="40" value="' + esc(K.nama) + '" autocomplete="off"></div>' +
    '<div class="seg" role="group" aria-label="Jenis kategori"><button type="button" data-kj="' + OUT + '" class="out' + (K.jenis === OUT ? ' on' : '') + '"' + (used ? ' disabled' : '') + '>Pengeluaran</button><button type="button" data-kj="' + IN + '" class="in' + (K.jenis === IN ? ' on' : '') + '"' + (used ? ' disabled' : '') + '>Pemasukan</button></div>' +
    '<div class="field" id="kbw"><label for="kb">Batas anggaran bulanan (Rp)</label><input class="input" id="kb" inputmode="numeric" value="' + (K.batas ? nf.format(K.batas) : '') + '" placeholder="0 = tanpa batas" autocomplete="off"></div>' +
    '<div class="field"><label>Warna</label><div class="swatches" id="kw">' + COLORS.map((c) => '<button type="button" style="--c:' + c + '" data-c="' + c + '" class="' + (c === K.warna ? 'on' : '') + '" aria-label="Warna ' + c + '"></button>').join('') + '</div></div>' +
    '<div class="field"><label>Ikon</label><div class="swatches icons" id="ki">' + ICONS.map((i) => '<button type="button" style="--c:' + esc(K.warna) + '" data-i="' + i + '" class="' + (i === K.ikon ? 'on' : '') + '" aria-label="Ikon ' + i + '">' + ic(i) + '</button>').join('') + '</div></div>' +
    '<div class="err" id="kerr" role="alert"></div><button class="btn primary block" type="button" id="kSave">' + ic('check_circle') + 'Simpan kategori</button>';
  openSheet(old ? 'Ubah Kategori' : 'Tambah Kategori', body, (el) => {
    const sync = () => { $('#kbw', el).hidden = K.jenis !== OUT; $$('[data-kj]', el).forEach((b) => b.classList.toggle('on', b.getAttribute('data-kj') === K.jenis)); $$('#kw button', el).forEach((b) => b.classList.toggle('on', b.getAttribute('data-c') === K.warna)); $$('#ki button', el).forEach((b) => { b.classList.toggle('on', b.getAttribute('data-i') === K.ikon); b.style.setProperty('--c', K.warna); }); };
    sync();
    el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.kj) { K.jenis = b.dataset.kj; sync(); } if (b.dataset.c) { K.warna = b.dataset.c; sync(); } if (b.dataset.i) { K.ikon = b.dataset.i; sync(); } });
    $('#kb', el).addEventListener('input', (e) => { const n = e.target.value.replace(/\D/g, '').slice(0, 13); e.target.value = n ? nf.format(+n) : ''; });
    $('#kSave', el).onclick = async () => {
      K.nama = $('#kn', el).value.trim(); K.batas = +($('#kb', el).value.replace(/\D/g, '') || 0); if (K.jenis !== OUT) K.batas = 0;
      if (!K.nama) { $('#kerr', el).textContent = 'Nama kategori wajib diisi.'; return; }
      const btn = $('#kSave', el); btn.disabled = true; btn.innerHTML = ic('sync') + 'Menyimpan…';
      try { const r = await gs('simpanKategori', K, old ? old.nama : ''); if (!r.success) throw new Error(r.message); S.kat = r.kategori; S.srv = r.transaksi; S.sv = ''; recompute(); saveLocal(); closeSheet(); renderAfterData(); toast('Kategori disimpan.'); }
      catch (err) { $('#kerr', el).textContent = err.message; btn.disabled = false; btn.innerHTML = ic('check_circle') + 'Simpan kategori'; }
    };
  });
}
function invModal() {
  openSheet('Undang Anggota', '<p class="sub">Masukkan email akun Google anggota keluarga. Mereka akan bisa masuk sebagai <b>Anggota Keluarga</b>.</p><div class="field"><label for="ie">Email Google</label><input class="input" id="ie" type="email" inputmode="email" placeholder="anggota@gmail.com" autocomplete="off"></div><div class="field"><label for="in">Nama (opsional)</label><input class="input" id="in" maxlength="40" autocomplete="off"></div><div class="err" id="ierr" role="alert"></div><button class="btn primary block" type="button" id="iOk">' + ic('person_add') + 'Tambahkan</button>', (el) => {
    $('#iOk', el).onclick = async () => {
      const em = $('#ie', el).value.trim(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { $('#ierr', el).textContent = 'Format email tidak valid.'; return; }
      const b = $('#iOk', el); b.disabled = true;
      try { const r = await gs('undangAnggota', em, $('#in', el).value); if (!r.success) throw new Error(r.message); S.pengguna = r.pengguna; S.sv = ''; saveLocal(); closeSheet(); renderAfterData(); toast('Anggota ditambahkan.'); }
      catch (err) { $('#ierr', el).textContent = err.message; b.disabled = false; }
    };
  });
}
function migModal() {
  openSheet('Impor dari Spreadsheet Lama', '<p class="sub">Tempel ID atau tautan spreadsheet lama (sheet <b>Transaksi</b>, boleh juga <b>Kategori</b>). Spreadsheet lama hanya dibaca, tidak diubah. Data yang sama tidak akan ganda.</p><div class="field"><label for="ms">ID / tautan spreadsheet</label><input class="input" id="ms" placeholder="https://docs.google.com/spreadsheets/d/…" autocomplete="off"></div><div class="pre" id="mres" hidden></div><div style="display:flex;gap:10px"><button class="btn block" type="button" id="mScan">' + ic('search') + 'Pindai</button><button class="btn primary block" type="button" id="mGo" disabled>' + ic('upload_file') + 'Impor</button></div>', (el) => {
    const show = (r, dry) => { const x = $('#mres', el); x.hidden = false; x.innerHTML = (dry ? '<b>Simulasi (belum ada data ditulis)</b><br>' : '<b>Selesai</b><br>') + 'Transaksi: ' + r.transaksi.baru + ' baru, ' + r.transaksi.diperbarui + ' diperbarui, ' + r.transaksi.dilewati + ' dilewati<br>Kategori: ' + r.kategori.baru + ' baru' + (r.galat.length ? '<br>Catatan: ' + esc(r.galat.join('; ')) : ''); };
    const run = async (fn, btn, dry) => { const v = $('#ms', el).value.trim(); if (!v) { toast('Isi ID spreadsheet dulu.', 'err'); return; } const o = btn.innerHTML; btn.disabled = true; btn.innerHTML = ic('sync') + 'Memproses…';
      try { const r = await gs(fn, v); if (!r.success) throw new Error(r.message); show(r.hasil, dry); if (dry) $('#mGo', el).disabled = false; else { setData(r.data); renderAfterData(); toast('Impor selesai.'); } }
      catch (err) { toast(err.message, 'err'); } btn.innerHTML = o; btn.disabled = false; };
    $('#mScan', el).onclick = (e) => run('migrasiPindai', e.currentTarget, true);
    $('#mGo', el).onclick = (e) => run('migrasiImpor', e.currentTarget, false);
    $('#ms', el).addEventListener('input', () => { $('#mGo', el).disabled = true; });
  });
}

/* ============================================================
   GERBANG (masuk Google / akun belum terdaftar / error)
   ============================================================ */
let gisReady = null;
function loadGis() { return gisReady || (gisReady = loadScript('https://accounts.google.com/gsi/client').catch((e) => { gisReady = null; throw e; })); }
async function onCredential(resp) {
  const msg = $('#gMsg'); if (msg) { msg.hidden = false; msg.className = 'sub'; msg.textContent = 'Memeriksa akun…'; }
  try {
    const r = await call('login', { idToken: resp.credential }, '');
    if (!r.success) {
      if (r.code === 'UNREGISTERED') { renderGate({ status: 'unregistered', email: r.email }); return; }
      throw new Error(r.message || 'Gagal masuk.');
    }
    saveToken(r.token, r.user.email, r.exp);
    $('#gate').innerHTML = '<div class="gate"><div class="logo">' + ic('account_balance_wallet', true) + '</div><p class="sub">Memuat data…</p></div>';
    await bootFresh();
  } catch (e) { if (msg) { msg.hidden = false; msg.className = 'err'; msg.textContent = e.message; } }
}
function mountGoogleButton() {
  if (!CLIENT_ID || /ISI_/.test(CLIENT_ID)) { const m = $('#gMsg'); if (m) { m.hidden = false; m.className = 'err'; m.textContent = 'GOOGLE_CLIENT_ID di js/config.js belum diisi.'; } return; }
  loadGis().then(() => {
    const host = $('#gBtn'); if (!host) return;
    google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onCredential, auto_select: false, cancel_on_tap_outside: true });
    google.accounts.id.renderButton(host, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', locale: 'id', width: Math.min(300, host.clientWidth || 300) });
  }).catch(() => { const m = $('#gMsg'); if (m) { m.hidden = false; m.className = 'err'; m.textContent = 'Tidak dapat memuat Login Google. Periksa koneksi internet.'; } });
}
function renderGate(d) {
  stopPoll(); $('#app').hidden = true; const g = $('#gate'); g.hidden = false;
  const st = d.status || 'error';
  const head = '<div class="gate"><div class="logo">' + ic('account_balance_wallet', true) + '</div><h1>Dompetku</h1><p class="sub" style="max-width:300px">Catat arus kas pribadi &amp; keluarga lebih cepat, rapi, dan terencana.</p>';
  if (st === 'login') {
    g.innerHTML = head + '<div class="card" style="display:flex;flex-direction:column;align-items:center;gap:12px"><h2 class="t">Masuk dengan Google</h2><p class="sub" style="text-align:center">Gunakan akun Google yang didaftarkan oleh Pemilik Dompetku.</p><div id="gBtn" style="min-height:44px;display:flex;justify-content:center;width:100%"></div><p class="' + (d.message ? 'err' : 'sub') + '" id="gMsg" role="alert"' + (d.message ? '' : ' hidden') + '>' + esc(d.message || '') + '</p></div></div>';
    mountGoogleButton(); return;
  }
  const un = st === 'unregistered';
  g.innerHTML = head + '<div class="card"><div style="display:flex;gap:12px;align-items:flex-start"><span class="cat-ic" style="--c:#76574D">' + ic(un ? 'lock_person' : 'error', true) + '</span><div><h2 class="t">' + (un ? 'Akun belum terdaftar' : 'Terjadi kendala') + '</h2><p class="sub" style="margin-top:4px">' +
    (un ? 'Akun <span class="em">' + esc(d.email) + '</span> belum ada di daftar pengguna. Hubungi <b>Pemilik Dompetku</b> agar email ini ditambahkan, lalu ketuk Periksa lagi.' : esc(d.message || 'Coba lagi beberapa saat.')) + '</p></div></div>' +
    '<button class="btn primary block" type="button" id="gRetry" style="margin-top:16px">' + ic('refresh') + 'Periksa lagi</button>' +
    '<button class="btn block" type="button" id="gOut" style="margin-top:8px">' + ic('logout') + 'Ganti akun</button></div></div>';
  $('#gRetry').onclick = async () => {
    const b = $('#gRetry'); b.disabled = true; b.innerHTML = ic('sync') + 'Memeriksa…';
    try { await bootFresh(); } catch (e) { toast(e.message, 'err'); b.disabled = false; b.innerHTML = ic('refresh') + 'Periksa lagi'; }
  };
  $('#gOut').onclick = () => logout(false);
}
/* ambil data penuh dari server lalu mulai (dipakai setelah login / periksa lagi) */
async function bootFresh() {
  const r = await gs('ambilData', '');
  if (r.success === false) throw new Error(r.message || 'Gagal memuat data.');
  if (r.status === 'ok') start(r); else renderGate(r);
}

/* ============================================================
   EVENT (delegasi)
   ============================================================ */
function stepMonth(dir) {
  if (S.view === 'ringkasan' && S.rmode === 'tahun') { const y = +S.bulan.slice(0, 4) + dir; if (y > +NOW_M.slice(0, 4)) return; S.bulan = y + S.bulan.slice(4); if (S.bulan > NOW_M) S.bulan = NOW_M; }
  else { const n = mShift(S.bulan, dir); if (n > NOW_M) return; S.bulan = n; }
  renderView();
}
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-go],[data-act],[data-jenis],[data-mode],[data-fjenis],[data-add],[data-cat]');
  if (!el || el.closest('#scrim')) return;
  const d = el.dataset;
  if (d.go) { go(d.go); return; }
  if (d.mode) { S.rmode = d.mode; renderRingkasan(); return; }
  if (d.jenis && el.closest('#fjenis')) { S.f.jenis = d.jenis; S.f.limit = 25; renderRiwayat(); return; }
  if (d.fjenis) { if (S.form.jenis !== d.fjenis) { S.form.jenis = d.fjenis; S.form.kat = defaultCat(d.fjenis); renderForm(); } return; }
  if (d.add !== undefined && el.closest('.quick')) { const v = +d.add; S.form.nominal = v === 0 ? 0 : Math.min(9999999999999, (S.form.nominal || 0) + v); $('#fnom').value = S.form.nominal ? nf.format(S.form.nominal) : ''; $('#enom').textContent = ''; updateHint(); return; }
  if (d.cat !== undefined) { S.form.kat = d.cat; $$('.catpick button').forEach((b) => { const on = b.dataset.cat === d.cat; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); $('.ms', b).classList.toggle('fill', on); }); $('#ecat').textContent = ''; updateHint(); return; }
  switch (d.act) {
    case 'mprev': stepMonth(-1); break;
    case 'mnext': stepMonth(1); break;
    case 'back': S.form = null; go(S.prev === 'tambah' ? 'beranda' : S.prev); break;
    case 'rentang': S.f.rentang = !S.f.rentang; $('#rentang').hidden = !S.f.rentang; if (!S.f.rentang) { S.f.dari = S.f.sampai = ''; $('#fdari').value = $('#fsampai').value = ''; updateRiwayatList(); } break;
    case 'more': S.f.limit += 25; updateRiwayatList(); break;
    case 'xlsx': exportFile('xlsx', el); break;
    case 'pdf': exportFile('pdf', el); break;
    case 'edit': { const t = S.trx.filter((x) => x.id === d.id)[0]; if (t && canEdit(t)) { S.prev = S.view; openForm(t); go('tambah', { keepForm: true }); } break; }
    case 'del': { const t = S.trx.filter((x) => x.id === d.id)[0]; if (!t) break; if (await confirmBox('Hapus transaksi?', esc(t.kategori) + ' • <b>' + rp(t.nominal) + '</b> (' + esc(fmtTgl(t.tgl)) + ') akan dihapus.', 'Hapus', true)) { queueDel(t.id); toast('Transaksi dihapus.'); } break; }
    case 'tema': { const n = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', n); lsSet('dk_tema', n); renderPengaturan(); break; }
    case 'refresh': refresh(true); break;
    case 'kat-add': katModal(); break;
    case 'kat-edit': katModal(d.n); break;
    case 'kat-del': if (await confirmBox('Hapus kategori?', 'Kategori <b>' + esc(d.n) + '</b> akan dihapus. Hanya bisa jika belum dipakai transaksi.', 'Hapus', true)) { try { const r = await gs('hapusKategori', d.n); if (!r.success) throw new Error(r.message); S.kat = r.kategori; S.sv = ''; saveLocal(); renderAfterData(); toast('Kategori dihapus.'); } catch (err) { toast(err.message, 'err'); } } break;
    case 'mem-add': invModal(); break;
    case 'mem-del': if (await confirmBox('Hapus anggota?', '<b>' + esc(d.e) + '</b> tidak akan bisa mengakses Dompetku lagi. Transaksi miliknya tetap tersimpan.', 'Hapus', true)) { try { const r = await gs('hapusAnggota', d.e); if (!r.success) throw new Error(r.message); S.pengguna = r.pengguna; S.sv = ''; saveLocal(); renderAfterData(); toast('Anggota dihapus.'); } catch (err) { toast(err.message, 'err'); } } break;
    case 'migrasi': migModal(); break;
    case 'logout': if (await confirmBox('Keluar dari Dompetku?', 'Data di perangkat ini dibersihkan. Perubahan yang belum terkirim (' + S.queue.length + ') akan hilang.', 'Keluar', true)) logout(true); break;
  }
});
document.addEventListener('input', (e) => {
  const id = e.target.id;
  if (id === 'fnom') { const n = e.target.value.replace(/\D/g, '').slice(0, 13); S.form.nominal = n ? +n : 0; e.target.value = n ? nf.format(+n) : ''; $('#enom').textContent = ''; updateHint(); }
  else if (id === 'fq') { S.f.q = e.target.value; S.f.limit = 25; debouncedList(); }
  else if (id === 'fket') S.form.ket = e.target.value;
});
const debouncedList = debounce(() => updateRiwayatList(), 180);
document.addEventListener('change', (e) => {
  const id = e.target.id;
  if (id === 'fbulan') { S.f.bulan = e.target.value; S.f.limit = 25; updateRiwayatList(); }
  else if (id === 'fkat') { S.f.kat = e.target.value; S.f.limit = 25; updateRiwayatList(); }
  else if (id === 'fdari') { S.f.dari = e.target.value; S.f.limit = 25; updateRiwayatList(); }
  else if (id === 'fsampai') { S.f.sampai = e.target.value; S.f.limit = 25; updateRiwayatList(); }
  else if (id === 'ftgl') { S.form.tgl = e.target.value; updateHint(); }
});
$('#saveBtn').addEventListener('click', saveForm);
$('#sync').addEventListener('click', () => { if (S.queue.length) { flush(); toast('Mencoba menyinkronkan…'); } else refresh(true); });
window.addEventListener('online', () => { S.online = true; flush(); });
window.addEventListener('offline', () => { S.online = false; updateSync(); });
let pollT = 0, lastTouch = Date.now();
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { lastTouch = Date.now(); }, { passive: true }));
function stopPoll() { clearTimeout(pollT); pollT = 0; }
function schedulePoll() {
  stopPoll();
  const gap = Date.now() - lastTouch < 60000 ? 20000 : 60000;           // aktif 20 dtk, diam 60 dtk
  pollT = setTimeout(() => {
    if (S.token && S.user && !document.hidden && !S.inflight && !S.queue.length && S.view !== 'tambah' && !$('#scrim')) refresh();
    if (S.token && S.user) schedulePoll();
  }, gap);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.user && S.token) { if (Date.now() - S.lastSync > 15000 && !S.queue.length) refresh(); schedulePoll(); } else stopPoll(); });
window.addEventListener('error', () => { /* galat tak terduga tidak boleh memutus aplikasi */ });

/* ============================================================
   START
   ============================================================ */
function start(d) {
  $('#gate').hidden = true; $('#app').hidden = false;
  setData(d); S.queue = loadQueue(S.user.email); recompute();
  $('#meAv').textContent = ini(S.user.nama); $('#meAv').title = S.user.nama + ' (' + S.user.peran + ')';
  S.lastSync = Date.now(); go('beranda'); updateSync(); schedulePoll();
  if (S.queue.length) flush();
  // muat Chart.js di waktu senggang agar menu Ringkasan terasa instan
  (window.requestIdleCallback || ((f) => setTimeout(f, 1200)))(() => { loadScript(LIB.chart).catch(() => {}); });
}
/* Cache-first: bila ada sesi + data tersimpan, tampil seketika (0 RTT) lalu cek versi di latar. */
(function init() {
  if (/XXXX|ISI_/.test(GAS_URL) || !GAS_URL) { renderGate({ status: 'error', message: 'Aplikasi belum dikonfigurasi: isi GAS_URL dan GOOGLE_CLIENT_ID di js/config.js.' }); return; }
  const tk = loadToken(); let cached = null;
  try { cached = JSON.parse(lsGet('dk_data') || 'null'); } catch (e) { /* abaikan */ }
  if (!tk) { renderGate({ status: 'login' }); return; }
  S.token = tk.token;
  if (cached && cached.user && cached.user.email === tk.email) {
    start({ user: cached.user, kategori: cached.kat, pengguna: cached.pengguna, transaksi: cached.srv, dbUrl: cached.dbUrl, v: cached.v });
    refresh();
  } else {
    $('#gate').hidden = false; $('#gate').innerHTML = '<div class="gate"><div class="logo">' + ic('account_balance_wallet', true) + '</div><p class="sub">Memuat data…</p></div>';
    bootFresh().catch((e) => { if (!e.auth) renderGate({ status: 'error', message: e.message }); });
  }
})();
})();