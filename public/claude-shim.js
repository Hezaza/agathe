/* AGATHE : couche d'accès aux données.
   Fournit à l'application l'interface « claude.use(...) » (base de données collection/document,
   stockage de fichiers, téléchargements) au-dessus de Supabase (PostgreSQL + Storage + Realtime). */
(function () {
  'use strict';
  var C = window.AGATHE_CONFIG;
  if (!C || !C.url || !C.anon || !window.supabase) {
    window.AGATHE_ERROR = 'Configuration Supabase manquante (config.js)';
    window.claude = { use: function () { return Promise.resolve(null); } };
    return;
  }
  var sb = window.supabase.createClient(C.url, C.anon, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  window.AGATHE = { sb: sb };
  var BUCKET = 'agathe-files';

  function perr(e) {
    var m = (e && (e.message || e.code)) || String(e);
    var denied = (e && (e.code === '42501' || e.status === 401 || e.status === 403)) || /row-level security|permission|JWT|not authorized|Unauthorized/i.test(m);
    return { code: denied ? 'permission_denied' : ((e && e.code) || 'error'), message: m };
  }
  function segs(p) { return String(p).split('/').filter(Boolean); }
  function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function snapDoc(id, data) { return { exists: data !== null && data !== undefined, id: id, data: function () { return clone(data === null ? undefined : data); } }; }
  var seq = 0;

  function channel(table, filter, fn) {
    var opts = { event: '*', schema: 'public', table: table };
    if (filter) opts.filter = filter;
    var ch = sb.channel('agathe-' + (++seq) + '-' + Math.random().toString(36).slice(2, 7));
    var st = { ok: false };
    ch.on('postgres_changes', opts, fn).subscribe(function (s) { st.ok = (s === 'SUBSCRIBED'); });
    return { stop: function () { try { sb.removeChannel(ch); } catch (e) {} }, st: st };
  }

  function watch(table, filter, load, cb, errcb) {
    var alive = true, timer = null, poll = null, ch = null;
    function run() {
      if (!alive) return;
      load().then(function (v) { if (alive) cb(v); }).catch(function (e) { if (alive && errcb) errcb(perr(e)); });
    }
    function bump() { clearTimeout(timer); timer = setTimeout(run, 150); }
    run();
    try { ch = channel(table, filter, bump); } catch (e) {}
    // secours : si le canal temps réel n'est pas actif, on relit périodiquement
    poll = setInterval(function () { if (!ch || !ch.st.ok) run(); }, 20000);
    return function () { alive = false; clearTimeout(timer); clearInterval(poll); if (ch) ch.stop(); };
  }

  function docRef(path) {
    var s = segs(path), id = s[s.length - 1], parent = s.slice(0, -1).join('/');
    if (s.length % 2 !== 0 || s.length < 2) throw new Error('Chemin de document invalide : ' + path);
    var isProf = parent === 'profiles';
    async function read() {
      if (isProf) {
        var r1 = await sb.from('profiles').select('*').eq('id', id).maybeSingle();
        if (r1.error) throw r1.error; return r1.data;
      }
      var r = await sb.from('docs').select('data').eq('parent', parent).eq('id', id).maybeSingle();
      if (r.error) throw r.error; return r.data ? r.data.data : null;
    }
    return {
      id: id,
      get: async function () { try { return snapDoc(id, await read()); } catch (e) { throw perr(e); } },
      set: async function (d) {
        if (isProf) throw perr({ code: '42501', message: 'profil : écriture réservée au serveur' });
        var r = await sb.from('docs').upsert({ parent: parent, id: id, data: clone(d), updated_at: new Date().toISOString() });
        if (r.error) throw perr(r.error);
      },
      update: async function (d) {
        if (isProf) throw perr({ code: '42501', message: 'profil : écriture réservée au serveur' });
        var cur = null; try { cur = await read(); } catch (e) {}
        var merged = Object.assign({}, cur || {}, clone(d));
        var r = await sb.from('docs').upsert({ parent: parent, id: id, data: merged, updated_at: new Date().toISOString() });
        if (r.error) throw perr(r.error);
      },
      delete: async function () {
        if (isProf) throw perr({ code: '42501', message: 'profil : suppression réservée au serveur' });
        var r = await sb.from('docs').delete().eq('parent', parent).eq('id', id).select('id');
        if (r.error) throw perr(r.error);
        if (!r.data || !r.data.length) {
          var still = null; try { still = await read(); } catch (e) {}
          if (still) throw perr({ code: '42501', message: 'suppression refusée (droits insuffisants)' });
        }
      },
      onSnapshot: function (cb, errcb) {
        return watch(isProf ? 'profiles' : 'docs', isProf ? 'id=eq.' + id : 'parent=eq.' + parent,
          async function () { return snapDoc(id, await read()); }, cb, errcb);
      }
    };
  }

  // Collection suivie en direct : on garde une copie locale et on ne recharge que le document modifié.
  function liveColl(p, cb, errcb) {
    var alive = true, map = null, timer = null, poll = null, ch = null, st = { ok: false };
    function emit() {
      if (!alive || !map) return;
      var docs = Object.keys(map).sort().map(function (id) { var d = map[id]; return { id: id, data: function () { return clone(d); } }; });
      cb({ docs: docs });
    }
    function later() { clearTimeout(timer); timer = setTimeout(emit, 120); }
    async function full() {
      try {
        var r = await sb.from('docs').select('id,data').eq('parent', p).range(0, 4999);
        if (r.error) throw r.error;
        var m = {}; r.data.forEach(function (x) { m[x.id] = x.data; }); map = m; emit();
      } catch (e) { if (alive && errcb) errcb(perr(e)); }
    }
    async function one(id) {
      try {
        var r = await sb.from('docs').select('data').eq('parent', p).eq('id', id).maybeSingle();
        if (r.error) throw r.error;
        if (!map) return;
        if (r.data) map[id] = r.data.data; else delete map[id];
        later();
      } catch (e) { full(); }
    }
    function onEvent(pl) {
      if (!alive) return;
      var ev = pl && pl.eventType, n = (pl && pl.new) || {}, o = (pl && pl.old) || {};
      if (!ev || !map) return full();
      if (ev === 'DELETE') { if (o.parent !== p || !o.id) return; delete map[o.id]; return later(); }
      if (n.parent !== p || !n.id) return;
      if (n.data !== undefined && !(pl.errors && pl.errors.length)) { map[n.id] = n.data; later(); }
      else one(n.id);
    }
    full();
    try {
      ch = sb.channel('agathe-' + (++seq) + '-' + Math.random().toString(36).slice(2, 7));
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'parent=eq.' + p }, onEvent)
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'docs' }, onEvent)
        .subscribe(function (s) { var was = st.ok; st.ok = (s === 'SUBSCRIBED'); if (st.ok && !was && map) full(); });
    } catch (e) {}
    poll = setInterval(function () { if (!st.ok) full(); }, 20000);
    return function () { alive = false; clearTimeout(timer); clearInterval(poll); try { if (ch) sb.removeChannel(ch); } catch (e) {} };
  }

  function collRef(path) {
    var p = segs(path).join('/'), isProf = p === 'profiles', ord = null, lim = null;
    var q = {
      doc: function (id) { return docRef(p + '/' + id); },
      orderBy: function (f, dir) { ord = { f: f, asc: String(dir || 'asc').toLowerCase() !== 'desc' }; return q; },
      limit: function (n) { lim = n; return q; },
      where: function () { return q; },
      get: async function () { try { return await load(); } catch (e) { throw perr(e); } },
      onSnapshot: function (cb, errcb) {
        if (isProf || ord || lim) return watch(isProf ? 'profiles' : 'docs', isProf ? null : 'parent=eq.' + p, load, cb, errcb);
        return liveColl(p, cb, errcb);
      }
    };
    async function load() {
      var r;
      if (isProf) {
        r = await sb.from('profiles').select('*');
        if (r.error) throw r.error;
        return { docs: r.data.map(function (x) { return { id: x.id, data: function () { return clone(x); } }; }) };
      }
      var qq = sb.from('docs').select('id,data').eq('parent', p);
      if (ord) qq = qq.order('data->>' + ord.f, { ascending: ord.asc });
      if (lim) qq = qq.limit(lim); else qq = qq.range(0, 4999);
      r = await qq;
      if (r.error) throw r.error;
      return { docs: r.data.map(function (x) { return { id: x.id, data: function () { return clone(x.data); } }; }) };
    }
    return q;
  }

  var dbApi = { doc: docRef, collection: collRef };

  var assetsApi = {
    upload: async function (blob, opt) {
      var id = 'a' + crypto.randomUUID().replace(/-/g, '');
      var r = await sb.storage.from(BUCKET).upload(id, blob, { contentType: (opt && opt.type) || blob.type || 'application/octet-stream', upsert: false });
      if (r.error) throw perr(r.error);
      return { id: id, url: '/_blob/' + id, sizeBytes: blob.size, contentType: blob.type };
    },
    delete: async function (id) {
      var r = await sb.storage.from(BUCKET).remove([id]);
      if (r.error) throw perr(r.error);
    },
    list: async function () { return { assets: [], usage: {} }; }
  };

  var dlApi = {
    save: async function (o) {
      var data = o.data, blob = data instanceof Blob ? data : new Blob([data]);
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = o.filename || 'fichier';
      document.body.appendChild(a); a.click();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 5000);
    }
  };

  var userApi = { id: async function () { return ''; }, isOwner: function () { return false; }, canEdit: function () { return false; }, can: function () { return null; }, me: function () { return {}; } };

  // les fichiers sont servis sous /_blob/<id> : on les lit dans Supabase Storage avec la session de l'utilisateur
  var _fetch = window.fetch.bind(window);
  window.fetch = function (u, o) {
    var s = typeof u === 'string' ? u : (u && u.url) || '';
    var m = /(?:^|\/)_blob\/([A-Za-z0-9_-]+)/.exec(s.replace(location.origin, ''));
    if (m) {
      return sb.storage.from(BUCKET).download(m[1]).then(function (r) {
        if (r.error || !r.data) return new Response('', { status: 404 });
        return new Response(r.data, { status: 200 });
      });
    }
    return _fetch(u, o);
  };

  window.claude = {
    use: function (name) {
      var m = { db: dbApi, assets: assetsApi, downloads: dlApi, user: userApi };
      return Promise.resolve(m[name] || null);
    }
  };
})();
